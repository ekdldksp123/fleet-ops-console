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
 *
 * ── 버퍼 풀링 ──
 *
 * transfer 로 넘긴 ArrayBuffer 는 여기서 분리되므로 재사용할 수 없다. 그대로 두면
 * 프레임마다 네 개를 새로 할당하고(60,000대 기준 초당 약 15MB), 그 GC 압력이 파싱을
 * 옮겨 아낀 시간을 잡아먹는다. 그래서 메인 스레드가 다 쓴 버퍼를 recycle 메시지로
 * 되돌려주고 여기서 풀에 넣는다. 정상 상태에서 할당이 0이 된다.
 */

import { BinaryFeed } from './binary-feed'
import {
  bufferCapacity,
  createFrameBuffers,
  frameBuffersFrom,
  packFrameInto,
  transferables,
  type DeltaLike,
  type FrameBuffers,
  type PackedFrame,
} from './frame-codec'
import { copyFrameInto } from './wire-format'

export type WorkerRequest =
  /** encoding: 'json' = SSE + JSON.parse, 'binary' = fetch 스트림 + 바이트 복사 */
  | { type: 'start'; url: string; ids: string[]; encoding: 'json' | 'binary' }
  | { type: 'stop' }
  /** 메인 스레드가 다 쓴 버퍼를 되돌려준다. 이 네 개도 transfer 로 온다. */
  | {
      type: 'recycle'
      idx: ArrayBuffer
      lonLat: ArrayBuffer
      status: ArrayBuffer
      battery: ArrayBuffer
    }

export type WorkerResponse =
  | { type: 'state'; state: 'connecting' | 'open' | 'reconnecting' | 'closed' }
  | { type: 'meta'; meta: unknown }
  | { type: 'frame'; packed: PackedFrame }

let source: EventSource | null = null
let feed: BinaryFeed | null = null
let idToIndex = new Map<string, number>()

/**
 * 버퍼 풀.
 *
 * 정상 상태에서는 세트 하나로 충분하다 — 메인 스레드가 프레임을 적용하고 바로
 * 반납하므로 다음 프레임 전에 돌아온다. 그래도 여유를 두는 이유는 메인 스레드가
 * 긴 렌더에 붙잡혀 반납이 늦을 때 할당으로 떨어지지 않게 하기 위함이다.
 *
 * 상한을 두지 않으면 반납이 계속 늦는 상황에서 풀이 무한히 자란다. 3개면
 * 이중 버퍼링에 여유 하나를 더한 수준이다.
 */
const POOL_MAX = 3
const pool: FrameBuffers[] = []

/** 플릿 크기. 버퍼 용량의 상한이 된다. */
let capacity = 0

function takeBuffers(): FrameBuffers | undefined {
  const reused = pool.pop()
  if (reused && bufferCapacity(reused) >= capacity) return reused
  // 용량이 모자란 세트(플릿 크기가 바뀐 경우)는 버리고 새로 만든다.
  if (capacity > 0) return createFrameBuffers(capacity)
  return reused
}

const post = (msg: WorkerResponse, transfer?: ArrayBuffer[]) => {
  // self.postMessage 의 두 번째 인자가 transfer 목록이다. 이걸 빼먹으면 버퍼가
  // 복제되면서 zero-copy 이득이 사라진다 — 동작은 똑같아서 눈치채기 어렵다.
  ;(self as unknown as Worker).postMessage(msg, transfer ?? [])
}

function stop() {
  source?.close()
  source = null
  feed?.stop()
  feed = null
  // 풀은 비운다. 연결이 끊긴 뒤에도 들고 있으면 플릿 크기가 바뀐 재연결에서
  // 낡은 용량의 세트를 재사용하게 된다.
  pool.length = 0
}

/**
 * 이진 스트림 경로 — **파싱이 없다.**
 *
 * JSON 경로는 문자열을 파싱해 객체 배열을 만들고 다시 타입 배열로 담는다. 여기서는
 * 서버가 이미 이진으로 보내므로 정렬된 풀 버퍼로 **바이트를 복사**만 한다.
 * 요소별 루프도 없고 중간 객체도 없다 — memcpy 네 번이다.
 */
function startBinary(url: string) {
  feed = new BinaryFeed(url, {
    onState: (state) => post({ type: 'state', state }),
    onFrame: (bytes, offset, header) => {
      const buffers = takeBuffers()
      const allocated = !buffers || bufferCapacity(buffers) < header.count
      const buf = allocated ? createFrameBuffers(Math.max(header.count, 1)) : buffers!

      copyFrameInto(bytes, offset, header, buf)

      const packed: PackedFrame = {
        seq: header.seq,
        t: header.t,
        count: header.count,
        unknown: 0,
        // 이진 프레임의 실제 전송 바이트 수. JSON 경로의 문자열 길이와 같은 자리에
        // 두어 계측 오버레이에서 두 인코딩의 크기를 직접 비교할 수 있다.
        payloadBytes: header.byteLength,
        allocated,
        idx: buf.idx.subarray(0, header.count),
        lonLat: buf.lonLat.subarray(0, header.count * 2),
        status: buf.status.subarray(0, header.count),
        battery: buf.battery.subarray(0, header.count),
      }
      post({ type: 'frame', packed }, transferables(packed))
    },
  })
  feed.start()
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data

  if (msg.type === 'stop') {
    stop()
    post({ type: 'state', state: 'closed' })
    return
  }

  if (msg.type === 'recycle') {
    // 풀이 꽉 차 있으면 그냥 버린다(GC 에 맡긴다). 넘치게 쌓아 두면 메모리만 먹는다.
    if (pool.length < POOL_MAX) pool.push(frameBuffersFrom(msg))
    return
  }

  if (msg.type !== 'start') return

  stop()
  idToIndex = new Map(msg.ids.map((id, i) => [id, i]))
  capacity = msg.ids.length
  post({ type: 'state', state: 'connecting' })

  if (msg.encoding === 'binary') {
    startBinary(msg.url)
    return
  }

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
    // 풀에서 세트를 꺼내 재사용한다. 없으면 packFrameInto 가 새로 할당하고
    // allocated=true 로 알려준다 — 계측 오버레이의 "버퍼 할당" 이 그 값이다.
    const packed = packFrameInto(frame, idToIndex, data.length, takeBuffers())
    post({ type: 'frame', packed }, transferables(packed))
  }

  es.onerror = () => {
    post({
      type: 'state',
      state: es.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting',
    })
  }
}
