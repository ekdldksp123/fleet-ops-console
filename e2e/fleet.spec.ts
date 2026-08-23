import { expect, test, type Page } from '@playwright/test'

/**
 * E2E 는 "실시간 파이프라인이 실제로 살아 있는가" 만 검증한다.
 * 픽셀 단위 검증은 캔버스라 의미가 없고, 유닛 테스트가 로직을 이미 덮는다.
 */

/**
 * 표의 로봇 행. 경보 레일에도 RB- 로 시작하는 버튼이 있어서 범위를 좁혀야 한다.
 * 범위를 안 좁히면 "RB- 를 포함한 버튼" 이 두 목록에 걸쳐 모호해진다.
 */
const tableRows = (page: Page) =>
  page.getByRole('region', { name: '로봇 목록' }).locator('button:has-text("RB-")')

/**
 * 클라이언트가 살아나기를 기다린다.
 *
 * SSE 연결 표시는 "하이드레이션이 끝나 이벤트 핸들러가 붙었다" 는 뜻이기도 하다.
 * 이걸 안 기다리고 클릭하면 핸들러가 붙기 전에 이벤트가 들어가 아무 일도 안 난다.
 * 클라이언트 트리가 커질 때마다 조용히 깨지는 종류의 레이스다 — @alerts 슬롯을
 * 추가했을 때 실제로 이 테스트가 깨졌다.
 */
async function waitForLive(page: Page) {
  await expect(page.getByText('SSE 수신 중')).toBeVisible({ timeout: 20_000 })
}

test('초기 스냅샷이 서버에서 렌더된다', async ({ page }) => {
  await page.goto('/fleet')

  // Server Component 가 그린 정적 패널
  await expect(page.getByRole('heading', { name: '동탄 물류 캠퍼스' })).toBeVisible()
  await expect(page.getByText('등록 대수')).toBeVisible()

  // 지도 컨테이너
  await expect(page.getByRole('application', { name: '플릿 관제 지도' })).toBeVisible()
})

test('SSE 스트림이 연결되고 상태가 갱신된다', async ({ page }) => {
  await page.goto('/fleet')
  await waitForLive(page)

  // 계측 오버레이의 프레임 seq 가 증가하는지 확인
  const overlay = page.locator('text=프레임 seq').locator('..')
  const first = await overlay.locator('span').last().textContent()
  await page.waitForTimeout(2000)
  const second = await overlay.locator('span').last().textContent()
  expect(Number(second)).toBeGreaterThan(Number(first))
})

test('목록에서 로봇을 선택하면 강조된다', async ({ page }) => {
  await page.goto('/fleet')
  await waitForLive(page)

  const firstRow = tableRows(page).first()
  const id = (await firstRow.textContent())?.match(/RB-\d+/)?.[0]
  await firstRow.click()

  // 로케이터를 다시 해석해도 같은 행을 가리키도록 id 로 고정한다. 선택 시
  // 가상 스크롤이 움직이면 "첫 번째 행" 이 다른 행이 될 수 있다.
  await expect(tableRows(page).filter({ hasText: id! }).first()).toHaveClass(/bg-amber/)
})

test('검색 필터가 목록을 줄인다', async ({ page }) => {
  await page.goto('/fleet')
  // 카운터는 toLocaleString() 이라 1,000대를 넘으면 "2,000 / 2,000 대" 가 된다.
  // \d+ 만으로는 콤마 때문에 매칭이 안 돼서, 기본 FLEET_SIZE(2000)에서 이 테스트가
  // 늘 실패하고 있었다. 자리 구분 기호를 문자 클래스에 넣는다.
  const counter = page.getByText(/[\d,]+ \/ [\d,]+ 대/)
  await expect(counter).toBeVisible()

  await page.getByLabel('로봇 검색').fill('RB-00001')
  await expect(page.getByText(/^1 \/ /)).toBeVisible({ timeout: 5000 })
})

