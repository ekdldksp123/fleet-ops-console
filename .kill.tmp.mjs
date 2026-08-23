import { chromium } from '@playwright/test'
import { spawn, execSync } from 'node:child_process'

const startServer = () => spawn('yarn', ['start'], {
  env: { ...process.env, FLEET_SIZE: '1200' }, stdio: 'ignore', detached: true,
})
const waitUp = async () => {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch('http://localhost:3000/fleet'); if (r.ok) return true } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}
const killServer = () => { try { execSync("pkill -f 'next start'") } catch {} }

let srv = startServer()
if (!(await waitUp())) { console.log('서버 시작 실패'); process.exit(1) }

const b = await chromium.launch({ channel: 'chrome', headless: true })
const p = await b.newPage({ viewport: { width: 1400, height: 900 } })
const warns = []
p.on('console', (m) => { if (/BinaryFeed|끊김|재연결/.test(m.text())) warns.push(m.text()) })

await p.goto('http://localhost:3000/fleet', { waitUntil: 'domcontentloaded' })
await p.getByText(/(SSE|이진) 수신 중/).waitFor({ timeout: 30000 })
await p.getByRole('radio', { name: '이진' }).click()
await p.getByText(/이진 수신 중/).waitFor({ timeout: 30000 })
await p.waitForTimeout(2500)

const status = async () => (await p.locator('text=/(SSE|이진) (수신 중|재연결 중|끊김|연결 중|대기)/').first().textContent())?.trim()
const seq = async () => Number(await p.locator('text=프레임 seq').locator('..').locator('span').last().textContent())

console.log(`서버 살아있음 : ${await status()}  seq=${await seq()}`)
const before = await seq()

killServer()
await new Promise((r) => setTimeout(r, 5000))
console.log(`서버 죽인 뒤 5s: ${await status()}  seq=${await seq()}`)
const stalled = await seq()

console.log('서버 재시작…')
srv = startServer()
if (!(await waitUp())) { console.log('재시작 실패'); await b.close(); process.exit(1) }
await new Promise((r) => setTimeout(r, 8000))

const after = await seq()
console.log(`재시작 후 8s  : ${await status()}  seq=${after}`)
console.log(`\n중단 중 정지 : ${stalled === before ? '✓ seq 멈춤 확인' : `△ seq ${before}→${stalled}`}`)
console.log(`복구 여부    : ${after > stalled ? '✓ 재연결됨' : '✗ 복구 실패'}`)
console.log(`콘솔 경고    : ${warns.length}건 ${warns.slice(0,2).join(' | ')}`)
await b.close()
killServer()
