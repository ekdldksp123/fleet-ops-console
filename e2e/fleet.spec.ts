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
  const counter = page.getByText(/\d+ \/ \d+ 대/)
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
