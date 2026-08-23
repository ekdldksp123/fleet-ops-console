/**
 * 델타 프레임의 **서버 전송용** 이진 포맷.
 *
 * ── 왜 JSON 을 버리는가 ──
 *
 * 앞선 최적화(5단계)는 "JSON 을 어디서 파싱할까" 를 다뤘다. 메인 스레드에서 워커로
 * 옮기면 메인 스레드의 삼킴 시간은 6~7배 줄지만, 파싱 자체가 사라지지는 않는다.
 * 실측에서 렌더가 포화된 구간에서는 워커가 코어를 점유해 FPS 가 오히려 떨어졌다.
 *
 * 진짜 해법은 애초에 JSON 을 안 쓰는 것이다. 서버가 이진 프레임을 그대로 내려보내면
 * 클라이언트는 **바이트를 복사만** 하면 된다 — 파싱이 없다.
 *
 * ── 왜 SSE 가 아니라 fetch 스트림인가 ──
 *
 * SSE 는 텍스트 전용이다. 이진을 실으려면 base64 가 필요하고 그러면 대역폭 33% 증가에
 * 디코딩 비용이 남는다. `fetch` + `ReadableStream` 으로 받으면 바이트가 그대로 온다.
 *
 * 대가가 있다. EventSource 가 공짜로 주던 **자동 재연결과 Last-Event-ID 를 잃는다.**
 * 재연결을 직접 구현해야 한다(lib/binary-feed.ts). 이 프로젝트가 SSE 를 고른 이유가
 * 바로 그 자동 재연결이었으므로, 이건 되돌리는 선택이 아니라 **교환**이다.
 *
 * ── 레이아웃 (리틀 엔디언, 헤더 32바이트) ──
 *
 *   0   u32  magic 'FLT1'    — 스트림 desync 감지
 *   4   u32  byteLength      — 헤더 포함 전체 길이 (8의 배수)
 *   8   u32  seq             — 0 이면 keep-alive (내용 없음)
 *   12  u32  count           — 갱신 건수
 *   16  f64  t               — 서버 타임스탬프(ms). 2^32 를 넘으므로 f64
 *   24  u64  reserved
 *   32  f64  lonLat[count*2] — 8바이트 정렬을 위해 **가장 먼저** 둔다
 *   ..  i32  idx[count]
 *   ..  f32  battery[count]
 *   ..  u8   status[count]
 *   ..       8의 배수까지 패딩
 *
 * lonLat 을 맨 앞에 두는 건 정렬 때문이다. Float64Array 뷰는 8바이트 정렬을 요구하고,
 * 헤더가 32바이트(8의 배수)라 그 직후가 유일하게 확실히 정렬된 위치다.
 */

/** 'FLT1' 을 리틀 엔디언 u32 로 읽은 값 */
export const MAGIC = 0x31544c46

export const HEADER_BYTES = 32

/**
 * 이 플랫폼이 리틀 엔디언인가.
 *
 * 헤더 스칼라는 DataView 로 엔디언을 명시해 읽고 쓰지만, 페이로드는 바이트를 그대로
 * 복사해 타입 배열 뷰로 해석한다 — 그 해석은 **플랫폼 엔디언**을 따른다. 빅 엔디언
 * 기기에서는 좌표가 쓰레기가 된다.
 *
 * 현실의 모든 브라우저 플랫폼은 리틀 엔디언이지만, 조용히 틀리는 것보다 확인하고
 * JSON 경로로 물러나는 쪽이 낫다(lib/fleet-client.ts 가 이 값을 본다).
 */
export const IS_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1

export interface WireUpdates {
  t: number
  seq: number
  updates: ReadonlyArray<readonly [string, number, number, number, number]>
}

/** count 건을 담는 프레임의 전체 바이트 수 (8의 배수로 올림) */
export function frameByteLength(count: number): number {
  const raw = HEADER_BYTES + count * (16 + 4 + 4 + 1)
  return Math.ceil(raw / 8) * 8
}

/** 페이로드 각 구획의 바이트 오프셋 */
export function sectionOffsets(count: number) {
  const lonLat = HEADER_BYTES
  const idx = lonLat + count * 16
  const battery = idx + count * 4
  const status = battery + count * 4
  return { lonLat, idx, battery, status }
}

/**
 * 델타 → 이진 프레임. **서버에서** 실행된다.
 *
 * 인덱스 표에 없는 id 는 담지 않는다. 클라이언트가 인덱스를 못 풀면 어느 로봇인지
 * 알 수 없으므로 담을 방법이 없다. 서버와 클라이언트가 같은 초기 스냅샷에서
 * 인덱스를 만들기 때문에 정상 상태에서는 일어나지 않는다.
 */
