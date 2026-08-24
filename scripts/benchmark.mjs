/**
 * FPS 측정 하네스 — README "벤치마크" 절의 표를 채우는 데 쓴다.
 *
 * 사람이 화면을 30초 쳐다보며 오버레이 숫자를 읽는 절차를 그대로 자동화한 것이다.
 * 측정값은 오버레이가 아니라 페이지 안에 직접 심은 rAF 루프에서 읽는다. 오버레이는
 * 500ms 창의 표본을 보여주는 UI 라서 "20초 동안의 평균" 을 정확히 뽑기 어렵다.
 * 재는 대상은 같다 — rAF 호출 간격, 즉 브라우저가 실제로 화면을 그린 시점이다.
 *
 *   node scripts/benchmark.mjs --repeat 3                        # 기본: 렌더 경로 표
 *   node scripts/benchmark.mjs --sizes 20000 --modes canvas --dev --allow-slow
 *   node scripts/benchmark.mjs --seconds 30 --zoom in
 *
 * `--repeat N` 을 쓰면 조건마다 N 회 재고 **중앙값**을 표에 쓴다. 최저 FPS 는 1회
 * 측정으로는 못 믿는다 — 같은 조건에서 6.0 과 56.5 가 나온 적이 있다. 평균 FPS 는
 * 1회로도 안정적이지만, 최저·최장은 반복이 필요하다.
 *
 * ⚠️ 브라우저 창을 화면 맨 앞에 **보이는 상태로** 둬야 한다. 스크립트가 창을 띄우고
 * 앞으로 가져오지만, 측정 중에 다른 창으로 덮으면 Chrome 이 rAF 를 억제해 값이 무너진다
 * (근거는 lib-harness.mjs 의 `bringToFront` 주석). `--headless` 는 이 사실을 확인하는
 * 용도로만 두었다 — 그 모드의 FPS 는 앱 성능이 아니다.
 *
 * ⚠️ WebGL 이 소프트웨어 렌더링(SwiftShader)으로 떨어지면 Canvas 보다 느리게 나온다.
 * 스크립트가 시작할 때 실제 렌더러 문자열을 찍으므로 반드시 확인하고 표에 남길 것.
 */
import { chromium } from '@playwright/test'

import {
  bringToFront,
  ORIGIN,
  killServer,
  sleep,
  startServer,
  waitUp,
  webglRenderer,
} from './lib-harness.mjs'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(`--${name}`)

const SIZES = flag('sizes', '500,1000,2000,5000').split(',').map(Number)
const MODES = flag('modes', 'canvas,webgl').split(',')
const SECONDS = Number(flag('seconds', 20))
const WARMUP = Number(flag('warmup', 8))
const ZOOM = flag('zoom', 'out') // out = 초기 뷰(전체), in = 더블클릭 2회로 확대
const REPEAT = Number(flag('repeat', 1))
// 최적화 전 커밋(0단계)은 20,000대에서 20 FPS 대가 정상이다. 그 경우 아래 서명
// 판정이 진짜 데이터를 버리므로, 옛 커밋을 잴 때는 --allow-slow 를 준다.
const ALLOW_SLOW = has('allow-slow')
const FEED = flag('feed', 'binary')
const TICK = flag('tick', '')
const DEV = has('dev')
const VIEWPORT = { width: 1400, height: 900 }

const FEED_LABEL = { main: '메인 파싱', worker: '워커 파싱', binary: '이진' }

/**
 * 페이지 안에서 rAF 간격을 SECONDS 초 동안 모아 평균·최저 FPS·최장 프레임을 낸다.
 * 최저 FPS 는 최장 프레임의 역수다 — 오버레이와 같은 정의를 쓴다.
 */
function measure(page, seconds) {
  return page.evaluate(
    (secs) =>
      new Promise((resolve) => {
        const gaps = []
        let prev = performance.now()
        const start = prev
        // 측정 도중 창이 앞에서 밀려나면 rAF 가 억제되어 값이 무너진다. 그걸
        // 나중에 숫자만 보고 추측하지 않도록, 재는 동안 포커스를 같이 기록한다.
        let focusLost = !document.hasFocus()
        const loop = (now) => {
          gaps.push(now - prev)
          prev = now
          if (!document.hasFocus()) focusLost = true
          if (now - start >= secs * 1000) {
            const total = now - start
            const worst = Math.max(...gaps)
            resolve({
              fps: (gaps.length * 1000) / total,
              minFps: 1000 / worst,
              worstMs: worst,
              frames: gaps.length,
              focusLost,
            })
            return
          }
          requestAnimationFrame(loop)
        }
        requestAnimationFrame(loop)
      }),
    seconds,
  )
}

