/**
 * 델타 프레임의 이진 표현 — Worker ↔ 메인 스레드 사이의 전송 형식.
 *
 * ── 왜 필요한가 ──
 *
 * 워커에서 JSON.parse 를 해도, 결과 객체를 postMessage 로 넘기면 구조화 복제
 * (structured clone)가 일어난다. 2,000~60,000개 튜플의 중첩 배열을 복제하는 건
 * JSON.parse 만큼 비쌀 수 있어서, 파싱을 옮긴 이득이 복제 비용으로 상쇄된다.
 *
 * 그래서 워커가 파싱 결과를 **타입 배열**로 다시 담고, `postMessage` 의 transfer
 * 목록으로 넘긴다. 전송된 ArrayBuffer 는 복제되지 않고 소유권만 이동한다(zero-copy).
 * 이 파일이 그 담고 푸는 규칙이다.
 *
 * ── 왜 id 를 문자열로 안 보내는가 ──
 *
 * 플릿 구성은 시작 시점에 고정이다. 그래서 초기 스냅샷의 id 배열을 인덱스 표로 쓰고,
 * 프레임에는 인덱스(Int32)만 담는다. "RB-00042" 12바이트가 4바이트가 된다.
 * 인덱스 표는 워커 시작 시 한 번만 넘긴다.
 *
 * ── 좌표를 Float64 로 두는 이유 ──
 *
 * Float32 는 유효자릿수가 약 7자리다. 경도 126.884394 는 9자리가 필요해서 Float32 에
 * 담으면 약 4e-4도, **지상 40m** 가 어긋난다. 배터리(0~100, 소수 1자리)는 Float32 로
 * 충분하지만 좌표는 안 된다 — 크기를 줄이려다 지도가 틀리면 아무 의미가 없다.
 */

import type { Robot, StatusCode } from './types'

/** 워커가 보내는 이진 프레임. 버퍼 4개를 transfer 로 넘긴다. */
export interface PackedFrame {
  seq: number
  /** 서버 타임스탬프(ms) */
  t: number
  /** 갱신 건수 */
  count: number
  /** 인덱스 표에 없는 id 개수. 조용히 버리지 않고 드러낸다. */
  unknown: number
  /** 원본 JSON 페이로드 크기(bytes). 계측용. */
  payloadBytes: number
  /**
   * 이 프레임을 담기 위해 버퍼를 **새로 할당했는지**. 계측용.
   *
   * 풀링이 실제로 동작하는지 확인하는 유일한 방법이다. 워밍업 뒤에도 매 프레임
   * true 면 풀이 비어 있다는 뜻(반납이 안 오거나 용량이 부족하다).
   */
  allocated: boolean
  /** length = count */
  idx: Int32Array
  /** length = count * 2, [lon0, lat0, lon1, lat1, ...] */
  lonLat: Float64Array
  /** length = count */
  status: Uint8Array
  /** length = count */
  battery: Float32Array
}

/** transfer 목록에 넣을 버퍼들. 순서는 상관없다. */
export function transferables(packed: PackedFrame): ArrayBuffer[] {
  return [
    packed.idx.buffer as ArrayBuffer,
    packed.lonLat.buffer as ArrayBuffer,
    packed.status.buffer as ArrayBuffer,
    packed.battery.buffer as ArrayBuffer,
  ]
}

export interface DeltaLike {
  t: number
  seq: number
  updates: Array<[string, number, number, number, number]>
}

/**
 * 한 프레임을 담는 버퍼 한 세트.
 *
 * ── 왜 풀링하는가 ──
 *
 * transfer 로 넘긴 ArrayBuffer 는 워커에서 **분리(detach)** 되므로 다시 쓸 수 없다.
 * 그래서 순진하게 구현하면 프레임마다 네 개를 새로 할당한다. 60,000대 기준 약 1.5MB
 * × 10Hz = 초당 15MB 의 할당이고, 그 GC 압력이 "파싱을 옮겨 아낀 시간" 을 잡아먹는다.
 * 실측에서 렌더가 이미 포화된 구간에서는 FPS 가 오히려 떨어졌다.
 *
 * 해결은 메인 스레드가 다 쓴 버퍼를 워커로 **되돌려 주는** 것이다. 그러면 정상
 * 상태에서 할당이 0이 된다.
 *
 * ── 용량을 플릿 크기로 고정한다 ──
 *
 * 프레임당 갱신 건수는 변하지만 플릿 크기를 넘을 수 없다. 그래서 크기별 풀을 관리하는
 * 대신 최대 용량으로 잡고 매번 앞부분만 쓴다. 재사용할 때 남은 뒷부분에 옛 데이터가
 * 있지만 `count` 만큼만 읽으므로 새지 않는다(tests 가 확인).
 */
export interface FrameBuffers {
  idx: Int32Array
  lonLat: Float64Array
  status: Uint8Array
  battery: Float32Array
}

export function createFrameBuffers(capacity: number): FrameBuffers {
  return {
    idx: new Int32Array(capacity),
    lonLat: new Float64Array(capacity * 2),
    status: new Uint8Array(capacity),
    battery: new Float32Array(capacity),
  }
}

