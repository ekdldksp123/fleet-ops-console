'use client'

import { applyDelta } from './delta'
import type { DeltaFrame, FleetMeta, Robot } from './types'

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface FrameStats {
  seq: number
  changedCount: number
  /** 서버 tick 시각과 수신 시각의 차이 (ms) */
  latencyMs: number
  droppedFrames: number
  unknownIds: number
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
  private frameListeners = new Set<FrameListener>()
  private stateListeners = new Set<StateListener>()

  constructor(initial: readonly Robot[], meta?: FleetMeta) {
    for (const r of initial) this.robots.set(r.id, { ...r })
    this.meta = meta ?? null
  }

  /** 표 렌더용 스냅샷. 호출 시점에만 배열을 만든다. */
  list(): Robot[] {
    return Array.from(this.robots.values())
  }

  get(id: string): Robot | undefined {
    return this.robots.get(id)
  }

  connect(url = '/api/fleet/stream') {
    if (this.source) return
    this.setState('connecting')

    const es = new EventSource(url)
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
      let frame: DeltaFrame
      try {
        frame = JSON.parse(event.data) as DeltaFrame
      } catch {
        return
      }
      this.ingest(frame)
    }

    es.onerror = () => {
      // EventSource 는 브라우저가 알아서 재연결한다. 상태만 노출한다.
      this.setState(es.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting')
    }
  }

  disconnect() {
    this.source?.close()
    this.source = null
    this.setState('closed')
  }

  private ingest(frame: DeltaFrame) {
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
    }

    for (const fn of this.frameListeners) {
      try {
        fn(result.changed, stats)
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