test('WebGL 렌더 모드로 전환된다', async ({ page }) => {
  await page.goto('/fleet')
  await page.getByRole('radio', { name: 'WebGL' }).click()
  await expect(page.getByRole('radio', { name: 'WebGL' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText('WebGL', { exact: true }).last()).toBeVisible()
})

test('구역별 집계가 뜨고 클릭하면 목록이 걸러진다', async ({ page }) => {
  await page.goto('/fleet')

  const panel = page.locator('section', {
    has: page.getByRole('heading', { name: '구역별 현황' }),
  })
  const rows = panel.getByRole('button')
  await expect(rows).toHaveCount(6)

  // 구역 행을 누르면 기존 검색어(query)를 재사용해 목록이 걸러진다.
  // 구역 대수는 라운드로빈 배정이라 전체의 6분의 1이다.
  await rows.first().click()
  await expect(page.getByLabel('로봇 검색')).not.toHaveValue('')
  await expect(page.getByText(/[\d,]+ \/ [\d,]+ 대/)).toBeVisible()

  // 다시 누르면 해제된다
  await rows.first().click()
  await expect(page.getByLabel('로봇 검색')).toHaveValue('')
})

test('구역 오버레이를 토글할 수 있다', async ({ page }) => {
  await page.goto('/fleet')
  const toggle = page.getByRole('button', { name: '구역' })
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
})

/**
 * /fleet/[id] 상세 라우트 — 이 프로젝트가 중첩 레이아웃으로 내세우는 주장의 검증.
 *
 * 주장: 상세 라우트로 전환해도 지도 인스턴스와 SSE 연결이 유지된다.
 * 검증: 지도 컨테이너의 data-map-instance 가 안 바뀌고, /api/fleet/stream 요청이
 *       추가로 발생하지 않는다. FleetShell 이 layout.tsx 에서 page.tsx 로
 *       내려가면 둘 다 깨진다.
 */
test('상세 라우트로 전환해도 지도 인스턴스와 SSE 가 유지된다', async ({ page }) => {
  // SSE 요청 수를 센다. 재마운트되면 EventSource 가 새로 열린다.
  let sseRequests = 0
  page.on('request', (req) => {
    if (req.url().includes('/api/fleet/stream')) sseRequests++
  })

  await page.goto('/fleet')
  await waitForLive(page)

  const mapEl = page.getByRole('application', { name: '플릿 관제 지도' })
  const before = await mapEl.getAttribute('data-map-instance')
  expect(before).toBe('1')
  expect(sseRequests).toBe(1)

  // 목록에서 로봇을 선택 → /fleet/[id] 로 이동
  await tableRows(page).first().click()
  await expect(page).toHaveURL(/\/fleet\/RB-\d+$/)
  await expect(page.getByRole('complementary', { name: '로봇 상세' })).toBeVisible()

  // 지도는 같은 인스턴스, SSE 도 같은 연결이어야 한다
  expect(await mapEl.getAttribute('data-map-instance')).toBe(before)
  expect(sseRequests).toBe(1)

  // 닫기 → /fleet 로 복귀. 여기서도 유지되어야 한다
  await page.getByRole('link', { name: /닫기/ }).click()
  await expect(page).toHaveURL(/\/fleet$/)
  expect(await mapEl.getAttribute('data-map-instance')).toBe(before)
  expect(sseRequests).toBe(1)
})

test('상세 링크를 직접 열면 해당 로봇이 선택된 상태로 뜬다', async ({ page }) => {
  // URL → 스토어 동기화(SelectionSync)의 검증. 이게 없으면 패널은 열려 있는데
  // 목록·지도에는 강조가 없는 상태가 된다.
  await page.goto('/fleet/RB-00007')
  await expect(page.getByRole('complementary', { name: '로봇 상세' })).toBeVisible()
  await expect(page.getByText('RB-00007', { exact: true }).first()).toBeVisible()

  // 목록에서 해당 행이 강조된다
  const row = tableRows(page).filter({ hasText: 'RB-00007' }).first()
  await expect(row).toHaveClass(/bg-amber/, { timeout: 10_000 })
})

test('없는 로봇 id 는 상세 패널에서만 not-found 를 보여준다', async ({ page }) => {
  await page.goto('/fleet/RB-99999999')
  await expect(page.getByText('등록되지 않은 로봇입니다')).toBeVisible()
  // 지도는 죽지 않는다 — 오타 하나로 관제를 잃으면 안 된다
  await expect(page.getByRole('application', { name: '플릿 관제 지도' })).toBeVisible()
  await waitForLive(page)
})

test('뒤로가기로 선택이 해제된다', async ({ page }) => {
  await page.goto('/fleet')
  await waitForLive(page)

  await tableRows(page).first().click()
  await expect(page.getByRole('complementary', { name: '로봇 상세' })).toBeVisible()

  await page.goBack()
  await expect(page).toHaveURL(/\/fleet$/)
  await expect(page.getByRole('complementary', { name: '로봇 상세' })).toHaveCount(0)
})

/**
 * @alerts Parallel Route 슬롯.
 *
 * 특히 **하드 내비게이션**(직접 링크·새로고침)을 반드시 덮는다. 소프트 전환은
 * Next 가 슬롯 상태를 기억해 유지하지만, 하드 내비게이션에서는 default.tsx 가
 * 없으면 슬롯이 조용히 사라진다 — 에러도 안 난다. 개발 중 실제로 이걸로 헤맸다.
 */
test('경보 레일이 모든 라우트에서 렌더된다 (하드 내비게이션 포함)', async ({ page }) => {
  for (const url of ['/fleet', '/fleet/RB-00042', '/fleet/RB-99999999']) {
    await page.goto(url)
    await expect(
      page.getByRole('complementary', { name: '경보' }),
      `${url} 에서 경보 레일이 없다 — @alerts/default.tsx 를 확인할 것`,
    ).toBeVisible({ timeout: 15_000 })
  }
})

test('경보를 클릭하면 그 로봇의 상세 라우트로 이동한다', async ({ page }) => {
  await page.goto('/fleet')
  await waitForLive(page)

  const rail = page.getByRole('complementary', { name: '경보' })
  const first = rail.getByRole('button').first()
  await expect(first).toBeVisible({ timeout: 15_000 })

  const id = (await first.textContent())?.match(/RB-\d+/)?.[0]
  expect(id).toBeTruthy()

  await first.click()
  // @alerts 슬롯의 클릭이 children 슬롯(/fleet/[id])의 내용을 바꾼다
  await expect(page).toHaveURL(new RegExp(`/fleet/${id}$`))
  await expect(page.getByRole('complementary', { name: '로봇 상세' })).toBeVisible()

  // 지도는 여전히 같은 인스턴스여야 한다
  const mapEl = page.getByRole('application', { name: '플릿 관제 지도' })
  expect(await mapEl.getAttribute('data-map-instance')).toBe('1')
})

test('경로 오버레이를 토글할 수 있다', async ({ page }) => {
  await page.goto('/fleet')
  await waitForLive(page)

  const toggle = page.getByRole('button', { name: '경로' })
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
})

/**
 * Server Actions 로 보내는 제어 명령.
 *
 * 검증의 핵심은 "정지가 **유지되는가**" 다. 시뮬레이터는 대기 상태에서 100ms 마다
 * 6% 확률로 스스로 깨어나므로, 정지 명령이 그 자동 기상을 막지 못하면 1~2초 안에
 * 다시 이동중이 된다 — 버튼이 먹은 것처럼 보였다가 조용히 풀린다.
 */
test('정지 명령이 유지되고 호출로 다시 움직인다', async ({ page }) => {
  await page.goto('/fleet/RB-00003')
  await waitForLive(page)

  const panel = page.getByRole('complementary', { name: '로봇 상세' })
  const status = async () =>
    ((await panel.textContent()) ?? '').replace(/\s+/g, '').match(/(대기|이동중|충전중|오류)실시간/)?.[1]

  await page.getByRole('button', { name: '정지' }).click()
  await expect(panel.locator('[aria-live]')).toHaveText('정지 명령을 보냈습니다')
  await expect.poll(status, { timeout: 5_000 }).toBe('대기')

  // 자동 기상을 막고 있는지. 6%/100ms 라면 5초 안에 거의 확실히 깨어난다.
  await page.waitForTimeout(5_000)
  expect(await status(), '정지가 풀렸다 — 시뮬레이터의 halted 처리를 확인할 것').toBe('대기')

  await page.getByRole('button', { name: '집결지 호출' }).click()
  await expect(panel.locator('[aria-live]')).toHaveText('구역 집결지로 호출했습니다')
  await expect.poll(status, { timeout: 5_000 }).toBe('이동중')
})

/**
 * 델타 파싱 위치(메인/워커) 전환.
 *
 * 검증의 핵심은 "전환 후에도 스트림이 계속 흐르는가" 다. 워커 경로는 EventSource 를
 * 워커가 소유하고 이진 프레임을 transfer 로 넘기므로, 코덱이 어긋나면 화면이 조용히
 * 멈춘다 — 에러 없이 seq 만 안 올라간다.
 */
test('워커 파싱·이진으로 전환해도 스트림이 계속 흐른다', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.goto('/fleet')
  await waitForLive(page)

  const seq = async () => {
    const t = await page.locator('text=프레임 seq').locator('..').locator('span').last().textContent()
    return Number(t)
  }
  const before = await seq()

  const changedCount = async () => {
    const t = await page.locator('text=갱신 대수').locator('..').locator('span').last().textContent()
    return Number((t ?? '0').replace(/,/g, ''))
  }

  // 세 경로를 차례로 지나며 매번 seq 가 계속 오르는지 본다. 코덱이 어긋나면
  // 에러 없이 seq 만 멈춘다 — 화면이 조용히 정지하는 실패 방식이다.
  for (const [label, prev] of [
    ['워커 파싱', before],
    ['이진', 0],
    ['메인 파싱', 0],
  ] as const) {
    await page.getByRole('radio', { name: label }).click()
    await expect(page.getByRole('radio', { name: label })).toHaveAttribute('aria-checked', 'true')
    // 경로를 바꾸면 새로 연결하는 동안 잠깐 끊긴다
    await waitForLive(page)

    const base = prev || (await seq())
    await expect.poll(seq, { timeout: 15_000 }).toBeGreaterThan(base)
    expect(await changedCount(), `${label}: 지도 갱신이 멈췄다`).toBeGreaterThan(0)
  }

  expect(errors, `페이지 에러: ${errors.join(' | ')}`).toHaveLength(0)
})
