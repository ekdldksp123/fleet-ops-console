/**
 * README 용 스크린샷 캡처.
 *
 * 관제 화면은 정지 이미지로도 "무엇을 보여주는 화면인지" 가 전달돼야 한다. 그래서
 * 캡처 전에 몇 초 흘려보낸다 — 경보 레일이 채워지고, 경로 궤적이 그려지고, 계측
 * 오버레이의 FPS 가 초기 0 이 아닌 값이 될 시간이다.
 *
 *   yarn build && node scripts/screenshot.mjs
 */
import { chromium } from '@playwright/test'

import { bringToFront, ORIGIN, killServer, sleep, startServer, waitUp } from './lib-harness.mjs'

const FLEET_SIZE = Number(process.env.FLEET_SIZE ?? 2000)
const VIEWPORT = { width: 1800, height: 1120 }
const SETTLE_MS = 12_000

killServer()
const srv = startServer({ fleetSize: FLEET_SIZE })
if (!(await waitUp())) {
  console.log('서버 기동 실패')
  process.exit(1)
}

/**
 * 헤드풀로 띄우고 창을 앞으로 가져온다. 계측 오버레이가 화면에 같이 찍히기 때문에
 * 헤드리스로 찍으면 **이미지에 거짓 FPS 가 박힌다** — 헤드리스의 rAF 억제 탓에
 * 60 FPS 가 나올 상황에서도 10 FPS 로 찍힌다(lib-harness.mjs 주석 참고).
 */
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--window-position=0,0'],
})
const ctx = await browser.newContext({
  viewport: VIEWPORT,
  // deviceScaleFactor 를 올리면 캔버스 픽셀이 배수로 늘어 계측 오버레이의 FPS 가
  // 실제 사용 조건보다 나쁘게 찍힌다. 히어로 이미지에 거짓 수치를 박아 넣지 않으려고
  // 1 로 두고, 대신 뷰포트를 키워 해상도를 확보한다.
  deviceScaleFactor: 1,
  colorScheme: 'dark',
  reducedMotion: 'reduce',
})

async function shot(url, file, prepare) {
  const page = await ctx.newPage()
  await bringToFront(page)
  await page.goto(`${ORIGIN}${url}`, { waitUntil: 'domcontentloaded' })
  await page.getByText(/(SSE|이진) 수신 중/).waitFor({ timeout: 60_000 })
  await prepare?.(page)
  await bringToFront(page)
  // 경보가 쌓이고 궤적이 그려질 시간을 준다.
  await sleep(SETTLE_MS)
  await page.screenshot({ path: file, animations: 'disabled' })
  // 이미지에 박히는 수치를 로그로도 남긴다 — 나중에 README 본문과 대조할 수 있게.
  const fps = await page.locator('text=FPS').first().locator('..').locator('span').last().textContent()
  console.log(`${file}  ←  ${url}   (오버레이 FPS ${fps?.trim()})`)
  await page.close()
}

// 1) 히어로 — 기본 관제 화면 전체
await shot('/fleet', 'docs/screenshot.png')

// 2) 상세 라우트 — 중첩 레이아웃으로 지도를 살려둔 채 패널만 바뀐 상태
await shot('/fleet/RB-00042', 'docs/screenshot-detail.png', async (page) => {
  await page.getByRole('complementary', { name: '로봇 상세' }).waitFor({ timeout: 20_000 })
})

await browser.close()
try {
  process.kill(-srv.pid)
} catch {}
killServer()