/**
 * 창이 가려진 상태에서 나온 값인지 판정한다.
 *
 * 두 신호를 쓴다. (1) 측정 중 `document.hasFocus()` 가 false 였는가 — 원인 쪽 신호다.
 * (2) 결과가 억제된 rAF 의 서명과 일치하는가 — 평균 30 FPS 미만 + 최장 프레임 80ms
 * 초과. 이 서명은 실측으로 확인한 것이다(가려진 창: 10~14 FPS / 120ms 대). 부하 때문에
 * 느린 경우와 겹칠 수 있다 — 최적화 전 커밋은 20,000대에서 20 FPS 대가 정상이다.
 * 그래서 옛 커밋을 잴 때는 `--allow-slow` 로 (2)를 끄고 (1)만 쓴다. (1)은 원인을
 * 직접 보는 신호라 부하와 무관하다.
 */
const looksThrottled = (r) => r.focusLost || (!ALLOW_SLOW && r.fps < 30 && r.worstMs > 80)

let feedNote = null

async function run(browser, size, mode) {
  const page = await browser.newPage({ viewport: VIEWPORT })
  await bringToFront(page)
  await page.goto(`${ORIGIN}/fleet`, { waitUntil: 'domcontentloaded' })
  await page.getByText(/(SSE|이진) 수신 중/).waitFor({ timeout: 60_000 })

  // 수신 경로를 명시적으로 고정한다. 기본값이 바뀌면 조용히 다른 조건을 재게 된다.
  //
  // 단계별 커밋을 체크아웃해 재는 경우 이 토글 자체가 없다(5단계에서 들어왔다).
  // 없으면 그냥 넘어간다 — 그 시점의 수신 경로는 SSE·메인 하나뿐이다.
  const feed = page.getByRole('radio', { name: FEED_LABEL[FEED] })
  if ((await feed.count()) === 0) {
    feedNote = '수신 경로 토글 없음(SSE·메인)'
  } else if ((await feed.getAttribute('aria-checked')) !== 'true') {
    await feed.click()
    await page.getByText(/(SSE|이진) 수신 중/).waitFor({ timeout: 60_000 })
  }

  const renderRadio = page.getByRole('radio', { name: mode === 'canvas' ? 'Canvas' : 'WebGL' })
  await renderRadio.click()
  await page.waitForFunction(
    (el) => el?.getAttribute('aria-checked') === 'true',
    await renderRadio.elementHandle(),
    { timeout: 10_000 },
  )
  await page.waitForFunction(
    (m) => document.body.innerText.includes(m),
    mode === 'canvas' ? 'Canvas 2D' : 'WebGL',
    { timeout: 15_000 },
  )

  const map = page.getByRole('application', { name: '플릿 관제 지도' })
  if (ZOOM === 'in') {
    // 줌 애니메이션 스터터가 측정에 섞이지 않도록 워밍업 전에 끝내 둔다.
    for (let i = 0; i < 2; i++) {
      await map.dblclick({ position: { x: VIEWPORT.width / 3, y: VIEWPORT.height / 2 } })
      await sleep(1200)
    }
  }

  // 워밍업 직전에 한 번 더 앞으로 가져온다. 앞선 조건의 창이 닫히면서 포커스가
  // 엉뚱한 데로 갈 수 있다.
  await bringToFront(page)
  await sleep(WARMUP * 1000)
  const r = await measure(page, SECONDS)

  // 삼킴·페이로드 행은 5~6단계에서 추가됐다. 없는 커밋에서 기본 타임아웃(30초)을
  // 그대로 먹으면 측정 한 번에 1분이 날아간다.
  const overlay = async (label) =>
    (
      await page
        .locator(`text=${label}`)
        .locator('..')
        .locator('span')
        .last()
        .textContent({ timeout: 2000 })
    )?.trim()
  const ingest = await overlay('삼킴\\(메인\\)').catch(() => null)
  const payload = await overlay('페이로드').catch(() => null)

  await page.close()
  return { size, mode, ...r, ingest, payload }
}

/** 짝수 개면 가운데 두 값의 평균. 반복 측정의 대표값으로 평균 대신 중앙값을 쓴다 —
 * 한 번의 큰 스터터가 대표값을 끌고 가지 않게. */
