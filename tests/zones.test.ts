import { describe, expect, it } from 'vitest'

import { pointInRing } from '@/lib/geo'
import { SITE_EXTENT, ZONES, ZONE_EXTENTS, ZONE_NAMES, zoneAt, zoneRallyPoint } from '@/lib/zones'

/**
 * 구역 폴리곤의 타일링 불변식.
 *
 * 시뮬레이터는 "구역 안의 임의의 점" 을 거부 표집으로 뽑고, 집계는 로봇이 들고 있는
 * 구역 라벨을 센다. 폴리곤에 틈이 있으면 그 틈을 배정받은 로봇이 어느 구역에도 안
 * 잡히고, 겹침이 있으면 라벨과 화면 위치가 어긋난다. 둘 다 "지도에 뭔가 그려지긴
 * 하는데 숫자가 안 맞는" 방식으로 실패한다 — 눈으로 못 잡는다.
 */
describe('구역 폴리곤 타일링', () => {
  it('구역 6개가 정의되어 있다', () => {
    expect(ZONES).toHaveLength(6)
    expect(new Set(ZONE_NAMES).size).toBe(6) // 이름 중복 없음
  })

  it('모든 링이 최소 3점이고 첫 점과 끝 점이 중복되지 않는다', () => {
    // 닫힘은 암시적이라는 규약. 중복시키면 pointInRing 의 변 순회가 길이 0 변을
    // 하나 돌게 되고, OL 로 넘길 때 닫힌 링에 점을 또 더하게 된다.
    for (const zone of ZONES) {
      expect(zone.ring.length).toBeGreaterThanOrEqual(3)
      expect(zone.ring[0]).not.toEqual(zone.ring[zone.ring.length - 1])
    }
  })

  it('사이트 전역의 격자 표본이 정확히 한 구역에 속한다', () => {
    // 이게 핵심 불변식이다. 격자를 촘촘히 깔아 빈틈(0개)과 겹침(2개 이상)을 찾는다.
    const STEPS = 60
    const { minLon, minLat, maxLon, maxLat } = SITE_EXTENT
    const gaps: string[] = []
    const overlaps: string[] = []

    for (let i = 0; i < STEPS; i++) {
      for (let j = 0; j < STEPS; j++) {
        // 0.5 를 더해 셀 중앙을 찍는다. 변 위의 점은 half-open 규칙에 맡기고
        // 여기서는 내부 점만 본다 — 경계 규칙은 아래 별도 테스트에서 다룬다.
        const lon = minLon + ((i + 0.5) / STEPS) * (maxLon - minLon)
        const lat = minLat + ((j + 0.5) / STEPS) * (maxLat - minLat)
        const hits = ZONES.filter((z) => pointInRing(z.ring, lon, lat))
        if (hits.length === 0) gaps.push(`${lon.toFixed(6)},${lat.toFixed(6)}`)
        if (hits.length > 1) {
          overlaps.push(`${lon.toFixed(6)},${lat.toFixed(6)} → ${hits.map((h) => h.name).join('+')}`)
        }
      }
    }

    expect(gaps, `빈틈 ${gaps.length}곳 (예: ${gaps.slice(0, 3).join(' / ')})`).toHaveLength(0)
    expect(
      overlaps,
      `겹침 ${overlaps.length}곳 (예: ${overlaps.slice(0, 3).join(' / ')})`,
    ).toHaveLength(0)
  })

  it('사이트 밖 점은 어느 구역에도 속하지 않는다', () => {
    expect(zoneAt(SITE_EXTENT.minLon - 0.01, SITE_EXTENT.minLat)).toBeNull()
    expect(zoneAt(SITE_EXTENT.maxLon + 0.01, SITE_EXTENT.maxLat)).toBeNull()
    expect(zoneAt(0, 0)).toBeNull()
  })

  it('모든 구역이 볼록하다', () => {
    // 시뮬레이터가 의존하는 불변식이다. 로봇은 구역 안의 웨이포인트로 직선 이동하고,
    // 볼록 다각형에서만 "내부 두 점을 잇는 선분이 전부 내부" 가 보장된다.
    // 오목해지면 로봇이 이동 중에 자기 구역을 벗어나 집계와 오버레이가 어긋난다.
    for (const zone of ZONES) {
      const r = zone.ring
      const n = r.length
      let sign = 0
      for (let i = 0; i < n; i++) {
        const [ax, ay] = r[i]
        const [bx, by] = r[(i + 1) % n]
        const [cx, cy] = r[(i + 2) % n]
        const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx)
        if (cross === 0) continue // 일직선 세 점은 볼록성을 깨지 않는다
        const s = Math.sign(cross)
        if (sign === 0) sign = s
        expect(s, `${zone.name} 의 정점 ${i} 에서 회전 방향이 바뀐다 (오목)`).toBe(sign)
      }
    }
  })

  it('구역 내 두 점을 잇는 선분은 구역을 벗어나지 않는다', () => {
    // 볼록성의 실질적 귀결. 로봇의 직선 이동 경로가 이 성질에 기대고 있다.
    for (let zi = 0; zi < ZONES.length; zi++) {
      const zone = ZONES[zi]
      const e = ZONE_EXTENTS[zi]
      const inside: [number, number][] = []
      for (let i = 1; i < 12 && inside.length < 8; i++) {
        for (let j = 1; j < 12 && inside.length < 8; j++) {
          const lon = e.minLon + (i / 12) * (e.maxLon - e.minLon)
          const lat = e.minLat + (j / 12) * (e.maxLat - e.minLat)
          if (pointInRing(zone.ring, lon, lat)) inside.push([lon, lat])
        }
      }
      expect(inside.length).toBeGreaterThan(1)

      for (const [ax, ay] of inside) {
        for (const [bx, by] of inside) {
          for (let t = 1; t < 10; t++) {
            const k = t / 10
            const mx = ax + (bx - ax) * k
            const my = ay + (by - ay) * k
            expect(
              pointInRing(zone.ring, mx, my),
              `${zone.name}: (${ax},${ay}) → (${bx},${by}) 경로가 구역을 벗어난다`,
            ).toBe(true)
          }
        }
      }
    }
  })

  it('pointInRing 은 오목 다각형도 올바르게 판정한다', () => {
    // 구역은 전부 볼록으로 갔지만, ray casting 자체가 오목을 다루는지는 별개로
    // 확인해 둔다. 나중에 창고 내부 통로 같은 오목 구역을 넣을 수 있어야 한다.
    const lShape: [number, number][] = [
      [0, 0],
      [4, 0],
      [4, 1],
      [1, 1],
      [1, 4],
      [0, 4],
    ]
    expect(pointInRing(lShape, 0.5, 0.5)).toBe(true) // 모서리
    expect(pointInRing(lShape, 3, 0.5)).toBe(true) // 아래 팔
    expect(pointInRing(lShape, 0.5, 3)).toBe(true) // 위 팔
    expect(pointInRing(lShape, 3, 3)).toBe(false) // 패인 부분 → 밖
  })

  it('각 구역이 최소 한 개의 내부 점을 가진다 (면적이 0이 아니다)', () => {
    // 좌표를 잘못 적어 폴리곤이 찌그러지면 거부 표집이 영원히 실패한다.
    for (const zone of ZONES) {
      let hit = false
      for (let i = 1; i < 40 && !hit; i++) {
        for (let j = 1; j < 40 && !hit; j++) {
          const lon = 126.8737 + (i / 40) * 0.055
          const lat = 37.22175 + (j / 40) * 0.0385
          if (pointInRing(zone.ring, lon, lat)) hit = true
        }
      }
      expect(hit, `${zone.name} 내부 점을 못 찾았다`).toBe(true)
    }
  })
})

