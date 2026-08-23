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
 *     그 재조립은 FrameReassembler 로 분리했다(네트워크 없이 테스트 가능하도록).
 *  2. **자동 재연결.** 끊기면 직접 다시 붙어야 한다. 지수 백오프로 구현한다.
 *
 * 이게 이진 전송의 실질적인 비용이다. 성능을 얻고 프레임워크가 해주던 일을 떠안는다.
 */

import { FrameReassembler } from './frame-reassembler'
import type { FrameHeader } from './wire-format'

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

  private readonly reassembler: FrameReassembler

  constructor(
    private readonly url: string,
    private readonly handlers: BinaryFeedHandlers,
  ) {
    this.reassembler = new FrameReassembler({
      onFrame: handlers.onFrame,
      onDesync: (reason) => {
        // 어긋난 스트림은 버리고 재연결한다. abort 가 readOnce 의 예외로 이어져
        // loop 가 백오프 후 다시 붙는다.
        console.error(`[BinaryFeed] 스트림 desync — 재연결합니다: ${reason}`)
        this.controller?.abort()
      },
    })
  }

  start() {
    this.stopped = false
    void this.loop()
  }

  stop() {
    this.stopped = true
    this.controller?.abort()
    this.controller = null
    this.reassembler.reset()
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
    // 재연결이면 이전 연결의 반쪽 프레임이 남아 있을 수 있다. 그대로 이어붙이면
    // 새 스트림의 첫 바이트가 옛 조각에 붙어 magic 불일치가 난다.
    this.reassembler.reset()

    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) this.reassembler.push(value)
    }
  }
}
