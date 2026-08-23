'use client'

import { applyDelta } from './delta'
import { applyPackedFrame, type PackedFrame } from './frame-codec'
import { IS_LITTLE_ENDIAN } from './wire-format'
import type { WorkerRequest, WorkerResponse } from './fleet.worker'
import type { DeltaFrame, FleetMeta, Robot } from './types'

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

/**
 * 델타를 어떤 경로로 받는가. 세 방식이 **같은 데이터**를 다르게 실어 온다.
 *
 *   'main'   : 메인 스레드에서 SSE + JSON.parse                    (벤치마크의 before)
 *   'worker' : 워커가 SSE + JSON.parse, 이진 프레임만 메인으로 전송
 *   'binary' : 서버가 이진으로 보내고 워커는 바이트 복사만 — **파싱 없음** (기본값)
 *
 * 앞의 둘은 "JSON 을 어디서 파싱할까" 를 다루고, 마지막은 "JSON 을 아예 안 쓴다" 다.
 * 세 방식을 나란히 둔 이유는 A/B 측정이다 — 데이터가 같아야 인코딩·스레드 차이만
 * 비교할 수 있다.
 *
 * 기본은 'binary' 다. 세 경로를 실측해 보니 이진이 모든 구간에서 메인보다 나쁘지 않고
 * 대역폭이 37% 적었다. Worker 를 못 쓰는 환경이나 빅 엔디언 플랫폼에서는 connect() 가
 * 자동으로 메인 경로로 물러난다.
 *
 * 렌더 모드(canvas 기본)와 방침이 다른 이유: 렌더는 GPU 유무에 따라 결과가 뒤집혀서
 * 기본값을 정할 수 없지만, 수신 경로는 측정이 끝났다. 측정이 끝난 축을 일부러 나쁜
 * 쪽에 고정해 둘 이유가 없다.
 */
export type FeedMode = 'main' | 'worker' | 'binary'

/** @deprecated 이진 모드가 추가되며 FeedMode 로 이름이 바뀌었다. */
export type ParseMode = FeedMode

export interface FrameStats {
  seq: number
  changedCount: number
  /** 서버 tick 시각과 수신 시각의 차이 (ms) */
  latencyMs: number
  droppedFrames: number
  unknownIds: number
  /**
   * 이 프레임을 삼키는 데 **메인 스레드가** 쓴 시간(ms).
   *
   * 메인 스레드 모드에서는 JSON.parse + applyDelta 를 모두 포함한다.
   * 워커 모드에서는 파싱이 워커에서 끝나므로 타입배열 적용 시간만 남는다.
   * 두 값의 차이가 곧 "워커로 옮긴 일의 양" 이다.
   *
   * 프레임 예산(60fps 기준 16.6ms)과 직접 비교할 수 있는 숫자라서, 파싱이 정말
   * 메인 스레드를 막고 있는지 판단하는 근거가 된다. README 가 이 확인을
   * Web Worker 착수의 전제조건으로 걸어 두었다.
   */
  ingestMs: number
  /** 페이로드 크기(bytes). 파싱 비용의 원인을 크기와 함께 봐야 판단이 된다. */
  payloadBytes: number
  /**
   * 워커가 버퍼를 새로 할당한 누적 횟수. 메인 파싱 모드에서는 항상 0.
   *
   * 풀링이 동작하는지 확인하는 유일한 지표다. 연결 직후 몇 번 오르고 그 뒤로
   * 멈춰 있어야 정상이다. 계속 오르면 반납이 안 오거나 용량이 모자라다는 뜻이다.
   */
  bufferAllocs: number
}

type FrameListener = (changed: readonly string[], stats: FrameStats) => void
type StateListener = (state: ConnectionState) => void

