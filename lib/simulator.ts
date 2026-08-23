import 'server-only'

import { pointInRing } from './geo'
import type { DeltaFrame, FleetMeta, Robot, RobotDelta, StatusCode } from './types'
import { ZONES, ZONE_EXTENTS, zoneRallyPoint } from './zones'

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

// 사이트 경계와 구역 폴리곤의 정본은 lib/zones.ts 다. 좌표를 여기에 또 적으면
// 두 곳이 어긋나서 폴리곤 밖에 로봇이 생기는 사고가 난다. 그래서 이 파일에는
// 사이트 좌표 상수가 하나도 남아 있지 않다 — 위치는 전부 pointInZone() 을 거친다.

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
  /** 로봇이 어느 구역 소속인지. 새 웨이포인트를 같은 구역에서 뽑기 위해 들고 있다. */
  private zoneIndexById = new Map<string, number>()
  /**
   * 정지 명령을 받은 로봇.
   *
   * 서버에만 있는 상태다. Robot 타입이나 델타 튜플에 넣지 않는다 — 튜플 형식
   * [id, lon, lat, statusCode, battery] 을 바꾸면 대역폭이 늘고 클라이언트 파서도
   * 같이 고쳐야 한다. 정지의 **결과**(statusCode 0)는 이미 델타로 전달되므로
   * 클라이언트가 알아야 할 것은 다 알고 있다.
   */
  private halted = new Set<string>()
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
    for (let i = 0; i < this.size; i++) {
      // 구역을 라운드로빈으로 배정한다. 랜덤으로 뽑으면 구역별 대수가 들쭉날쭉해서
      // 구역 집계 패널을 읽을 때 "이게 원래 그런 건지 버그인지" 판단이 어렵다.
      // 구역 면적은 서로 다르므로 대수가 같아도 밀도는 다르게 보인다.
      const zoneIndex = i % ZONES.length
      const zone = ZONES[zoneIndex]

      // 위치를 구역 **안에서** 뽑는다. 이게 이 시뮬레이터의 달라진 점이다.
      // 예전에는 사이트 전체에서 뽑고 zone 라벨을 따로 랜덤 배정했다 — 라벨과
      // 위치가 무관해서 구역 오버레이가 거짓말을 했다.
      // pointInZone 이 이미 round6 된 값을 준다. 여기서 또 반올림하면 안 된다.
      const { lon, lat } = this.pointInZone(zoneIndex)

      const roll = this.rand()
      // 이동중이 다수, 오류는 소수인 현실적인 분포
      const statusCode: StatusCode = roll < 0.62 ? 1 : roll < 0.8 ? 0 : roll < 0.96 ? 2 : 3
      const robot: Robot = {
        id: `RB-${String(i).padStart(5, '0')}`,
        name: `AMR ${String(i + 1).padStart(4, '0')}`,
        zone: zone.name,
        lon,
        lat,
        statusCode,
        battery: Math.round(20 + this.rand() * 80),
      }
      this.robots.push(robot)
      this.byId.set(robot.id, robot)
      this.zoneIndexById.set(robot.id, zoneIndex)
      this.initialDistribution[statusCode]++
      this.waypoints.push(this.pointInZone(zoneIndex))
    }
  }

  /**
   * 구역 폴리곤 내부의 임의의 점 — 거부 표집(rejection sampling).
   *
   * 바운딩 박스에서 점을 뽑고 폴리곤 안인지 확인해서, 아니면 다시 뽑는다.
   * 최악은 외곽 통로(L 자)로 bbox 대비 면적이 약 4분의 1이라 평균 4회쯤 돈다.
   *
   * MAX_TRIES 로 상한을 둔다. 폴리곤 좌표를 잘못 적어 면적이 0이 되면 이 루프가
   * 영원히 돌아 서버가 뜨지 않는다 — 무한 루프보다는 중심점 폴백이 낫고, 그런
   * 상황은 tests/zones.test.ts 가 먼저 잡아준다.
   */
  private pointInZone(zoneIndex: number): Waypoint {
    const zone = ZONES[zoneIndex]
    const e = ZONE_EXTENTS[zoneIndex]
    const MAX_TRIES = 40

    for (let t = 0; t < MAX_TRIES; t++) {
      // ⚠️ 반올림을 **먼저** 하고 그 값을 검증한다. 순서가 뒤집히면 조용히 깨진다.
      //
      // 예전에는 원본 좌표를 검증하고 round6 한 값을 저장했다. 구역 경계값이
      // 126.9217 처럼 5자리로 딱 떨어지는 수라서, 경계에서 1e-6 이내로 뽑힌 점이
      // 반올림되며 경계를 넘어갔다. 1,200대 중 2대가 라벨과 위치가 어긋났고,
      // 타일링 테스트로는 절대 안 잡혔다 — 폴리곤은 멀쩡하고 반올림이 범인이라서다.
      //
      // 규칙: 검증한 값을 저장한다. 저장할 값을 검증한다.
      const lon = round6(e.minLon + this.rand() * (e.maxLon - e.minLon))
      const lat = round6(e.minLat + this.rand() * (e.maxLat - e.minLat))
      if (pointInRing(zone.ring, lon, lat)) return { lon, lat }
    }

    // 폴백: bbox 중심. 오목 다각형이면 폴리곤 밖일 수 있지만, 여기 온 것 자체가
    // 이미 데이터 오류라서 정확도보다 "서버가 뜨는 것" 이 우선이다.
    return { lon: (e.minLon + e.maxLon) / 2, lat: (e.minLat + e.maxLat) / 2 }
  }

  meta(): FleetMeta {
    return {
      size: this.size,
      tickMs: this.tickMs,
      zones: ZONES.map((z) => z.name),
      initialDistribution: { ...this.initialDistribution },
    }
  }

  /** 초기 스냅샷. Server Component 가 직접 호출한다 (HTTP 왕복 없음). */
  snapshot(): Robot[] {
    return this.robots.map((r) => ({ ...r }))
  }

  /**
   * 로봇 1대 조회. /fleet/[id] 상세 라우트가 쓴다.
   *
   * snapshot() 으로 전체를 뜬 뒤 find 하면 20,000개 객체를 복사하고 버리는 셈이라
   * 상세 페이지를 열 때마다 그 비용을 낸다. byId 를 직접 쓴다.
   *
   * 복사해서 넘기는 이유: 원본은 tick 마다 제자리 변경되는 객체다. 그대로 넘기면
   * 서버 렌더 중에 값이 바뀔 수 있고, 클라이언트로 직렬화되는 시점의 값이
   * 렌더에 쓴 값과 달라질 수 있다.
   */
  robot(id: string): Robot | undefined {
    const found = this.byId.get(id)
    return found ? { ...found } : undefined
  }

  /**
   * 로봇 명령 — /fleet 의 Server Action 이 호출한다.
   *
   * 실제 시스템에서는 이 자리가 로봇 게이트웨이로 나가는 MQTT publish 나 gRPC
   * 호출이다. 여기서는 시뮬레이터 상태를 직접 바꾼다.
   *
   * 반환값이 boolean 인 이유: Server Action 은 공개 엔드포인트다. 없는 id 가 오면
   * 조용히 무시하지 말고 호출자에게 알려서 UI 가 실패를 표시하게 한다.
   *
   * 명령의 **결과**는 다음 tick 의 델타로 SSE 를 타고 클라이언트에 도달한다.
   * 그래서 Server Action 이 revalidatePath 를 부를 필요가 없다 — 읽기 경로가
   * 캐시가 아니라 스트림이다.
   */
  command(id: string, kind: 'halt' | 'recall'): boolean {
    const robot = this.byId.get(id)
    if (!robot) return false

    if (kind === 'halt') {
      this.halted.add(id)
      robot.statusCode = 0 // 대기
    } else {
      this.halted.delete(id)
      // 자기 구역의 집결지로 보낸다. 볼록 폴리곤의 정점 평균이라 항상 구역 내부이고,
      // 로봇이 직선으로 가도 구역을 벗어나지 않는다(lib/zones.ts zoneRallyPoint).
      //
      // 다른 구역으로 부르지 않는 이유: 구역을 넘어가는 직선 이동은 중간에 남의
      // 구역을 지나므로 "로봇의 구역 라벨과 위치가 일치한다" 는 불변식이 깨진다.
      const zoneIndex = this.zoneIndexById.get(id) ?? 0
      const [lon, lat] = zoneRallyPoint(ZONES[zoneIndex])
      const robotIndex = this.robots.indexOf(robot)
      if (robotIndex >= 0) this.waypoints[robotIndex] = { lon, lat }
      robot.statusCode = 1 // 이동중
    }

    // 다음 tick 을 기다리지 않고 즉시 델타를 흘려보낸다. 명령의 반응이 최대 tickMs
    // 만큼 늦어지면 버튼이 둔하게 느껴진다.
    const frame: DeltaFrame = {
      t: Date.now(),
      seq: ++this.seq,
      updates: [[robot.id, robot.lon, robot.lat, robot.statusCode, robot.battery]],
    }
    for (const fn of this.subscribers) {
      try {
        fn(frame)
      } catch {
        /* 구독자 하나가 죽어도 나머지 스트림은 유지한다 */
      }
    }
    return true
  }

  /** 정지 명령을 받은 상태인지. 상세 패널이 버튼 상태를 정하는 데 쓴다. */
  isHalted(id: string): boolean {
    return this.halted.has(id)
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
          // 다음 목표도 **같은 구역 안에서** 뽑는다. 이 한 줄이 로봇을 자기 구역에
          // 머물게 하고, 그래서 구역 오버레이와 구역 집계가 서로 맞는다.
          this.waypoints[i] = this.pointInZone(this.zoneIndexById.get(r.id) ?? 0)
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
        // 정지 명령을 받은 로봇은 스스로 깨어나지 않는다. 이게 없으면 "정지" 를
        // 눌러도 몇 초 뒤 알아서 움직여서 명령이 먹지 않는 것처럼 보인다.
        if (!this.halted.has(r.id) && this.rand() < 0.06) {
          r.statusCode = r.battery < 25 ? 2 : 1
          touched = true
        }
      } else if (r.statusCode === 3) {
        if (this.rand() < 0.01) {
          r.statusCode = 0 // 복구
          touched = true
        }
      }

      // 정지 중인 로봇은 아래 자동 전환에서도 빼준다. 명령이 조용히 덮이면
      // 사용자는 버튼이 안 먹는다고 판단한다.
      if (this.halted.has(r.id)) {
        if (touched) updates.push([r.id, r.lon, r.lat, r.statusCode, r.battery])
        continue
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
