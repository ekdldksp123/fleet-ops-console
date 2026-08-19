import { describe, expect, it } from 'vitest'

import {
  MAX_LATITUDE,
  clampLatitude,
  haversine,
  extentContainsXY,
  lonLatExtent,
  mercatorX,
  mercatorY,
  padExtent,
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

describe('[1단계] 실시간 루프용 스칼라 변환', () => {
  it('스칼라 변환이 toMercator 와 같은 값을 준다', () => {
    // 프레임 루프는 toMercator 대신 이 둘을 쓴다. 두 경로가 갈라지면 지도와
    // 초기 fit 이 서로 다른 좌표를 쓰게 되고, 그건 눈으로 안 잡힌다.
    const samples: [number, number][] = [
      [0, 0],
      [126.9012, 37.241],
      [-122.4194, 37.7749],
      [180, MAX_LATITUDE],
    ]
    for (const [lon, lat] of samples) {
      const [x, y] = toMercator(lon, lat)
      expect(mercatorX(lon)).toBe(x)
      expect(mercatorY(lat)).toBe(y)
    }
  })
})

/**
 * 컬링 판정은 틀리면 "로봇이 조용히 사라진다"는 방식으로 실패한다.
 * 특히 경계값이 위험해서 포함/제외를 명시적으로 못 박는다.
 */
describe('[3단계] 뷰포트 컬링 헬퍼', () => {
  const extent = [0, 0, 100, 50] as const

  it('extent 를 사방으로 넓힌다', () => {
    expect(padExtent(extent, 10)).toEqual([-10, -10, 110, 60])
  })

  it('음수 margin 으로 좁힐 수도 있다', () => {
    expect(padExtent(extent, -10)).toEqual([10, 10, 90, 40])
  })

  it('안쪽 점은 포함한다', () => {
    expect(extentContainsXY(extent, 50, 25)).toBe(true)
  })

  it('경계 위의 점은 포함한다', () => {
    // 경계를 제외하면 화면 끝의 로봇이 매 프레임 컬링/갱신을 왕복하며 떨린다.
    expect(extentContainsXY(extent, 0, 0)).toBe(true)
    expect(extentContainsXY(extent, 100, 50)).toBe(true)
  })

  it('축 하나만 벗어나도 제외한다', () => {
    expect(extentContainsXY(extent, 101, 25)).toBe(false)
    expect(extentContainsXY(extent, 50, -1)).toBe(false)
  })
})
