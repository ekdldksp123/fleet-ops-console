/**
 * SSE 수신 + JSON 파싱 전담 워커.
 *
 * ── 워커가 EventSource 를 직접 소유한다 ──
 *
 * `EventSource` 는 워커 전역에서도 쓸 수 있다(DedicatedWorkerGlobalScope). 그래서
 * 연결·재연결·파싱까지 전부 워커에서 끝내고, 메인 스레드에는 이진 프레임만 넘긴다.
 * 메인 스레드에서 받아 워커로 문자열을 넘기는 방식이면 문자열 복제가 한 번 더
 * 일어나므로 이득이 줄어든다.
 *
 * ── 워커가 하지 않는 일 ──
 *
 * 로봇 상태(Map)는 메인 스레드가 갖는다. 워커가 상태까지 들면 렌더할 때마다 상태를
 * 메인으로 넘겨야 하고, 그 비용이 파싱보다 크다. 워커는 **stateless 파서**다.
 *
 * 상태까지 워커로 옮기려면 SharedArrayBuffer 가 필요한데, 그건 COOP/COEP 헤더
 * (cross-origin isolation)를 요구하고 그러면 OSM 타일 이미지가 CORP 없이는 막힌다.
 * 지금 구조에서 감당할 트레이드오프가 아니다.
 */

import { packFrame, transferables, type DeltaLike } from './frame-codec'

export type WorkerRequest =
  | { type: 'start'; url: string; ids: string[] }
  | { type: 'stop' }

export type WorkerResponse =
  | { type: 'state'; state: 'connecting' | 'open' | 'reconnecting' | 'closed' }
  | { type: 'meta'; meta: unknown }
  | { type: 'frame'; packed: ReturnType<typeof packFrame> }

let source: EventSource | null = null
let idToIndex = new Map<string, number>()

const post = (msg: WorkerResponse, transfer?: ArrayBuffer[]) => {
  // self.postMessage 의 두 번째 인자가 transfer 목록이다. 이걸 빼먹으면 버퍼가
  // 복제되면서 zero-copy 이득이 사라진다 — 동작은 똑같아서 눈치채기 어렵다.
  ;(self as unknown as Worker).postMessage(msg, transfer ?? [])
}

function stop() {
  source?.close()
  source = null
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data

  if (msg.type === 'stop') {
    stop()
    post({ type: 'state', state: 'closed' })
    return
  }

  if (msg.type !== 'start') return

  stop()
  idToIndex = new Map(msg.ids.map((id, i) => [id, i]))
  post({ type: 'state', state: 'connecting' })

  const es = new EventSource(msg.url)
  source = es

  es.addEventListener('meta', (e) => {
    try {
      post({ type: 'meta', meta: JSON.parse((e as MessageEvent<string>).data) })
    } catch {
      /* 무시 */
    }
  })

  es.onopen = () => post({ type: 'state', state: 'open' })

  es.onmessage = (e) => {
    const data = e.data as string
    let frame: DeltaLike
    try {
      // 이 한 줄이 워커로 옮기려던 일이다. 60,000대 기준 약 2MB 문자열 파싱이
      // 메인 스레드의 프레임 예산을 먹고 있었다.
      frame = JSON.parse(data) as DeltaLike
    } catch {
      return
    }
    const packed = packFrame(frame, idToIndex, data.length)
    post({ type: 'frame', packed }, transferables(packed))
  }

  es.onerror = () => {
    post({
      type: 'state',
      state: es.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting',
    })
  }
}
