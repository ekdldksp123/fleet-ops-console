/**
 * 사이트 구역 정의 — 정적 사이트 데이터.
 *
 * ── 왜 이 파일이 생겼나 ──
 *
 * 원래 `Robot.zone` 은 시뮬레이터가 **위치와 무관하게 랜덤으로** 붙이는 라벨이었다.
 * 그 상태로 구역 폴리곤을 지도에 얹으면 오버레이가 거짓말을 한다 — "A동 적재" 라벨을
 * 단 로봇이 C동 폴리곤 안을 돌아다닌다. 그래서 구역에 **실제 지리적 경계**를 주고,
 * 시뮬레이터가 로봇을 자기 구역 안에서만 움직이게 고쳤다.
 *
 * ── 왜 라벨이 아니라 공간을 진실로 삼지 않았나 ──
 *
 * 반대 설계도 가능했다. 폴리곤만 정의하고 로봇의 구역을 매번 위치로 판정하는 것
 * (point-in-polygon). 그러면 시뮬레이터를 안 고쳐도 된다. 하지만 집계할 때마다
 * 로봇 N대에 대해 다각형 판정을 돌려야 하고(2.5Hz × 20,000대), `Robot.zone` 필드는
 * 아무도 안 쓰는 죽은 데이터가 된다. 지금 방식은 집계가 문자열 카운트 O(n) 이고
 * 기존 구역 검색(FilterBar)도 그대로 의미를 갖는다.
 *
 * ── 타일링 불변식 ──
 *
 * 6개 폴리곤이 사이트 전체를 **빈틈도 겹침도 없이** 덮는다. 인접한 폴리곤은 좌표를
 * 공유해서(같은 숫자 리터럴) 부동소수점 오차로 틈이 생기지 않는다. 사이트의 임의의
 * 점은 정확히 한 구역에 속한다 — tests/zones.test.ts 가 격자 표집으로 검증한다.
 *
 * 이 불변식이 중요한 이유: 시뮬레이터가 거부 표집으로 구역 안의 점을 뽑는데, 폴리곤에
 * 틈이 있으면 그 틈에 들어간 로봇은 어느 구역에도 안 잡혀 집계에서 사라진다.
 *
 * ── 볼록성 불변식 ──
 *
 * 모든 구역은 볼록해야 한다. 로봇이 구역 안의 웨이포인트로 직선 이동하기 때문이다.
 * 자세한 이유는 아래 ZONES 주석 참고.
 */

import { pointInRing, ringExtent, type Extent, type LonLat } from './geo'

/**
 * 사이트 경계. lib/simulator.ts 의 SITE_CENTER·SITE_SPAN 과 같은 영역이다.
 * 두 곳에 흩어져 있으면 어긋나므로 여기를 정본으로 삼고 시뮬레이터가 참조한다.
 */
export const SITE_CENTER: LonLat = [126.9012, 37.241]
export const SITE_SPAN_LON = 0.055
export const SITE_SPAN_LAT = 0.055 * 0.7

// ── 좌표 격자 ──
//
// 사이트를 3열 × 2행으로 나눈다. 격자 절점을 이웃 셀이 **같은 상수로** 공유하므로
// 부동소수점 오차로 틈이 생기지 않는다.
const X0 = 126.8737 // 서
const X1 = 126.8920333
const X2 = 126.9103667
const X3 = 126.9287 // 동
const Y0 = 37.22175 // 남
const Y1 = 37.241 // 중
const Y2 = 37.26025 // 북

// 내부 절점 두 개를 격자에서 일부러 비틀어 놓았다. 이웃 셀 네 개가 같은 절점을
// 공유하므로 타일링은 그대로 유지되고, 셀은 직사각형이 아닌 진짜 사각 폴리곤이 된다.
// 비트는 양은 셀 크기의 15% 이내로 제한한다 — 더 밀면 볼록성이 깨진다(아래 참고).
const P1: LonLat = [126.8942, 37.2438] // 정격자 [X1, Y1] 에서 이동
const P2: LonLat = [126.9086, 37.2382] // 정격자 [X2, Y1] 에서 이동

