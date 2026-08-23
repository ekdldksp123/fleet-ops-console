/**
 * 이진 스트림 수신 — 청크 재조립 + 재연결.
 *
 * ── EventSource 를 잃고 직접 해야 하는 일 ──
 *
 * `fetch` + `ReadableStream` 은 바이트를 그대로 주지만, EventSource 가 공짜로 주던
 * 두 가지를 잃는다.
 *
 *  1. **프레임 경계.** SSE 는 `\n\n` 으로 메시지를 끊어 준다. 이진 스트림의 청크는
 *     프레임과 무관하게 잘려 온다 — 한 청크에 프레임이 3개 반 들어 있을 수 있다.
 *     그래서 길이 접두(헤더의 byteLength)를 보고 직접 이어붙인다.
 *  2. **자동 재연결.** 끊기면 직접 다시 붙어야 한다. 지수 백오프로 구현한다.
 *
 * 이게 이진 전송의 실질적인 비용이다. 성능을 얻고 프레임워크가 해주던 일을 떠안는다.
 */

import { HEADER_BYTES, MAGIC, readHeader, type FrameHeader } from './wire-format'

export interface BinaryFeedHandlers {
  onFrame: (bytes: Uint8Array, offset: number, header: FrameHeader) => void
  onState: (state: 'connecting' | 'open' | 'reconnecting' | 'closed') => void
}

/** 재연결 백오프. 즉시 → 0.5s → 1s → 2s → 4s (상한) */
const BACKOFF_MS = [0, 500, 1000, 2000, 4000]

export class BinaryFeed {
  private controller: AbortController | null = null
  private stopped = false
  private attempt = 0

  /**
   * 재조립 버퍼.
   *
   * 남은 바이트를 앞으로 당기는 방식(compaction)을 쓴다. 링 버퍼가 더 우아하지만
   * 프레임을 읽을 때 두 조각으로 갈라질 수 있어서, 정렬 복사를 한 번 더 해야 한다.
   * 프레임 하나가 최대 1.5MB 라 compaction 의 memmove 가 더 싸다.
   */
  private buf = new Uint8Array(0)
  private len = 0

  constructor(
    private readonly url: string,
    private readonly handlers: BinaryFeedHandlers,
  ) {}

  start() {
    this.stopped = false
    void this.loop()
  }

  stop() {
    this.stopped = true
    this.controller?.abort()
    this.controller = null
    this.buf = new Uint8Array(0)
    this.len = 0
    this.handlers.onState('closed')
  }

  private async loop() {
    while (!this.stopped) {
      const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      if (this.stopped) return

      this.handlers.onState(this.attempt === 0 ? 'connecting' : 'reconnecting')

      try {
        await this.readOnce()
        // 정상 종료(서버가 스트림을 닫음)도 재연결 대상이다. 관제 화면은 끊긴 채로
        // 남아 있으면 안 된다.
        this.attempt = Math.min(this.attempt + 1, BACKOFF_MS.length - 1)
      } catch (err) {
        if (this.stopped) return
        this.attempt = Math.min(this.attempt + 1, BACKOFF_MS.length - 1)
        console.warn('[BinaryFeed] 스트림 끊김, 재연결합니다', err)
      }
    }
  }

  private async readOnce() {
    const controller = new AbortController()
    this.controller = controller

    const res = await fetch(this.url, {
      signal: controller.signal,
      // 캐시를 타면 스트림이 아니라 완결된 응답을 기다리게 된다.
      cache: 'no-store',
    })
    if (!res.ok || !res.body) throw new Error(`이진 스트림 응답 오류: ${res.status}`)

    // 연결이 성립하면 백오프를 초기화한다. 안 하면 짧게 여러 번 끊긴 뒤
    // 재연결 간격이 계속 4초에 머문다.
    this.attempt = 0
    this.handlers.onState('open')
    this.len = 0

    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) this.push(value)
    }
  }

  private ensure(capacity: number) {
    if (this.buf.length >= capacity) return
    // 두 배씩 늘린다. 프레임 크기가 플릿 크기에 비례해 커지므로 한 번 자란 뒤에는
    // 다시 자라지 않는다.
    const next = new Uint8Array(Math.max(capacity, this.buf.length * 2, 64 * 1024))
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }

  private push(chunk: Uint8Array) {
    this.ensure(this.len + chunk.length)
    this.buf.set(chunk, this.len)
    this.len += chunk.length
    this.drain()
  }

  /** 버퍼에서 완성된 프레임을 모두 꺼낸다. */
  private drain() {
    let offset = 0

    while (this.len - offset >= HEADER_BYTES) {
      const header = readHeader(this.buf, offset)

      if (header.magic !== MAGIC) {
        // 스트림이 어긋났다. 여기서 조용히 계속 읽으면 쓰레기 좌표가 지도로 들어간다.
        // 버퍼를 버리고 재연결하는 쪽이 안전하다.
        console.error('[BinaryFeed] 프레임 magic 불일치 — 스트림을 리셋합니다')
        this.len = 0
        this.controller?.abort()
        return
      }
      if (header.byteLength < HEADER_BYTES) {
        console.error('[BinaryFeed] 프레임 길이가 헤더보다 작습니다 — 리셋')
        this.len = 0
        this.controller?.abort()
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
