/**
 * 델타 프레임 병합 및 집계 — 전부 순수 함수. DOM 도 OL 도 React 도 모른다.
 * 실시간 파이프라인에서 가장 버그가 나기 쉬운 부분이라 여기부터 테스트를 썼다.
 */

import type { DeltaFrame, Robot, StatusCode } from './types'

export interface MergeResult {
  /** 이번 프레임에서 실제로 값이 바뀐 로봇 id */
  changed: string[]
  /** 프레임에 있었지만 스냅샷에 없는 id (유실된 join). 무시 대신 드러낸다. */
  unknown: string[]
  /** seq 역전 또는 중복으로 프레임 전체를 버렸는지 */
  dropped: boolean
}

/**
 * 델타를 기존 Map 에 **제자리로** 병합한다.
 *
 * 의도적으로 불변 갱신을 하지 않는다. 2,000대 × 10Hz 에서 매 프레임 새 Map 과
 * 새 객체 2,000개를 만들면 GC 가 프레임 예산을 다 먹는다. 대신 React 는 이
 * Map 을 직접 구독하지 않고, 구독자에게 "바뀐 id 목록"만 통지해
 * 렌더 트리거를 명시적으로 통제한다. (store/fleet-store.ts 주석 참고)
 */
export function applyDelta(
  robots: Map<string, Robot>,
  frame: DeltaFrame,
  lastSeq: number,
): MergeResult {
  if (frame.seq <= lastSeq) {
    return { changed: [], unknown: [], dropped: true }
  }

  const changed: string[] = []
  const unknown: string[] = []

  for (const [id, lon, lat, statusCode, battery] of frame.updates) {
    const robot = robots.get(id)
    if (!robot) {
      unknown.push(id)
      continue
    }
    if (
      robot.lon === lon &&
      robot.lat === lat &&
      robot.statusCode === statusCode &&
      robot.battery === battery
    ) {
      continue
    }
    robot.lon = lon
    robot.lat = lat
    robot.statusCode = statusCode as StatusCode
    robot.battery = battery
    changed.push(id)
  }

  return { changed, unknown, dropped: false }
}

export interface FleetSummary {
  total: number
  byStatus: Record<StatusCode, number>
  avgBattery: number
  /** 배터리 20% 미만 */
  lowBattery: number
}

export function summarize(robots: Iterable<Robot>): FleetSummary {
  const byStatus: Record<StatusCode, number> = { 0: 0, 1: 0, 2: 0, 3: 0 }
  let total = 0
  let batterySum = 0
  let lowBattery = 0

  for (const r of robots) {
    total++
    byStatus[r.statusCode]++
    batterySum += r.battery
    if (r.battery < 20) lowBattery++
  }

  return {
    total,
    byStatus,
    avgBattery: total === 0 ? 0 : batterySum / total,
    lowBattery,
  }
}

export interface ZoneSummary {
  zone: string
  total: number
  byStatus: Record<StatusCode, number>
  /** 배터리 20% 미만 */
  lowBattery: number
}

/**
 * 구역별 집계.
 *
 * `Robot.zone` 문자열로 센다 — 좌표로 다각형 판정을 하지 않는다. 시뮬레이터가 로봇을
 * 자기 구역 안에서만 움직이게 만들어 두었으므로(lib/zones.ts 주석 참고) 라벨과 위치가
 * 일치하고, 그래서 O(n) 문자열 카운트로 충분하다. 2.5Hz × 20,000대에서 다각형 판정을
 * 돌리는 것과 비용이 다르다.
 *
 * `zones` 로 출력 순서를 고정한다. 대수 순으로 정렬하면 값이 흔들릴 때마다 행이
 * 위아래로 튀어서 눈으로 추적할 수 없다.
 *
 * 목록에 없는 구역이 데이터에 나오면 **버리지 않고 뒤에 붙인다.** 조용히 삭제하면
 * 합계가 안 맞는데 원인을 찾을 단서가 없다 — applyDelta 가 미지의 id 를 드러내는
 * 것과 같은 이유다.
 */
