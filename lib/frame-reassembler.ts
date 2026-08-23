/**
 * 이진 스트림 청크 → 완성된 프레임 재조립.
 *
 * ── 왜 별도 클래스인가 ──
 *
 * 원래 BinaryFeed 안에 있었다. 분리한 이유는 이 로직이 **가장 미묘한 버그가 사는
 * 곳**인데 fetch 를 끼고 있으면 테스트할 수 없기 때문이다.
 *
 * 스트림 청크는 프레임 경계와 무관하게 잘려 온다. 실제로 일어나는 경우들:
 *   - 한 청크에 프레임이 여러 개 (빠른 서버, 느린 리더)
 *   - 헤더 32바이트가 두 청크에 걸쳐 잘림 (길이를 아직 모른다)
 *   - 프레임 하나가 청크 수십 개에 걸침 (1.3MB 프레임)
 *
 * 이걸 틀리면 좌표가 쓰레기가 되는데 에러는 안 난다. 그래서 네트워크 없이 바이트만
 * 넣어 검증할 수 있는 형태로 뽑았다 — tests/frame-reassembler.test.ts.
 */

import { HEADER_BYTES, MAGIC, readHeader, type FrameHeader } from './wire-format'

export interface ReassemblerHandlers {
  /** 완성된 프레임 하나. bytes 는 재사용되는 내부 버퍼이므로 즉시 소비해야 한다. */
  onFrame: (bytes: Uint8Array, offset: number, header: FrameHeader) => void
  /**
   * 스트림이 어긋났다(magic 불일치·길이 이상). 호출자는 연결을 끊고 다시 붙어야 한다.
   * 여기서 조용히 계속 읽으면 쓰레기 좌표가 지도로 들어간다.
   */
  onDesync: (reason: string) => void
}

export class FrameReassembler {
  /**
   * 남은 바이트를 앞으로 당기는 방식(compaction)을 쓴다. 링 버퍼가 더 우아하지만
   * 프레임이 두 조각으로 갈라질 수 있어서 정렬 복사를 한 번 더 해야 한다.
   * 프레임 하나가 최대 1.3MB 라 compaction 의 memmove 가 더 싸다.
   */
  private buf = new Uint8Array(0)
  private len = 0

  constructor(private readonly handlers: ReassemblerHandlers) {}

  /** 버퍼에 쌓인 바이트 수. 테스트와 진단용. */
  get buffered(): number {
    return this.len
  }

  reset() {
    this.len = 0
  }

  private ensure(capacity: number) {
    if (this.buf.length >= capacity) return
    // 두 배씩 늘린다. 프레임 크기가 플릿 크기에 비례하므로 한 번 자란 뒤에는
    // 다시 자라지 않는다.
    const next = new Uint8Array(Math.max(capacity, this.buf.length * 2, 64 * 1024))
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }

  push(chunk: Uint8Array) {
    this.ensure(this.len + chunk.length)
    this.buf.set(chunk, this.len)
    this.len += chunk.length
    this.drain()
  }

  private drain() {
    let offset = 0

    while (this.len - offset >= HEADER_BYTES) {
      const header = readHeader(this.buf, offset)

      if (header.magic !== MAGIC) {
        this.len = 0
        this.handlers.onDesync(`magic 불일치 (0x${header.magic.toString(16)})`)
        return
      }
      if (header.byteLength < HEADER_BYTES) {
        this.len = 0
        this.handlers.onDesync(`프레임 길이가 헤더보다 작다 (${header.byteLength})`)
        return
      }
      // 프레임이 아직 다 안 왔다. 다음 청크를 기다린다.
      if (this.len - offset < header.byteLength) break

      // seq 0 은 keep-alive 다. 델타로 넘기면 유실 카운터가 오른다.
      if (header.seq !== 0) {
        this.handlers.onFrame(this.buf, offset, header)
      }
      offset += header.byteLength
    }

    // 남은 조각을 앞으로 당긴다.
    if (offset > 0) {
      this.buf.copyWithin(0, offset, this.len)
      this.len -= offset
    }
  }
}
