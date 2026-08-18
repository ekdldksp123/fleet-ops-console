import 'server-only'

import type { DeltaFrame, FleetMeta, Robot, RobotDelta, StatusCode } from './types'

/**
 * 서버 사이드 플릿 시뮬레이터.
 *
 * 실제 로봇 관제 시스템에서 이 자리는 MQTT/Kafka 컨슈머나 로봇 게이트웨이가
 * 차지한다. 여기서는 프론트엔드 성능 특성만 재현하면 되므로
 * "일정 주기로 N대의 위치·상태 델타를 밀어주는 소스" 로만 흉내 낸다.
 *
 * 설계 포인트
 *  - 결정적 PRNG(mulberry32)를 쓴다. 시드가 같으면 매 실행 같은 플릿이 나오고,
 *    그래야 렌더 방식(Canvas vs WebGL) 간 벤치마크 비교가 공정해진다.
 *  - 프로세스당 싱글턴. dev 모드 HMR 에서 인스턴스가 중복 생성되지 않도록
 *    globalThis 에 캐싱한다.
 *  - 구독자가 0명이면 tick 을 멈춘다. 탭을 닫아둔 채 CPU 를 태우지 않는다.
 */

const SITE_CENTER: [number, number] = [126.9012, 37.241]
const SITE_SPAN = 0.055 // 대략 4~5km 사방
const ZONES = ['A동 적재', 'B동 조립', 'C동 도장', 'D동 출하', '충전 스테이션', '외곽 통로']

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Waypoint {
  lon: number
  lat: number
}

type Subscriber = (frame: DeltaFrame) => void

class FleetSimulator {
  readonly size: number
  readonly tickMs: number

  private robots: Robot[] = []
  private byId = new Map<string, Robot>()
  private waypoints: Waypoint[] = []
  private subscribers = new Set<Subscriber>()
  private timer: ReturnType<typeof setInterval> | null = null
  private seq = 0
  private rand: () => number
  private readonly initialDistribution: Record<StatusCode, number> = { 0: 0, 1: 0, 2: 0, 3: 0 }

  constructor(size: number, tickMs: number, seed = 20260810) {
    this.size = size
    this.tickMs = tickMs
    this.rand = mulberry32(seed)
    this.seed()
  }

  private seed() {
    const [cLon, cLat] = SITE_CENTER
    for (let i = 0; i < this.size; i++) {
      const lon = cLon + (this.rand() - 0.5) * SITE_SPAN
      const lat = cLat + (this.rand() - 0.5) * SITE_SPAN * 0.7
      const roll = this.rand()
      // 이동중이 다수, 오류는 소수인 현실적인 분포
      const statusCode: StatusCode = roll < 0.62 ? 1 : roll < 0.8 ? 0 : roll < 0.96 ? 2 : 3
      const robot: Robot = {
        id: `RB-${String(i).padStart(5, '0')}`,
        name: `AMR ${String(i + 1).padStart(4, '0')}`,
        zone: ZONES[Math.floor(this.rand() * ZONES.length)],
        lon: round6(lon),
        lat: round6(lat),
        statusCode,
        battery: Math.round(20 + this.rand() * 80),
      }
      this.robots.push(robot)
      this.byId.set(robot.id, robot)
      this.initialDistribution[statusCode]++
      this.waypoints.push(this.newWaypoint())
    }
  }

  private newWaypoint(): Waypoint {
    const [cLon, cLat] = SITE_CENTER
    return {
      lon: cLon + (this.rand() - 0.5) * SITE_SPAN,
      lat: cLat + (this.rand() - 0.5) * SITE_SPAN * 0.7,
    }
  }

  meta(): FleetMeta {
    return {
      size: this.size,
      tickMs: this.tickMs,
      zones: [...ZONES],
      initialDistribution: { ...this.initialDistribution },
    }
  }

  /** 초기 스냅샷. Server Component 가 직접 호출한다 (HTTP 왕복 없음). */
  snapshot(): Robot[] {
    return this.robots.map((r) => ({ ...r }))
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn)
    this.start()
    return () => {
      this.subscribers.delete(fn)
      if (this.subscribers.size === 0) this.stop()
    }
  }

  private start() {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.tickMs)
    // 타이머가 프로세스 종료를 붙잡지 않도록 한다 (빌드/테스트가 매달리는 사고 방지)
    this.timer.unref?.()
  }

  private stop() {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  private tick() {
    const updates: RobotDelta[] = []

    for (let i = 0; i < this.robots.length; i++) {
      const r = this.robots[i]
      let touched = false

      if (r.statusCode === 1) {
        const wp = this.waypoints[i]
        const dLon = wp.lon - r.lon
        const dLat = wp.lat - r.lat
        const dist = Math.hypot(dLon, dLat)

        if (dist < 0.00015) {
          this.waypoints[i] = this.newWaypoint()
          if (this.rand() < 0.25) r.statusCode = 0 // 잠깐 대기
        } else {
          const step = 0.00022 + this.rand() * 0.00012
          const k = Math.min(1, step / dist)
          r.lon = round6(r.lon + dLon * k)
          r.lat = round6(r.lat + dLat * k)
        }
        r.battery = Math.max(0, round1(r.battery - 0.04))
        touched = true
      } else if (r.statusCode === 2) {
        r.battery = Math.min(100, round1(r.battery + 0.35))
        if (r.battery >= 99) r.statusCode = 1
        touched = true
      } else if (r.statusCode === 0) {
        if (this.rand() < 0.06) {
          r.statusCode = r.battery < 25 ? 2 : 1
          touched = true
        }
      } else if (r.statusCode === 3) {
        if (this.rand() < 0.01) {
          r.statusCode = 0 // 복구
          touched = true
        }
      }

      // 저배터리면 충전으로, 아주 낮은 확률로 오류 발생
      if (r.statusCode === 1 && r.battery < 15) {
        r.statusCode = 2
        touched = true
      } else if (r.statusCode !== 3 && this.rand() < 0.00025) {
        r.statusCode = 3
        touched = true
      }

      if (touched) {
        updates.push([r.id, r.lon, r.lat, r.statusCode, r.battery])
      }
    }

    if (updates.length === 0) return

    const frame: DeltaFrame = { t: Date.now(), seq: ++this.seq, updates }
    for (const fn of this.subscribers) {
      try {
        fn(frame)
      } catch {
        // 구독자 하나가 죽어도 나머지 스트림은 유지한다
      }
    }
  }
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}
function round1(n: number): number {
  return Math.round(n * 10) / 10
}

const globalRef = globalThis as unknown as { __fleetSimulator?: FleetSimulator }

export function getSimulator(): FleetSimulator {
  if (!globalRef.__fleetSimulator) {
    const size = Number(process.env.FLEET_SIZE ?? 2000)
    const tickMs = Number(process.env.FLEET_TICK_MS ?? 100)
    globalRef.__fleetSimulator = new FleetSimulator(
      Number.isFinite(size) ? size : 2000,
      Number.isFinite(tickMs) ? tickMs : 100,
    )
  }
  return globalRef.__fleetSimulator
}

export type { FleetSimulator }