/**
 * 실시간 플릿 상태의 클라이언트 보관소.
 *
 * **이 파일이 이 프로젝트에서 가장 중요한 설계 결정을 담고 있다.**
 *
 * 좌표는 React state 에도, Zustand 에도 두지 않는다. 2,000대가 10Hz 로 움직이면
 * 초당 20,000번의 상태 변경이 발생하는데, 이걸 React 렌더 트리에 태우면
 * 리렌더만으로 프레임 예산이 전부 소진된다.
 *
 * 대신 이렇게 나눈다.
 *   - 좌표/상태의 **원본**: 이 클래스 안의 plain Map (React 밖)
 *   - **지도**: 프레임마다 OpenLayers 피처를 직접 변경 (리렌더 0회)
 *   - **표**: 구독을 스로틀링해 4Hz 로만 스냅샷을 뜬다 (사람 눈에는 충분)
 *   - **선택/필터/렌더모드 같은 UI 상태**: Zustand (초당 수 회 수준)
 *
 * 즉 "고빈도 데이터는 React 밖, 저빈도 UI 의사결정만 React 안" 이 원칙이다.
 */
export class FleetClient {
  readonly robots = new Map<string, Robot>()
  meta: FleetMeta | null = null

  state: ConnectionState = 'idle'
  droppedFrames = 0
  unknownIds = 0
  lastSeq = 0
  lastFrameAt = 0

  private source: EventSource | null = null
  private worker: Worker | null = null
  private frameListeners = new Set<FrameListener>()
  private stateListeners = new Set<StateListener>()

  feedMode: FeedMode = 'binary'
  private url = '/api/fleet/stream'
  /** 이진 스트림 라우트. SSE 라우트와 같은 데이터를 다른 인코딩으로 낸다. */
  private binaryUrl = '/api/fleet/binary'

  /**
   * 두 라우트에 함께 붙일 쿼리스트링. 장애 주입 테스트가 `frames=N` 을 심는 데 쓴다
   * (app/api/fleet/binary/route.ts 주석 참고). 프로덕션에서는 빈 문자열이다.
   */
  streamQuery = ''
  /** 워커가 버퍼를 새로 할당한 누적 횟수. 풀링 동작 확인용. */
  private bufferAllocs = 0

  /**
   * 인덱스 ↔ id 표. 이진 프레임이 id 대신 인덱스를 담기 때문에 필요하다.
   *
   * 생성자에서 한 번 만든다. 플릿 구성이 시작 시점에 고정이라는 가정에 기대고 있고,
   * 그 가정이 깨지면(런타임에 로봇이 추가되면) 미지의 인덱스가 unknown 으로 잡혀
   * 드러난다 — 조용히 틀리지는 않는다.
   */
  private readonly indexToId: string[] = []

  constructor(initial: readonly Robot[], meta?: FleetMeta) {
    for (const r of initial) {
      this.robots.set(r.id, { ...r })
      this.indexToId.push(r.id)
    }
    this.meta = meta ?? null
  }

  /** 표 렌더용 스냅샷. 호출 시점에만 배열을 만든다. */
  list(): Robot[] {
    return Array.from(this.robots.values())
  }

  get(id: string): Robot | undefined {
    return this.robots.get(id)
  }

  connect(url = this.url) {
    this.url = url
    if (this.source || this.worker) return

    if (this.feedMode !== 'main' && typeof Worker !== 'undefined') {
      // 빅 엔디언 플랫폼에서는 이진 페이로드의 요소 해석이 뒤집힌다. 조용히 틀리는
      // 것보다 JSON 경로로 물러나는 쪽이 낫다(lib/wire-format.ts 주석 참고).
      if (this.feedMode === 'binary' && !IS_LITTLE_ENDIAN) {
        console.warn('[FleetClient] 빅 엔디언 플랫폼 — 이진 모드를 쓸 수 없어 워커 JSON 으로 갑니다')
        this.feedMode = 'worker'
      }
      this.connectViaWorker()
      return
    }
    this.connectOnMainThread()
  }