function median(xs) {
  const a = [...xs].sort((x, y) => x - y)
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

const results = []
let totalDiscarded = 0
let browser
try {
  const headless = has('headless')
  browser = await chromium.launch({
    channel: 'chrome',
    headless,
    args: ['--window-position=0,0'],
  })

  const probe = await browser.newPage()
  await probe.goto('about:blank')
  const renderer = await webglRenderer(probe)
  await probe.close()

  console.log(
    `측정 환경: ${DEV ? 'dev' : 'prod'} 빌드 · ${VIEWPORT.width}×${VIEWPORT.height} · ` +
      `${headless ? '헤드리스 (⚠️ FPS 무의미)' : '헤드풀·맨 앞'}`,
  )
  console.log(`수신 경로: ${FEED_LABEL[FEED]} · 줌: ${ZOOM} · 워밍업 ${WARMUP}s → 측정 ${SECONDS}s`)
  console.log(`WebGL 렌더러: ${renderer}`)
  if (/SwiftShader|Software/i.test(renderer)) {
    console.log('⚠️  소프트웨어 렌더링이다. 렌더 경로 비교는 무의미하다 — 중단할 것.')
  }
  console.log('')

  for (const size of SIZES) {
    killServer()
    const srv = startServer({ fleetSize: size, tickMs: TICK, dev: DEV })
    if (!(await waitUp())) {
      console.log(`FLEET_SIZE=${size}: 서버 기동 실패`)
      continue
    }
    for (const mode of MODES) {
      const runs = []
      let discarded = 0
      while (runs.length < REPEAT && discarded < REPEAT * 2 + 2) {
        const r = await run(browser, size, mode)
        const bad = looksThrottled(r)
        const tag = REPEAT > 1 ? ` (${runs.length + (bad ? 0 : 1)}/${REPEAT})` : ''
        console.log(
          `FLEET_SIZE=${String(size).padStart(6)} ${mode.padEnd(6)}${tag}  ` +
            `평균 ${r.fps.toFixed(1).padStart(5)} FPS  최저 ${r.minFps.toFixed(1).padStart(5)}  ` +
            `최장 ${r.worstMs.toFixed(1).padStart(6)}ms  삼킴 ${r.ingest ?? '—'}  ${r.payload ?? '—'}` +
            (bad ? `  ← 버림 (${r.focusLost ? '측정 중 포커스 상실' : 'rAF 억제 서명'})` : ''),
        )
        if (bad) {
          discarded++
          continue
        }
        runs.push(r)
      }
      if (runs.length < REPEAT) {
        console.log(
          `  └ ⚠️ 유효 측정 ${runs.length}/${REPEAT} 회 — 창이 계속 가려졌다. 값을 믿지 말 것.`,
        )
      }
      if (runs.length === 0) continue
      totalDiscarded += discarded
      const agg = {
        size,
        mode,
        fps: median(runs.map((r) => r.fps)),
        minFps: median(runs.map((r) => r.minFps)),
        worstMs: median(runs.map((r) => r.worstMs)),
        minFpsRange: [Math.min(...runs.map((r) => r.minFps)), Math.max(...runs.map((r) => r.minFps))],
        n: runs.length,
        discarded,
        ingest: runs[runs.length - 1].ingest,
        payload: runs[runs.length - 1].payload,
      }
      results.push(agg)
      if (REPEAT > 1) {
        console.log(
          `  └ 중앙값 ${agg.fps.toFixed(1)} FPS · 최저 ${agg.minFps.toFixed(1)} ` +
            `(범위 ${agg.minFpsRange[0].toFixed(1)}~${agg.minFpsRange[1].toFixed(1)}) · ` +
            `최장 ${agg.worstMs.toFixed(1)}ms`,
        )
      }
    }
    try {
      process.kill(-srv.pid)
    } catch {}
    killServer()
  }
} finally {
  await browser?.close()
  killServer()
}

// README 에 그대로 붙일 수 있는 형태로 출력한다.
if (feedNote) console.log(`\n비고: ${feedNote}`)
if (totalDiscarded) {
  console.log(
    `비고: 창이 가려진 상태로 판정해 버린 측정 ${totalDiscarded}회 (재측정으로 대체했다)`,
  )
}

if (MODES.length === 2 && MODES[0] === 'canvas') {
  const r1 = (x) => x.toFixed(1)
  console.log(
    '\n| 로봇 대수 | Canvas 평균 | Canvas 최저 (범위) | Canvas 최장 | WebGL 평균 | WebGL 최저 (범위) | WebGL 최장 |',
  )
  console.log('| --- | --- | --- | --- | --- | --- | --- |')
  for (const size of SIZES) {
    const c = results.find((r) => r.size === size && r.mode === 'canvas')
    const w = results.find((r) => r.size === size && r.mode === 'webgl')
    if (!c || !w) continue
    const rng = (x) =>
      x.n > 1 ? `${r1(x.minFps)} (${r1(x.minFpsRange[0])}~${r1(x.minFpsRange[1])})` : r1(x.minFps)
    console.log(
      `| ${size.toLocaleString()} | ${r1(c.fps)} | ${rng(c)} | ${r1(c.worstMs)}ms | ` +
        `${r1(w.fps)} | ${rng(w)} | ${r1(w.worstMs)}ms |`,
    )
  }
} else {
  console.log('\n| 조건 | 평균 FPS | 최저 FPS | 최장 프레임 |')
  console.log('| --- | --- | --- | --- |')
  for (const r of results) {
    console.log(
      `| ${r.size.toLocaleString()} · ${r.mode} | ${r.fps.toFixed(1)} | ${r.minFps.toFixed(1)} | ${r.worstMs.toFixed(1)}ms |`,
    )
  }
}