export function encodeFrame(
  frame: WireUpdates,
  idToIndex: ReadonlyMap<string, number>,
): Uint8Array {
  // 미지의 id 를 걸러낸 뒤 건수가 줄 수 있으므로 먼저 인덱스를 모은다.
  const n = frame.updates.length
  const bytes = new Uint8Array(frameByteLength(n))
  const view = new DataView(bytes.buffer)
  const off = sectionOffsets(n)

  const lonLat = new Float64Array(bytes.buffer, off.lonLat, n * 2)
  const idx = new Int32Array(bytes.buffer, off.idx, n)
  const battery = new Float32Array(bytes.buffer, off.battery, n)
  const status = new Uint8Array(bytes.buffer, off.status, n)

  let k = 0
  for (const [id, lon, lat, statusCode, batteryPct] of frame.updates) {
    const i = idToIndex.get(id)
    if (i === undefined) continue
    lonLat[k * 2] = lon
    lonLat[k * 2 + 1] = lat
    idx[k] = i
    battery[k] = batteryPct
    status[k] = statusCode
    k++
  }

  // 걸러진 게 있으면 구획이 앞으로 당겨져야 한다. 드문 경우라 그때만 다시 담는다.
  if (k !== n) {
    return encodeFrame(
      { t: frame.t, seq: frame.seq, updates: frame.updates.filter(([id]) => idToIndex.has(id)) },
      idToIndex,
    )
  }

  view.setUint32(0, MAGIC, true)
  view.setUint32(4, bytes.byteLength, true)
  view.setUint32(8, frame.seq, true)
  view.setUint32(12, k, true)
  view.setFloat64(16, frame.t, true)
  return bytes
}

/** keep-alive 프레임: 헤더만, seq = 0 */
export function encodeKeepAlive(): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, MAGIC, true)
  view.setUint32(4, HEADER_BYTES, true)
  view.setUint32(8, 0, true) // seq 0 = keep-alive
  view.setUint32(12, 0, true)
  return bytes
}

export interface FrameHeader {
  magic: number
  byteLength: number
  seq: number
  count: number
  t: number
}

/** 헤더만 읽는다. 프레임 전체가 도착했는지 판단하려면 byteLength 가 먼저 필요하다. */
export function readHeader(bytes: Uint8Array, offset = 0): FrameHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, HEADER_BYTES)
  return {
    magic: view.getUint32(0, true),
    byteLength: view.getUint32(4, true),
    seq: view.getUint32(8, true),
    count: view.getUint32(12, true),
    t: view.getFloat64(16, true),
  }
}

/**
 * 이진 프레임 → 정렬된 버퍼로 **바이트 복사**. 파싱이 아니다.
 *
 * 스트림 청크는 프레임 경계와 무관하게 잘려 오므로, 받은 바이트가 8바이트 정렬을
 * 만족한다고 가정할 수 없다. 그래서 타입 배열 뷰를 직접 얹지 않고 **바이트 단위로**
 * 정렬된 풀 버퍼에 복사한다. 원본 정렬과 무관하게 안전하고, 요소별 루프 없이
 * memcpy 네 번으로 끝난다.
 *
 * 복사가 남는다는 점은 정직하게 인정해야 한다. 완전한 zero-copy 를 원하면 프레임
 * 경계에 맞춰 버퍼를 미리 정렬해 받아야 하는데, 스트림 API 로는 통제할 수 없다.
 * 1.4MB memcpy 는 같은 크기의 JSON.parse 보다 자릿수가 다르게 싸다.
 */
export function copyFrameInto(
  bytes: Uint8Array,
  offset: number,
  header: FrameHeader,
  dest: { lonLat: Float64Array; idx: Int32Array; battery: Float32Array; status: Uint8Array },
): void {
  const off = sectionOffsets(header.count)
  const n = header.count

  const src = (from: number, length: number) =>
    bytes.subarray(offset + from, offset + from + length)

  new Uint8Array(dest.lonLat.buffer, dest.lonLat.byteOffset, n * 16).set(src(off.lonLat, n * 16))
  new Uint8Array(dest.idx.buffer, dest.idx.byteOffset, n * 4).set(src(off.idx, n * 4))
  new Uint8Array(dest.battery.buffer, dest.battery.byteOffset, n * 4).set(src(off.battery, n * 4))
  dest.status.set(src(off.status, n))
}
