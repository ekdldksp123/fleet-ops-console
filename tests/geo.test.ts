import { describe, expect, it } from 'vitest'

import {
  MAX_LATITUDE,
  clampLatitude,
  haversine,
  lonLatExtent,
  toLonLat,
  toMercator,
  toMercatorExtent,
  toMercatorFlat,
} from '@/lib/geo'

/**
 * 좌표 변환은 지도 코드에서 가장 조용히 틀리는 부분이다.
 * 화면에 뭔가 그려지긴 하는데 위치가 미묘하게 어긋나면 눈으로는 못 잡는다.
 * 그래서 알려진 기준값으로 못을 박아둔다.
 */
describe('EPSG:4326 ↔ EPSG:3857 변환', () => {
  it('원점은 원점으로 간다', () => {
    // tan(π/4) 가 부동소수점에서 정확히 1이 아니라 y 에 약 -7e-10 의 잔차가 남는다.
    // 나노미터 이하 오차라 실무상 무의미하지만, toEqual 로 못을 박으면 깨진다.
    const [x, y] = toMercator(0, 0)
    expect(x).toBe(0)
    expect(y).toBeCloseTo(0, 6)
  })

  it('경도 180도는 Web Mercator 의 x 최대값이 된다', () => {
    const [x] = toMercator(180, 0)
    expect(x).toBeCloseTo(20037508.342789244, 6)
  })

  it('위도 한계에서 x 와 y 의 절대값이 같아진다 (정사각 투영)', () => {
    const [x] = toMercator(180, 0)
    const [, y] = toMercator(0, MAX_LATITUDE)
    expect(y).toBeCloseTo(x, 2)
  })

  it('왕복 변환이 원래 좌표를 보존한다', () => {
    const samples: [number, number][] = [
      [126.9012, 37.241], // 데모 사이트
      [126.978, 37.5665], // 서울시청
      [-122.4194, 37.7749],
      [0, 0],
      [179.9999, -85],
    ]
    for (const [lon, lat] of samples) {
      const [x, y] = toMercator(lon, lat)
      const [lon2, lat2] = toLonLat(x, y)
      expect(lon2).toBeCloseTo(lon, 9)
      expect(lat2).toBeCloseTo(lat, 9)
    }
  })

  it('극지방 위도를 투영 한계로 클램프한다 (무한대 방지)', () => {
    expect(clampLatitude(90)).toBe(MAX_LATITUDE)
    expect(clampLatitude(-90)).toBe(-MAX_LATITUDE)
    const [, y] = toMercator(0, 90)
    expect(Number.isFinite(y)).toBe(true)
  })

  it('평탄 배열 변환이 개별 변환과 일치한다', () => {
    const points = [
      [126.9, 37.2],
      [127.1, 37.3],
    ] as const
    const flat = toMercatorFlat(points)
    expect(flat).toHaveLength(4)
    for (let i = 0; i < points.length; i++) {
      const [x, y] = toMercator(points[i][0], points[i][1])
      expect(flat[i * 2]).toBeCloseTo(x, 6)
      expect(flat[i * 2 + 1]).toBeCloseTo(y, 6)
    }
  })
})

describe('바운딩 박스', () => {
  it('빈 배열이면 null 을 준다', () => {
    expect(lonLatExtent([])).toBeNull()
  })

  it('최소/최대를 정확히 잡는다', () => {
    const extent = lonLatExtent([
      [126.8, 37.1],
      [127.0, 37.4],
      [126.9, 37.2],
    ])
    expect(extent).toEqual({ minLon: 126.8, minLat: 37.1, maxLon: 127.0, maxLat: 37.4 })
  })

  it('Mercator extent 는 [minX, minY, maxX, maxY] 순서를 지킨다', () => {
    const extent = toMercatorExtent({ minLon: 126.8, minLat: 37.1, maxLon: 127.0, maxLat: 37.4 })
    expect(extent[0]).toBeLessThan(extent[2])
    expect(extent[1]).toBeLessThan(extent[3])
  })
})

describe('거리 계산', () => {
  it('적도에서 위도 1도는 약 111.3km', () => {
    expect(haversine([0, 0], [0, 1])).toBeCloseTo(111319.49, 0)
  })

  it('같은 지점의 거리는 0', () => {
    expect(haversine([126.9, 37.2], [126.9, 37.2])).toBe(0)
  })
})