  /**
   * 파싱 위치를 바꾼다. 연결을 끊고 새 전송 방식으로 다시 연결한다.
   *
   * 재연결 중 몇 프레임을 놓칠 수 있다. 델타 방식이라 놓친 만큼 위치가 튀지만,
   * 서버 seq 는 계속 증가하므로 이후 프레임이 버려지지는 않는다. 사람이 토글을
   * 누르는 빈도의 동작이라 이 정도 대가는 감당할 만하다.
   */
  setFeedMode(mode: FeedMode) {
    if (mode === this.feedMode) return
    const wasConnected = Boolean(this.source || this.worker)
    this.feedMode = mode
    // 전환할 때 리셋한다. 안 하면 이전 모드의 누적치가 남아 풀링 판단을 흐린다.
    this.bufferAllocs = 0
    if (!wasConnected) return
    this.teardown()
    this.connect()
  }

  private connectOnMainThread() {
    this.setState('connecting')

    const es = new EventSource(this.url + this.streamQuery)
    this.source = es

    es.addEventListener('meta', (event) => {
      try {
        this.meta = JSON.parse((event as MessageEvent<string>).data) as FleetMeta
      } catch {
        /* 무시 */
      }
    })

    es.onopen = () => this.setState('open')

    es.onmessage = (event) => {
      // 계측은 JSON.parse 를 **포함**해야 의미가 있다. 파싱이 이 경로의 주 비용일
      // 수 있다는 게 검증할 가설이므로, 파싱 밖에서 재면 가설을 비껴간다.
      const t0 = performance.now()
      const data = event.data as string
      let frame: DeltaFrame
      try {
        frame = JSON.parse(data) as DeltaFrame
      } catch {
        return
      }
      this.ingest(frame, t0, data.length)
    }

    es.onerror = () => {
      // EventSource 는 브라우저가 알아서 재연결한다. 상태만 노출한다.
      this.setState(es.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting')
    }
  }

  /**
   * 워커 경로. 파싱은 워커가 하고 메인 스레드는 이진 프레임만 적용한다.
   *
   * `new URL(..., import.meta.url)` 형태는 webpack 5 / Turbopack 이 워커 번들로
   * 인식하는 표준 구문이다. 문자열 경로를 쓰면 번들러가 추적하지 못해 프로덕션에서
   * 404 가 난다.
   */
  private connectViaWorker() {
    this.setState('connecting')

    const worker = new Worker(new URL('./fleet.worker.ts', import.meta.url))
    this.worker = worker

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data
      if (msg.type === 'state') {
        this.setState(msg.state)
        return
      }
      if (msg.type === 'meta') {
        this.meta = msg.meta as FleetMeta
        return
      }
      // 메인 스레드에서 재는 시간은 여기서 시작한다. JSON.parse 는 이미 워커에서
      // 끝났으므로 이 값에 포함되지 않는다 — 그 차이가 곧 옮긴 일의 양이다.
      this.ingestPacked(msg.packed, performance.now())
    }

    worker.onerror = (err) => {
      console.error('[FleetClient] 워커 오류, 메인 스레드로 폴백합니다', err)
      // 워커가 죽어도 화면이 멈추면 안 된다. 조용히 메인 경로로 되돌린다.
      this.teardown()
      this.feedMode = 'main'
      this.connectOnMainThread()
    }

    const encoding = this.feedMode === 'binary' ? 'binary' : 'json'
    const req: WorkerRequest = {
      type: 'start',
      url: (encoding === 'binary' ? this.binaryUrl : this.url) + this.streamQuery,
      ids: this.indexToId,
      encoding,
    }
    worker.postMessage(req)
  }

  private teardown() {
    this.source?.close()
    this.source = null
    if (this.worker) {
      const req: WorkerRequest = { type: 'stop' }
      this.worker.postMessage(req)
      this.worker.terminate()
      this.worker = null
    }
  }

  disconnect() {
    this.teardown()
    this.setState('closed')
  }