export function summarizeByZone(
  robots: Iterable<Robot>,
  zones: readonly string[],
): ZoneSummary[] {
  const acc = new Map<string, ZoneSummary>()
  const make = (zone: string): ZoneSummary => ({
    zone,
    total: 0,
    byStatus: { 0: 0, 1: 0, 2: 0, 3: 0 },
    lowBattery: 0,
  })

  // 0대인 구역도 행을 유지해야 표의 높이가 안 흔들린다.
  for (const zone of zones) acc.set(zone, make(zone))

  for (const r of robots) {
    let bucket = acc.get(r.zone)
    if (!bucket) {
      bucket = make(r.zone)
      acc.set(r.zone, bucket)
    }
    bucket.total++
    bucket.byStatus[r.statusCode]++
    if (r.battery < 20) bucket.lowBattery++
  }

  return [...acc.values()]
}

export interface Alert {
  robotId: string
  zone: string
  kind: 'error' | 'lowBattery'
  /** 저전력이면 배터리 %, 오류면 0 */
  battery: number
}

/**
 * 경보 목록 — 오류 상태와 저전력을 한 줄로 뽑는다.
 *
 * 정렬 규칙이 중요하다. 관제에서 경보 목록은 **위에서부터 읽는** 것이라
 * 순서가 흔들리면 못 읽는다.
 *   1) 오류가 저전력보다 먼저 (심각도)
 *   2) 같은 종류면 배터리 낮은 순 (급한 것부터)
 *   3) 그래도 같으면 id 순 (안정 정렬 — 값이 같을 때 행이 튀지 않게)
 *
 * `limit` 으로 상한을 둔다. 20,000대 플릿에서 오류가 1%만 나도 200줄이고, 그걸
 * 2.5Hz 로 리렌더하면 경보 패널이 지도의 프레임 예산을 먹는다. 잘린 개수는
 * 호출자가 total 로 알 수 있으므로 조용히 감추는 게 아니다.
 */
export function collectAlerts(
  robots: Iterable<Robot>,
  limit = 40,
): { alerts: Alert[]; totalErrors: number; totalLowBattery: number } {
  const found: Alert[] = []
  let totalErrors = 0
  let totalLowBattery = 0

  for (const r of robots) {
    if (r.statusCode === 3) {
      totalErrors++
      found.push({ robotId: r.id, zone: r.zone, kind: 'error', battery: r.battery })
    } else if (r.battery < 20) {
      // 오류인 로봇은 배터리가 낮아도 오류로만 센다. 한 로봇이 두 줄을 차지하면
      // 경보 개수와 로봇 대수가 안 맞아 헷갈린다.
      totalLowBattery++
      found.push({ robotId: r.id, zone: r.zone, kind: 'lowBattery', battery: r.battery })
    }
  }

  found.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'error' ? -1 : 1
    if (a.battery !== b.battery) return a.battery - b.battery
    return a.robotId < b.robotId ? -1 : 1
  })

  return { alerts: found.slice(0, limit), totalErrors, totalLowBattery }
}

export interface FilterOptions {
  statusFilter: StatusCode | 'all'
  query: string
}

/** 목록 필터. 대소문자 무시, id/name/zone 부분 일치. */
export function filterRobots(
  robots: readonly Robot[],
  { statusFilter, query }: FilterOptions,
): Robot[] {
  const q = query.trim().toLowerCase()
  if (statusFilter === 'all' && q === '') return robots as Robot[]

  return robots.filter((r) => {
    if (statusFilter !== 'all' && r.statusCode !== statusFilter) return false
    if (q === '') return true
    return (
      r.id.toLowerCase().includes(q) ||
      r.name.toLowerCase().includes(q) ||
      r.zone.toLowerCase().includes(q)
    )
  })
}