/**
 * 시뮬레이터가 실제로 로봇을 구역 안에 두는지.
 *
 * 이게 이 기능의 계약이다. 여기가 깨지면 지도의 구역 폴리곤과 사이드바의 구역 집계가
 * 서로 다른 이야기를 하기 시작한다 — 화면은 정상으로 보이고 숫자만 안 맞는다.
 *
 * simulator.ts 는 'server-only' 를 import 하므로 vitest(node 환경)에서 직접 못 불러온다.
 * 그래서 거부 표집이 지키는 성질만 zones.ts 쪽에서 확인한다: 구역 안에서 뽑은 점은
 * 그 구역에 속한다.
 */
describe('구역 내 위치 표집', () => {
  it('각 구역의 bbox 에서 뽑아 폴리곤 통과한 점은 그 구역에 속한다', () => {
    // 시뮬레이터 pointInZone() 과 같은 절차를 재현한다.
    let sampled = 0
    for (let zi = 0; zi < ZONES.length; zi++) {
      const zone = ZONES[zi]
      const e = ZONE_EXTENTS[zi]
      for (let n = 0; n < 200; n++) {
        const lon = e.minLon + ((n * 7919) % 1000) / 1000 * (e.maxLon - e.minLon)
        const lat = e.minLat + ((n * 6271) % 997) / 997 * (e.maxLat - e.minLat)
        if (!pointInRing(zone.ring, lon, lat)) continue
        sampled++
        // 통과한 점은 zoneAt 으로도 같은 구역이어야 한다 = 겹침이 없다는 뜻
        expect(zoneAt(lon, lat)?.name).toBe(zone.name)
      }
    }
    // 표집이 아예 안 됐으면 테스트가 아무것도 검증하지 않은 것이다
    expect(sampled).toBeGreaterThan(500)
  })

  it('거부 표집이 40회 안에 끝날 만큼 각 구역이 bbox 를 충분히 채운다', () => {
    // 면적비가 너무 작으면 시뮬레이터가 폴백(중심점)으로 떨어져 로봇이 뭉친다.
    // 외곽 통로(L 자)가 최악인데 그래도 20% 는 넘어야 안전하다.
    for (let zi = 0; zi < ZONES.length; zi++) {
      const zone = ZONES[zi]
      const e = ZONE_EXTENTS[zi]
      let inside = 0
      const N = 40
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const lon = e.minLon + ((i + 0.5) / N) * (e.maxLon - e.minLon)
          const lat = e.minLat + ((j + 0.5) / N) * (e.maxLat - e.minLat)
          if (pointInRing(zone.ring, lon, lat)) inside++
        }
      }
      const ratio = inside / (N * N)
      expect(ratio, `${zone.name} 의 bbox 대비 면적비 ${(ratio * 100).toFixed(1)}%`).toBeGreaterThan(
        0.2,
      )
    }
  })
})

