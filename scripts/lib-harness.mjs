/**
 * 벤치마크·스크린샷 하네스가 공유하는 서버 기동/종료 헬퍼.
 *
 * 측정용 서버를 3210 번 포트에 띄운다. 개발 중인 3000 번 dev 서버와 겹치지 않게
 * 일부러 다른 포트를 쓴다 — 측정 도중에 dev 서버를 죽이면 곤란하다.
 */
import { spawn, execSync } from 'node:child_process'

export const PORT = Number(process.env.BENCH_PORT ?? 3210)
export const ORIGIN = `http://localhost:${PORT}`

export function startServer({ fleetSize, tickMs, dev = false }) {
  return spawn('yarn', [dev ? 'dev' : 'start'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      FLEET_SIZE: String(fleetSize),
      ...(tickMs ? { FLEET_TICK_MS: String(tickMs) } : {}),
    },
    stdio: 'ignore',
    detached: true,
  })
}

export function killServer() {
  try {
    execSync(`pkill -f 'next (start|dev).*${PORT}' || pkill -f 'next-server.*${PORT}'`)
  } catch {}
  try {
    execSync(`lsof -ti tcp:${PORT} | xargs kill -9`, { stdio: 'ignore' })
  } catch {}
}

export async function waitUp(timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try {
      const r = await fetch(`${ORIGIN}/fleet`)
      if (r.ok) return true
    } catch {}
    await sleep(500)
  }
  return false
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 측정용 창을 화면 맨 앞으로 가져온다.
 *
 * 이게 없으면 FPS 를 아예 못 잰다. Chrome 은 **보이지 않는 창의 rAF 를 억제한다** —
 * 헤드리스는 물론이고, 헤드풀이라도 다른 창에 가려지면(macOS window occlusion)
 * BeginFrame 생성이 뚝 떨어진다. 같은 페이지·같은 부하에서 실측한 값:
 *
 *   헤드리스            10.5 FPS   (최장 프레임 120ms)
 *   헤드풀, 가려짐      14.2 FPS   (최장 프레임 122ms)
 *   헤드풀, 맨 앞       60.1 FPS   (최장 프레임  29ms)
 *
 * 10.5 는 앱의 성능이 아니라 창이 안 보인다는 사실을 재고 있는 값이다. 서버 tick 을
 * 100ms → 16ms 로 올려도 그대로였으므로 데이터 주기 탓도 아니다.
 */
export async function bringToFront(page) {
  await page.bringToFront()
  try {
    execSync(`osascript -e 'tell application "Google Chrome" to activate'`, { stdio: 'ignore' })
  } catch {}
  await sleep(600)
}

/** WebGL 이 하드웨어 가속인지 확인한다. SwiftShader 면 렌더 경로 비교가 무의미하다. */
export async function webglRenderer(page) {
  return page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) return 'WebGL 없음'
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER))
  })
}