/** 세트가 담을 수 있는 최대 갱신 건수. 분리된 버퍼는 length 가 0이 된다. */
export function bufferCapacity(buffers: FrameBuffers): number {
  return buffers.idx.length
}

/** 반납된 ArrayBuffer 들로 세트를 복원한다. 워커가 recycle 메시지에서 쓴다. */
export function frameBuffersFrom(raw: {
  idx: ArrayBuffer
  lonLat: ArrayBuffer
  status: ArrayBuffer
  battery: ArrayBuffer
}): FrameBuffers {
  return {
    idx: new Int32Array(raw.idx),
    lonLat: new Float64Array(raw.lonLat),
    status: new Uint8Array(raw.status),
    battery: new Float32Array(raw.battery),
  }
}

/**
 * 파싱된 델타 → 이진 프레임. **워커에서** 실행된다.
 *
 * `buffers` 를 주면 재사용하고, 없거나 용량이 모자라면 새로 할당한다(allocated=true).
 *
 * 인덱스 표에 없는 id 는 담지 않고 개수만 센다. 인덱스를 못 정하면 메인 스레드가
 * 어느 로봇인지 알 수 없으므로 담을 방법이 없다 — 대신 개수를 넘겨 드러낸다.
 */
export function packFrameInto(
  frame: DeltaLike,
  idToIndex: Map<string, number>,
  payloadBytes: number,
  buffers?: FrameBuffers,
): PackedFrame {
  const n = frame.updates.length
  const allocated = !buffers || bufferCapacity(buffers) < n
  const buf = allocated ? createFrameBuffers(Math.max(n, 1)) : buffers!

  let k = 0
  let unknown = 0
  for (const [id, lon, lat, statusCode, batteryPct] of frame.updates) {
    const i = idToIndex.get(id)
    if (i === undefined) {
      unknown++
      continue
    }
    buf.idx[k] = i
    buf.lonLat[k * 2] = lon
    buf.lonLat[k * 2 + 1] = lat
    buf.status[k] = statusCode
    buf.battery[k] = batteryPct
    k++
  }

  // subarray 는 같은 버퍼를 공유하는 뷰다. 그래서 transfer 로 넘겨도 버퍼 전체가
  // 이동하고, slice 처럼 복사가 일어나지 않는다. 재사용 시 뒷부분의 옛 데이터는
  // count 밖이라 읽히지 않는다.
  return {
    seq: frame.seq,
    t: frame.t,
    count: k,
    unknown,
    payloadBytes,
    allocated,
    idx: buf.idx.subarray(0, k),
    lonLat: buf.lonLat.subarray(0, k * 2),
    status: buf.status.subarray(0, k),
    battery: buf.battery.subarray(0, k),
  }
}

/** 풀 없이 매번 할당하는 변형. 테스트와 단발 호출용. */
export function packFrame(
  frame: DeltaLike,
  idToIndex: Map<string, number>,
  payloadBytes: number,
): PackedFrame {
  return packFrameInto(frame, idToIndex, payloadBytes)
}

export interface PackedApplyResult {
  changed: string[]
  unknown: number
  dropped: boolean
}

/**
 * 이진 프레임 → 로봇 Map 제자리 병합. **메인 스레드에서** 실행된다.
 *
 * `lib/delta.ts` 의 applyDelta 와 계약이 같아야 한다 — seq 역전 방어, 제자리 변경,
 * 실제로 값이 바뀐 id 만 changed 에 담기. 두 경로(메인 파싱 / 워커 파싱)가 다르게
 * 동작하면 렌더 결과가 전송 방식에 따라 달라지고, 그건 벤치마크를 무의미하게 만든다.
 * tests/frame-codec.test.ts 가 두 경로의 동일성을 확인한다.
 */
export function applyPackedFrame(
  robots: Map<string, Robot>,
  indexToId: readonly string[],
  packed: PackedFrame,
  lastSeq: number,
): PackedApplyResult {
  if (packed.seq <= lastSeq) {
    return { changed: [], unknown: 0, dropped: true }
  }

  const changed: string[] = []
  let unknown = packed.unknown

  for (let k = 0; k < packed.count; k++) {
    const id = indexToId[packed.idx[k]]
    if (id === undefined) {
      unknown++
      continue
    }
    const robot = robots.get(id)
    if (!robot) {
      unknown++
      continue
    }

    const lon = packed.lonLat[k * 2]
    const lat = packed.lonLat[k * 2 + 1]
    const statusCode = packed.status[k]
    // Float32 에 담긴 배터리는 원본과 비트가 다를 수 있다(80.1 → 80.09999...).
    // 그대로 비교하면 안 변한 로봇이 매 프레임 changed 로 잡힌다. 소수 1자리로
    // 되돌려서 서버가 보낸 값과 같은 격자에 올린다.
    const batteryPct = Math.round(packed.battery[k] * 10) / 10

    if (
      robot.lon === lon &&
      robot.lat === lat &&
      robot.statusCode === statusCode &&
      robot.battery === batteryPct
    ) {
      continue
    }

    robot.lon = lon
    robot.lat = lat
    robot.statusCode = statusCode as StatusCode
    robot.battery = batteryPct
    changed.push(id)
  }

  return { changed, unknown, dropped: false }
}
