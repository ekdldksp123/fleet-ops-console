import { expect, test } from '@playwright/test'

/**
 * E2E 는 "실시간 파이프라인이 실제로 살아 있는가" 만 검증한다.
 * 픽셀 단위 검증은 캔버스라 의미가 없고, 유닛 테스트가 로직을 이미 덮는다.
 */

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
  await expect(page.getByText('SSE 수신 중')).toBeVisible({ timeout: 15_000 })

  // 계측 오버레이의 프레임 seq 가 증가하는지 확인
  const overlay = page.locator('text=프레임 seq').locator('..')
  const first = await overlay.locator('span').last().textContent()
  await page.waitForTimeout(2000)
  const second = await overlay.locator('span').last().textContent()
  expect(Number(second)).toBeGreaterThan(Number(first))
})

test('목록에서 로봇을 선택하면 강조된다', async ({ page }) => {
  await page.goto('/fleet')
  const firstRow = page.locator('button:has-text("RB-")').first()
  await firstRow.click()
  await expect(firstRow).toHaveClass(/bg-amber/)
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
