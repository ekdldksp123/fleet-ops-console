/**
 * EPSG:4326 (WGS84 경위도) ↔ EPSG:3857 (Web Mercator) 변환.
 *
 * OpenLayers 의 `fromLonLat` / `toLonLat` 과 수식이 동일하다. 직접 구현한 이유는
 * 두 가지다.
 *
 *  1. 좌표 변환은 순수 함수라 OL(그리고 DOM) 없이 단위 테스트할 수 있어야 한다.
 *     tests/geo.test.ts 가 알려진 기준값으로 검증한다.
 *  2. 실시간 루프에서 변환이 어디서 몇 번 일어나는지를 명시적으로 통제하기 위함.
 *     델타 프레임은 경위도로 오지만 지도는 Mercator 로 그린다. 변환을 프레임당
 *     한 번, 갱신된 로봇에 대해서만 수행한다는 점이 이 파일의 존재 이유다.
 */

/** 구면 메르카토르 기준 반지름 (m) */
export const EARTH_RADIUS = 6378137

/** Web Mercator 가 표현 가능한 위도 한계 */
export const MAX_LATITUDE = 85.0511287798066

export type LonLat = readonly [number, number]
export type Mercator = readonly [number, number]

const DEG_TO_RAD = Math.PI / 180

export function clampLatitude(lat: number): number {
  if (lat > MAX_LATITUDE) return MAX_LATITUDE
  if (lat < -MAX_LATITUDE) return -MAX_LATITUDE
  return lat
}

/**
 * [1단계] EPSG:4326 → EPSG:3857 의 x 성분만.
 *
 * 스칼라로 쪼개 둔 이유는 순전히 실시간 루프 때문이다. `toMercator` 는 호출마다
 * 길이 2 배열을 새로 만드는데, 2,000대 × 10Hz 면 초당 20,000개의 단명 배열이
 * 생긴다. 짧게 살고 죽는 객체라 개별 비용은 작지만, 이만한 빈도가 되면 minor GC
 * 가 잦아지고 그게 프레임 중간에 걸리면 최저 FPS 로 드러난다.
 *
 * 그래서 프레임 루프(FleetMap)는 `toMercator` 대신 이 두 함수를 직접 쓴다.
 * 결과를 담을 배열이 이미 있기 때문에(Point 의 flatCoordinates) 새 배열을
 * 만들 이유가 없다.
 *
 * 초기화처럼 빈도가 낮은 곳에서는 읽기 좋은 `toMercator` 를 그대로 쓴다. 두 경로가
 * 같은 값을 준다는 건 tests/geo.test.ts 가 확인한다.
 */
export function mercatorX(lon: number): number {
  return EARTH_RADIUS * lon * DEG_TO_RAD
}

/** [1단계] EPSG:4326 → EPSG:3857 의 y 성분만. 위도는 투영 한계로 클램프된다. */
export function mercatorY(lat: number): number {
  return EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (clampLatitude(lat) * DEG_TO_RAD) / 2))
}

/** EPSG:4326 → EPSG:3857 */
export function toMercator(lon: number, lat: number): [number, number] {
  return [mercatorX(lon), mercatorY(lat)]
}

/** EPSG:3857 → EPSG:4326 */
export function toLonLat(x: number, y: number): [number, number] {
  const lon = x / (EARTH_RADIUS * DEG_TO_RAD)
  const lat = (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) / DEG_TO_RAD
  return [lon, lat]
}

/**
 * 좌표 배열을 Mercator 로 변환해 Float64Array 하나에 평탄하게 담는다.
 * 객체 배열보다 GC 압력이 훨씬 낮아 실시간 루프에 적합하다.
 */
export function toMercatorFlat(points: readonly LonLat[]): Float64Array {
  const out = new Float64Array(points.length * 2)
  for (let i = 0; i < points.length; i++) {
    const [x, y] = toMercator(points[i][0], points[i][1])
    out[i * 2] = x
    out[i * 2 + 1] = y
  }
  return out
}

export interface Extent {
  minLon: number
  minLat: number
  maxLon: number
  maxLat: number
}

/** 경위도 점들의 바운딩 박스. 빈 배열이면 null. */
export function lonLatExtent(points: readonly LonLat[]): Extent | null {
  if (points.length === 0) return null
  let minLon = Infinity
  let minLat = Infinity
  let maxLon = -Infinity
  let maxLat = -Infinity
  for (const [lon, lat] of points) {
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }
  return { minLon, minLat, maxLon, maxLat }
}

/** OpenLayers `fitExtent` 에 넘길 [minX, minY, maxX, maxY] (Mercator) */
export function toMercatorExtent(e: Extent): [number, number, number, number] {
  const [minX, minY] = toMercator(e.minLon, e.minLat)
  const [maxX, maxY] = toMercator(e.maxLon, e.maxLat)
  return [minX, minY, maxX, maxY]
}

/** 두 경위도 지점 사이의 대권 거리 (m) */
export function haversine(a: LonLat, b: LonLat): number {
  const dLat = (b[1] - a[1]) * DEG_TO_RAD
  const dLon = (b[0] - a[0]) * DEG_TO_RAD
  const lat1 = a[1] * DEG_TO_RAD
  const lat2 = b[1] * DEG_TO_RAD
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)))
}
