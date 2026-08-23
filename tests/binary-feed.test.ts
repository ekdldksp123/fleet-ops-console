import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BinaryFeed } from '@/lib/binary-feed'
import { encodeFrame } from '@/lib/wire-format'

const idToIndex = new Map([['RB-00000', 0]])

function frameBytes(seq: number): Uint8Array {
  return encodeFrame({ t: 1000, seq, updates: [['RB-00000', 126.9, 37.2, 1, 50]] }, idToIndex)
}

/** 프레임 하나를 흘리고 끝나는 스트림 응답 */
function okResponse(seqs: number[]) {
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        let i = 0
        return {
          read: async () =>
            i < seqs.length ? { done: false, value: frameBytes(seqs[i++]) } : { done: true },
        }
      },
    },
  } as unknown as Response
}

/**
 * 이진 스트림 재연결 루프.
 *
 * EventSource 를 버린 대가로 직접 구현한 부분이다. 손으로 만든 재연결은 "끊기면 그냥
 * 멈추는" 방식으로 조용히 실패한다 — 에러도 없고 화면은 마지막 프레임 그대로
 * 얼어붙는다.
 *
 * e2e 는 서버가 스트림을 닫는 경우를 덮는다(`?frames=N`). 여기서는 fetch 자체가
 * **거부되는 경우**(서버 다운, DNS 실패, 네트워크 없음)를 덮는다. 실제 서버를 죽이고
 * 살리는 스크립트로도 시도했지만 프로세스 조율이 불안정해서, fetch 를 스텁해
 * 결정적으로 재현하는 쪽을 골랐다.
 */
describe('BinaryFeed 재연결', () => {
  let feed: BinaryFeed | null = null

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    feed?.stop()
    feed = null
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('첫 연결에서 프레임을 전달한다', async () => {
    const seen: number[] = []
    vi.stubGlobal('fetch', vi.fn(async () => okResponse([1, 2, 3])))

    feed = new BinaryFeed('/api/fleet/binary', {
      onFrame: (_b, _o, header) => seen.push(header.seq),
      onState: () => {},
    })
    feed.start()
    await vi.advanceTimersByTimeAsync(50)

    expect(seen).toEqual([1, 2, 3])
  })

  it('fetch 가 거부되면 백오프로 재시도하고, 살아나면 복구된다', async () => {
    // 서버 다운 → 연결 거부가 세 번, 그 뒤 정상.
    const seen: number[] = []
    const states: string[] = []
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        if (calls <= 3) throw new Error('connection refused')
        return okResponse([10, 11])
      }),
    )

    feed = new BinaryFeed('/api/fleet/binary', {
      onFrame: (_b, _o, header) => seen.push(header.seq),
      onState: (s) => states.push(s),
    })
    feed.start()

    // 백오프는 0 → 500 → 1000 → 2000 이므로 3.5초면 네 번째 시도까지 도달한다.
    await vi.advanceTimersByTimeAsync(4000)

    expect(calls).toBeGreaterThanOrEqual(4)
    // 스트림이 끝나면 또 붙으므로 같은 프레임이 반복된다 — 그게 정상이다.
    // 요점은 "거부 구간을 지나 프레임이 오기 시작했는가" 다.
    expect(seen.length, '서버가 살아난 뒤에도 프레임을 못 받았다').toBeGreaterThanOrEqual(2)
    expect(seen.slice(0, 2)).toEqual([10, 11])
    // 끊긴 상태가 밖으로 드러나야 한다. 안 그러면 UI 가 "수신 중" 을 유지한다.
    expect(states).toContain('reconnecting')
    expect(states).toContain('open')
  })

  it('스트림이 정상 종료돼도 다시 붙는다', async () => {
    // 서버가 스트림을 닫는 경우(프록시 타임아웃 등). 여기서 멈추면 화면이 얼어붙는다.
    const seen: number[] = []
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        return okResponse([calls])
      }),
    )

    feed = new BinaryFeed('/api/fleet/binary', {
      onFrame: (_b, _o, header) => seen.push(header.seq),
      onState: () => {},
    })
    feed.start()
    await vi.advanceTimersByTimeAsync(6000)

    expect(calls).toBeGreaterThan(2)
    expect(seen.length).toBeGreaterThan(2)
  })

  it('HTTP 오류 응답도 재시도 대상이다', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        if (calls <= 2) return { ok: false, status: 503, body: null } as unknown as Response
        return okResponse([99])
      }),
    )

    const seen: number[] = []
    feed = new BinaryFeed('/api/fleet/binary', {
      onFrame: (_b, _o, header) => seen.push(header.seq),
      onState: () => {},
    })
    feed.start()
    await vi.advanceTimersByTimeAsync(3000)

    // 503 두 번을 지나 정상 응답에 도달했는지가 요점이다.
    expect(seen).toContain(99)
    expect(calls).toBeGreaterThan(2)
  })

  it('stop 하면 더 이상 재시도하지 않는다', async () => {
    // 언마운트·모드 전환에서 루프가 남으면 좀비 연결이 쌓인다.
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        throw new Error('down')
      }),
    )

    const states: string[] = []
    feed = new BinaryFeed('/api/fleet/binary', {
      onFrame: () => {},
      onState: (s) => states.push(s),
    })
    feed.start()
    await vi.advanceTimersByTimeAsync(1200)
    const callsAtStop = calls

    feed.stop()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(calls).toBe(callsAtStop)
    expect(states.at(-1)).toBe('closed')
  })

  it('재연결이 성공하면 백오프가 초기화된다', async () => {
    // 안 하면 짧게 여러 번 끊긴 뒤 재연결 간격이 계속 상한(4초)에 머문다.
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        // 두 번 실패 → 성공 → 다시 실패. 마지막 실패의 대기가 짧아야 한다.
        if (calls === 1 || calls === 2 || calls === 4) throw new Error('down')
        return okResponse([calls])
      }),
    )

    const seen: number[] = []
    feed = new BinaryFeed('/api/fleet/binary', {
      onFrame: (_b, _o, header) => seen.push(header.seq),
      onState: () => {},
    })
    feed.start()
    // 0 + 500 + (성공) + 0 + ... 백오프가 초기화되면 5초 안에 여러 번 성공한다.
    await vi.advanceTimersByTimeAsync(5000)

    expect(seen.length, '백오프가 초기화되지 않아 재연결이 느리다').toBeGreaterThanOrEqual(2)
  })
})