export interface Zone {
  name: string
  /**
   * 경위도 링. 첫 점과 마지막 점을 **중복시키지 않는다** — 닫힘은 암시적이다.
   * OpenLayers 의 Polygon 은 닫힌 링을 요구하므로 렌더 시점에 닫아준다.
   */
  ring: readonly LonLat[]
  /** 지도 라벨·집계 UI 에 쓰는 짧은 이름 */
  short: string
}

/**
 * ⚠️ 모든 구역은 **볼록(convex)** 이어야 한다. 편의가 아니라 시뮬레이터가 의존하는
 * 불변식이다.
 *
 * 로봇은 구역 안에서 뽑은 웨이포인트를 향해 **직선으로** 이동한다. 볼록 다각형에서는
 * "내부의 두 점을 잇는 선분은 전부 내부" 가 보장되므로, 로봇이 자기 구역을 벗어나는
 * 일이 기하학적으로 불가능하다. 매 tick 마다 위치를 검사할 필요가 없다.
 *
 * 처음에는 외곽 통로를 L 자(오목)로 뒀다가 이 문제로 되돌렸다. L 자에서는 남쪽 띠의
 * 점과 동쪽 띠의 점을 잇는 직선이 구역 밖으로 나간다 — 로봇이 이동 중에 자기 구역을
 * 벗어나고, 그러면 지도 오버레이와 구역 집계가 어긋난다. 막으려면 매 tick 마다
 * 20,000회 다각형 판정을 돌려야 했다. 볼록으로 만드는 쪽이 훨씬 싸다.
 *
 * tests/zones.test.ts 가 볼록성을 검증한다.
 */
export const ZONES: readonly Zone[] = [
  // ── 북쪽 행 ──
  { name: 'A동 적재', short: 'A동', ring: [[X0, Y1], P1, [X1, Y2], [X0, Y2]] },
  { name: 'B동 조립', short: 'B동', ring: [P1, P2, [X2, Y2], [X1, Y2]] },
  { name: 'C동 도장', short: 'C동', ring: [P2, [X3, Y1], [X3, Y2], [X2, Y2]] },
  // ── 남쪽 행 ──
  { name: 'D동 출하', short: 'D동', ring: [[X0, Y0], [X1, Y0], P1, [X0, Y1]] },
  { name: '충전 스테이션', short: '충전', ring: [[X1, Y0], [X2, Y0], P2, P1] },
  { name: 'E동 정비', short: 'E동', ring: [[X2, Y0], [X3, Y0], [X3, Y1], P2] },
]

export const ZONE_NAMES: readonly string[] = ZONES.map((z) => z.name)

/** 사이트 전체 경계 */
export const SITE_EXTENT: Extent = { minLon: X0, minLat: Y0, maxLon: X3, maxLat: Y2 }

/** 구역별 바운딩 박스. 거부 표집의 후보 영역으로 쓰므로 미리 계산해 둔다. */
export const ZONE_EXTENTS: readonly Extent[] = ZONES.map((z) => ringExtent(z.ring))

/**
 * 구역의 집결지 — 정점 좌표의 평균.
 *
 * **볼록 다각형에서는 정점의 평균이 항상 내부에 있다.** 그래서 이 점을 웨이포인트로
 * 주면 로봇이 구역 밖으로 나가지 않는다(로봇은 직선 이동한다). 오목 다각형이면
 * 정점 평균이 폴리곤 밖일 수 있어서 이 함수 자체가 성립하지 않는다 — ZONES 의
 * 볼록성 불변식이 여기서 한 번 더 값을 한다.
 *
 * "호출" 명령(app/fleet/_actions.ts)이 이 좌표를 목표로 쓴다.
 */
export function zoneRallyPoint(zone: Zone): LonLat {
  let lon = 0
  let lat = 0
  for (const [x, y] of zone.ring) {
    lon += x
    lat += y
  }
  return [lon / zone.ring.length, lat / zone.ring.length]
}

/**
 * 점이 속한 구역. 사이트 밖이면 null.
 *
 * 시뮬레이터가 거부 표집 검증에 쓰고, 테스트가 타일링 불변식 확인에 쓴다.
 * 실시간 집계 경로에서는 쓰지 않는다 — 집계는 `Robot.zone` 문자열로 한다.
 */
export function zoneAt(lon: number, lat: number): Zone | null {
  for (const zone of ZONES) {
    if (pointInRing(zone.ring, lon, lat)) return zone
  }
  return null
}
