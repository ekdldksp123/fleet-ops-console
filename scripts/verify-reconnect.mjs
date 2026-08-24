/**
 * 재연결 검증 하네스 — 서버를 실제로 죽였다 살려서 스트림이 다시 붙는지 본다.
 *
 * 이 스크립트가 존재하는 이유는 README "재연결 검증 — 하네스가 먼저 문제였다" 에
 * 적어 두었다. 요약하면 `context.setOffline(true)` 와 `page.route` 로는 **이미
 * 성립된 스트림을 끊을 수 없어서** 재연결을 검증할 수 없다. 그래서 프로세스를 죽인다.
 *
 * e2e/fleet.spec.ts 의 `?frames=N` 테스트가 서버가 스트림을 닫는 경우를 덮고,
 * 이 스크립트는 그보다 거친 경우 — 서버 프로세스 자체가 사라지는 경우 — 를 덮는다.
 * CI 에 넣기엔 거칠어서(pkill·8초 대기) 수동 실행용으로 남겨 둔다.
 *
 *   yarn build && node scripts/verify-reconnect.mjs
 */
import { chromium } from '@playwright/test'

import { ORIGIN, killServer, sleep, startServer, waitUp } from './lib-harness.mjs'

const FLEET_SIZE = Number(process.env.FLEET_SIZE ?? 1200)

killServer()
let srv = startServer({ fleetSize: FLEET_SIZE })
if (!(await waitUp())) {
  console.log('서버 시작 실패')
  process.exit(1)
}

const b = await chromium.launch({ channel: 'chrome', headless: true })
const p = await b.newPage({ viewport: { width: 1400, height: 900 } })
const warns = []
p.on('console', (m) => {
  if (/BinaryFeed|끊김|재연결/.test(m.text())) warns.push(m.text())
})

await p.goto(`${ORIGIN}/fleet`, { waitUntil: 'domcontentloaded' })
await p.getByText(/(SSE|이진) 수신 중/).waitFor({ timeout: 30_000 })
await p.getByRole('radio', { name: '이진' }).click()
await p.getByText(/이진 수신 중/).waitFor({ timeout: 30_000 })
await sleep(2500)

const status = async () =>
  (
    await p
      .locator('text=/(SSE|이진) (수신 중|재연결 중|끊김|연결 중|대기)/')
      .first()
      .textContent()
  )?.trim()
const seq = async () =>
  Number(await p.locator('text=프레임 seq').locator('..').locator('span').last().textContent())

console.log(`서버 살아있음 : ${await status()}  seq=${await seq()}`)
const before = await seq()

killServer()
await sleep(5000)
console.log(`서버 죽인 뒤 5s: ${await status()}  seq=${await seq()}`)
const stalled = await seq()

console.log('서버 재시작…')
srv = startServer({ fleetSize: FLEET_SIZE })
if (!(await waitUp())) {
  console.log('재시작 실패')
  await b.close()
  process.exit(1)
}
await sleep(8000)

const after = await seq()
console.log(`재시작 후 8s  : ${await status()}  seq=${after}`)
console.log(`\n중단 중 정지 : ${stalled === before ? '✓ seq 멈춤 확인' : `△ seq ${before}→${stalled}`}`)
console.log(`복구 여부    : ${after > stalled ? '✓ 재연결됨' : '✗ 복구 실패'}`)
console.log(`콘솔 경고    : ${warns.length}건 ${warns.slice(0, 2).join(' | ')}`)

await b.close()
try {
  process.kill(-srv.pid)
} catch {}
killServer()