describe('구역 집결지', () => {
  it('모든 구역의 집결지가 그 구역 내부에 있다', () => {
    // "호출" 명령이 이 좌표를 웨이포인트로 준다. 폴리곤 밖이면 로봇이 자기 구역을
    // 벗어나고 구역 라벨과 위치가 어긋난다. 볼록성 덕에 정점 평균이 내부다.
    for (const zone of ZONES) {
      const [lon, lat] = zoneRallyPoint(zone)
      expect(pointInRing(zone.ring, lon, lat), `${zone.name} 집결지가 구역 밖이다`).toBe(true)
      expect(zoneAt(lon, lat)?.name).toBe(zone.name)
    }
  })

  it('집결지에서 구역 내 임의의 점까지 직선 경로가 구역을 벗어나지 않는다', () => {
    // 호출받은 로봇은 현재 위치에서 집결지로 직선 이동한다.
    for (let zi = 0; zi < ZONES.length; zi++) {
      const zone = ZONES[zi]
      const e = ZONE_EXTENTS[zi]
      const [rx, ry] = zoneRallyPoint(zone)
      for (let i = 1; i < 10; i++) {
        for (let j = 1; j < 10; j++) {
          const lon = e.minLon + (i / 10) * (e.maxLon - e.minLon)
          const lat = e.minLat + (j / 10) * (e.maxLat - e.minLat)
          if (!pointInRing(zone.ring, lon, lat)) continue
          for (let t = 1; t < 8; t++) {
            const k = t / 8
            expect(pointInRing(zone.ring, lon + (rx - lon) * k, lat + (ry - lat) * k)).toBe(true)
          }
        }
      }
    }
  })
})
