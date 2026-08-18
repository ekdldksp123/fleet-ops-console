import { beforeEach, describe, expect, it } from 'vitest'

import { applyDelta, filterRobots, summarize } from '@/lib/delta'
import type { DeltaFrame, Robot } from '@/lib/types'

function robot(overrides: Partial<Robot> = {}): Robot {
  return {
    id: 'RB-00001',
    name: 'AMR 0001',
    zone: 'A동 적재',
    lon: 126.9,
    lat: 37.24,
    statusCode: 1,
    battery: 80,
    ...overrides,
  }
}

function frame(updates: DeltaFrame['updates'], seq = 1): DeltaFrame {
  return { t: 1_000, seq, updates }
}

describe('applyDelta', () => {
  let robots: Map<string, Robot>

  beforeEach(() => {
    robots = new Map([
      ['RB-00001', robot()],
      ['RB-00002', robot({ id: 'RB-00002', lon: 126.91, statusCode: 0, battery: 40 })],
    ])
  })

  it('좌표와 상태를 병합하고 바뀐 id 만 보고한다', () => {
    const result = applyDelta(robots, frame([['RB-00001', 126.95, 37.25, 2, 79.5]]), 0)

    expect(result.changed).toEqual(['RB-00001'])
    expect(result.dropped).toBe(false)
    const merged = robots.get('RB-00001')!
    expect(merged.lon).toBe(126.95)
    expect(merged.lat).toBe(37.25)
    expect(merged.statusCode).toBe(2)
    expect(merged.battery).toBe(79.5)
  })

  it('값이 실제로 같으면 changed 에 넣지 않는다 (불필요한 리렌더 방지)', () => {
    const result = applyDelta(robots, frame([['RB-00001', 126.9, 37.24, 1, 80]]), 0)
    expect(result.changed).toEqual([])
  })

  it('seq 가 역전되거나 중복이면 프레임 전체를 버린다', () => {
    const stale = applyDelta(robots, frame([['RB-00001', 999, 999, 3, 0]], 5), 10)
    expect(stale.dropped).toBe(true)
    expect(robots.get('RB-00001')!.lon).toBe(126.9) // 오염되지 않음

    const duplicate = applyDelta(robots, frame([['RB-00001', 999, 999, 3, 0]], 10), 10)
    expect(duplicate.dropped).toBe(true)
  })

  it('스냅샷에 없는 id 는 조용히 삼키지 않고 드러낸다', () => {
    const result = applyDelta(robots, frame([['RB-99999', 126.9, 37.2, 1, 50]]), 0)
    expect(result.unknown).toEqual(['RB-99999'])
    expect(result.changed).toEqual([])
    expect(robots.size).toBe(2)
  })

  it('객체 아이덴티티를 유지한다 (제자리 병합)', () => {
    const before = robots.get('RB-00001')
    applyDelta(robots, frame([['RB-00001', 126.95, 37.25, 1, 70]]), 0)
    expect(robots.get('RB-00001')).toBe(before)
  })

  it('한 프레임에 여러 대가 와도 전부 처리한다', () => {
    const result = applyDelta(
      robots,
      frame([
        ['RB-00001', 126.95, 37.25, 1, 70],
        ['RB-00002', 126.96, 37.26, 3, 39],
      ]),
      0,
    )
    expect(result.changed).toHaveLength(2)
    expect(robots.get('RB-00002')!.statusCode).toBe(3)
  })
})

describe('summarize', () => {
  it('상태별 집계와 평균 배터리를 낸다', () => {
    const summary = summarize([
      robot({ id: 'a', statusCode: 1, battery: 100 }),
      robot({ id: 'b', statusCode: 1, battery: 50 }),
      robot({ id: 'c', statusCode: 3, battery: 10 }),
    ])
    expect(summary.total).toBe(3)
    expect(summary.byStatus[1]).toBe(2)
    expect(summary.byStatus[3]).toBe(1)
    expect(summary.byStatus[0]).toBe(0)
    expect(summary.avgBattery).toBeCloseTo(53.333, 3)
    expect(summary.lowBattery).toBe(1)
  })

  it('빈 플릿에서 0으로 나누지 않는다', () => {
    const summary = summarize([])
    expect(summary.total).toBe(0)
    expect(summary.avgBattery).toBe(0)
  })
})

describe('filterRobots', () => {
  const fleet = [
    robot({ id: 'RB-00001', name: 'AMR 0001', zone: 'A동 적재', statusCode: 1 }),
    robot({ id: 'RB-00002', name: 'AMR 0002', zone: 'C동 도장', statusCode: 3 }),
    robot({ id: 'RB-00003', name: 'AMR 0003', zone: 'A동 적재', statusCode: 0 }),
  ]

  it('필터가 없으면 원본 배열을 그대로 돌려준다 (불필요한 복사 회피)', () => {
    expect(filterRobots(fleet, { statusFilter: 'all', query: '  ' })).toBe(fleet)
  })

  it('상태로 거른다', () => {
    const result = filterRobots(fleet, { statusFilter: 3, query: '' })
    expect(result.map((r) => r.id)).toEqual(['RB-00002'])
  })

  it('구역명 부분 일치로 거른다', () => {
    const result = filterRobots(fleet, { statusFilter: 'all', query: 'A동' })
    expect(result).toHaveLength(2)
  })

  it('대소문자를 무시한다', () => {
    expect(filterRobots(fleet, { statusFilter: 'all', query: 'amr 0002' })).toHaveLength(1)
  })

  it('상태와 검색어를 함께 적용한다 (AND)', () => {
    const result = filterRobots(fleet, { statusFilter: 0, query: 'A동' })
    expect(result.map((r) => r.id)).toEqual(['RB-00003'])
  })
})
