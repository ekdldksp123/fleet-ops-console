import { describe, expect, it } from 'vitest'

import { applyDelta } from '@/lib/delta'
import { applyPackedFrame, packFrame, type DeltaLike } from '@/lib/frame-codec'
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

function fleet(ids: string[]): Map<string, Robot> {
  return new Map(ids.map((id) => [id, robot({ id })]))
}

function indexes(ids: string[]) {
  return { idToIndex: new Map(ids.map((id, i) => [id, i])), indexToId: ids }
}

/**
 * 워커 경로(이진 코덱)와 메인 경로(applyDelta)는 **결과가 같아야 한다.**
 *
 * 다르면 전송 방식을 바꾸는 것만으로 화면이 달라지고, 그러면 두 방식의 벤치마크
 * 비교가 무의미해진다. 더 나쁘게는 "워커 모드에서만 나는 버그" 가 생긴다.
 */
describe('이진 프레임 코덱', () => {
  const ids = ['RB-00000', 'RB-00001', 'RB-00002']

  it('왕복 후 좌표·상태·배터리가 보존된다', () => {
    const { idToIndex, indexToId } = indexes(ids)
    const robots = fleet(ids)
    const frame: DeltaLike = {
      t: 1000,
      seq: 1,
      updates: [
        ['RB-00001', 126.884394, 37.251015, 3, 43.5],
        ['RB-00002', 126.9012, 37.241, 2, 99.9],
      ],
    }

    const result = applyPackedFrame(robots, indexToId, packFrame(frame, idToIndex, 123), 0)

    expect(result.changed.sort()).toEqual(['RB-00001', 'RB-00002'])
    expect(robots.get('RB-00001')).toMatchObject({
      lon: 126.884394,
      lat: 37.251015,
      statusCode: 3,
      battery: 43.5,
    })
    expect(robots.get('RB-00002')).toMatchObject({ lon: 126.9012, lat: 37.241, battery: 99.9 })
  })

  it('좌표가 Float32 로 깎이지 않는다 (지상 오차 0)', () => {
    // Float32 에 담으면 126.884394 → 약 126.8844 로 뭉개져 지상 40m 가 어긋난다.
    const { idToIndex, indexToId } = indexes(ids)
    const robots = fleet(ids)
    const lon = 126.884394
    const lat = 37.251015

    applyPackedFrame(
      robots,
      indexToId,
      packFrame({ t: 1, seq: 1, updates: [['RB-00000', lon, lat, 1, 50]] }, idToIndex, 1),
      0,
    )

    // toBe: 근사값이 아니라 정확히 같은 double 이어야 한다
    expect(robots.get('RB-00000')!.lon).toBe(lon)
    expect(robots.get('RB-00000')!.lat).toBe(lat)
  })

  it('메인 경로(applyDelta)와 changed 목록이 같다', () => {
    const updates: DeltaFrame['updates'] = [
      ['RB-00000', 126.884394, 37.251015, 1, 43.5], // 변경
      ['RB-00001', 126.9, 37.24, 1, 80], // 무변경 (초기값과 동일)
      ['RB-00002', 126.95, 37.25, 2, 12.3], // 변경
    ]
    const { idToIndex, indexToId } = indexes(ids)

    const mainRobots = fleet(ids)
    const mainResult = applyDelta(mainRobots, { t: 1, seq: 1, updates }, 0)

    const workerRobots = fleet(ids)
    const workerResult = applyPackedFrame(
      workerRobots,
      indexToId,
      packFrame({ t: 1, seq: 1, updates }, idToIndex, 1),
      0,
    )

    expect(workerResult.changed).toEqual(mainResult.changed)
    // 최종 상태도 같아야 한다
    for (const id of ids) {
      expect(workerRobots.get(id)).toEqual(mainRobots.get(id))
    }
  })

  it('배터리 Float32 반올림 때문에 무변경 로봇이 changed 로 잡히지 않는다', () => {
    // 80.1 은 Float32 에 정확히 안 담긴다. 되돌리지 않으면 매 프레임 전체가
    // changed 로 잡혀서 갱신량이 폭발한다.
    const { idToIndex, indexToId } = indexes(ids)
    const robots = fleet(ids)
    robots.get('RB-00000')!.battery = 80.1

    const frame: DeltaLike = { t: 1, seq: 1, updates: [['RB-00000', 126.9, 37.24, 1, 80.1]] }
    const result = applyPackedFrame(robots, indexToId, packFrame(frame, idToIndex, 1), 0)

    expect(result.changed).toEqual([])
    expect(robots.get('RB-00000')!.battery).toBe(80.1)
  })

  it('seq 가 역전되면 프레임 전체를 버린다', () => {
    const { idToIndex, indexToId } = indexes(ids)
    const robots = fleet(ids)
    const frame: DeltaLike = { t: 1, seq: 5, updates: [['RB-00000', 1, 2, 1, 50]] }

    const result = applyPackedFrame(robots, indexToId, packFrame(frame, idToIndex, 1), 10)

    expect(result.dropped).toBe(true)
    expect(result.changed).toEqual([])
    expect(robots.get('RB-00000')!.lon).toBe(126.9) // 안 바뀜
  })

  it('인덱스 표에 없는 id 는 개수로 드러낸다', () => {
    // 조용히 버리면 합계가 안 맞는데 단서가 없다. applyDelta 의 unknown 과 같은 원칙.
    const { idToIndex, indexToId } = indexes(ids)
    const robots = fleet(ids)
    const frame: DeltaLike = {
      t: 1,
      seq: 1,
      updates: [
        ['RB-99999', 1, 2, 1, 50],
        ['RB-00000', 126.95, 37.25, 1, 50],
      ],
    }

    const packed = packFrame(frame, idToIndex, 1)
    expect(packed.count).toBe(1) // 미지의 id 는 안 담긴다
    expect(packed.unknown).toBe(1)

    const result = applyPackedFrame(robots, indexToId, packed, 0)
    expect(result.unknown).toBe(1)
    expect(result.changed).toEqual(['RB-00000'])
  })

  it('빈 프레임도 안전하다', () => {
    const { idToIndex, indexToId } = indexes(ids)
    const packed = packFrame({ t: 1, seq: 1, updates: [] }, idToIndex, 0)
    expect(packed.count).toBe(0)
    expect(applyPackedFrame(fleet(ids), indexToId, packed, 0).changed).toEqual([])
  })
})