  /** 이진 프레임 적용. 메인 경로의 ingest 와 통계 계산을 공유한다. */
  private ingestPacked(packed: PackedFrame, startedAt: number) {
    if (packed.allocated) this.bufferAllocs++

    const result = applyPackedFrame(this.robots, this.indexToId, packed, this.lastSeq)

    // ⚠️ 반납은 **다 읽은 직후, 리스너 호출 전**이다. 순서가 중요하다.
    //
    //  - 더 일찍 반납하면 applyPackedFrame 이 분리된 버퍼를 읽어 전부 0이 된다.
    //    로봇이 좌표 (0,0) 으로 순간이동하는데 에러는 안 난다.
    //  - 리스너 호출 뒤로 미루면 렌더가 끝날 때까지 버퍼가 묶여, 워커가 다음
    //    프레임에서 풀을 비어 있다고 보고 새로 할당한다. 풀링의 의미가 사라진다.
    //
    // 리스너에 넘기는 것은 changed(문자열 배열)와 로봇 Map 이고, 둘 다 이미 복사된
    // 값이라 버퍼를 붙들고 있지 않다. 그래서 이 시점에 반납해도 안전하다.
    this.recycle(packed)

    if (result.dropped) {
      this.droppedFrames++
      return
    }

    this.lastSeq = packed.seq
    this.lastFrameAt = Date.now()
    this.unknownIds += result.unknown

    this.emit(result.changed, {
      seq: packed.seq,
      changedCount: result.changed.length,
      latencyMs: this.lastFrameAt - packed.t,
      droppedFrames: this.droppedFrames,
      unknownIds: this.unknownIds,
      ingestMs: performance.now() - startedAt,
      payloadBytes: packed.payloadBytes,
      bufferAllocs: this.bufferAllocs,
    })
  }

  /**
   * 다 쓴 버퍼를 워커로 되돌린다.
   *
   * transfer 목록에 네 개를 모두 넣는다 — 빼먹으면 복제가 일어나 반납 자체가
   * 비용이 된다. 워커가 이미 없으면(모드 전환·언마운트) 그냥 버린다.
   */
  private recycle(packed: PackedFrame) {
    const worker = this.worker
    if (!worker) return

    const idx = packed.idx.buffer as ArrayBuffer
    const lonLat = packed.lonLat.buffer as ArrayBuffer
    const status = packed.status.buffer as ArrayBuffer
    const battery = packed.battery.buffer as ArrayBuffer

    const req: WorkerRequest = { type: 'recycle', idx, lonLat, status, battery }
    worker.postMessage(req, [idx, lonLat, status, battery])
  }

  private ingest(frame: DeltaFrame, startedAt: number, payloadBytes: number) {
    const result = applyDelta(this.robots, frame, this.lastSeq)

    if (result.dropped) {
      this.droppedFrames++
      return
    }

    this.lastSeq = frame.seq
    this.lastFrameAt = Date.now()
    this.unknownIds += result.unknown.length

    const stats: FrameStats = {
      seq: frame.seq,
      changedCount: result.changed.length,
      latencyMs: this.lastFrameAt - frame.t,
      droppedFrames: this.droppedFrames,
      unknownIds: this.unknownIds,
      // 리스너 호출은 제외한다. 그건 렌더 쪽 비용이고 이미 FPS 로 드러난다.
      ingestMs: performance.now() - startedAt,
      payloadBytes,
      bufferAllocs: 0,
    }

    this.emit(result.changed, stats)
  }

  private emit(changed: readonly string[], stats: FrameStats) {
    for (const fn of this.frameListeners) {
      try {
        fn(changed, stats)
      } catch (err) {
        console.error('[FleetClient] frame listener 오류', err)
      }
    }
  }

  onFrame(fn: FrameListener): () => void {
    this.frameListeners.add(fn)
    return () => this.frameListeners.delete(fn)
  }

  onState(fn: StateListener): () => void {
    this.stateListeners.add(fn)
    fn(this.state)
    return () => this.stateListeners.delete(fn)
  }

  private setState(next: ConnectionState) {
    if (this.state === next) return
    this.state = next
    for (const fn of this.stateListeners) fn(next)
  }
}
