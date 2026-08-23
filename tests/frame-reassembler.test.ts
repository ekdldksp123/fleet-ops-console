import { describe, expect, it } from 'vitest'

import { FrameReassembler } from '@/lib/frame-reassembler'
import { HEADER_BYTES, encodeFrame, encodeKeepAlive, readHeader } from '@/lib/wire-format'

const ids = ['RB-00000', 'RB-00001', 'RB-00002']
const idToIndex = new Map(ids.map((id, i) => [id, i]))

function frame(seq: number, n: number): Uint8Array {
  return encodeFrame(
    {
      t: 1000 + seq,
      seq,
      updates: Array.from({ length: n }, (_, i) => [ids[i % ids.length], 126.9 + i / 1e6, 37.2, i % 4, i] as const),
    },
    idToIndex,
  )
}

/** 프레임을 수집하는 리어셈블러. 프레임을 복사해 두어야 내부 버퍼 재사용에 영향받지 않는다. */
function collector() {
  const frames: Array<{ seq: number; count: number; firstLon: number }> = []
  const desyncs: string[] = []
  const r = new FrameReassembler({
    onFrame: (bytes, offset, header) => {
      // lonLat 은 헤더 직후에 온다. 오프셋이 맞는지 값으로 확인한다.
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset + HEADER_BYTES, 8)
      frames.push({ seq: header.seq, count: header.count, firstLon: view.getFloat64(0, true) })
    },
    onDesync: (reason) => desyncs.push(reason),
  })
  return { r, frames, desyncs }
}

/**
 * 청크 재조립.
 *
 * 스트림 청크는 프레임 경계와 무관하게 잘려 온다. 여기를 틀리면 좌표가 쓰레기가 되는데
 * 에러는 안 난다 — 로봇이 지구 반대편으로 날아가거나 NaN 이 되어 사라진다.
 * fetch 를 끼지 않고 바이트만 넣어 모든 절단 경우를 만들 수 있게 분리한 이유다.
 */
describe('이진 프레임 재조립', () => {
  it('한 청크에 프레임이 여러 개 들어와도 모두 꺼낸다', () => {
    const { r, frames } = collector()
    const a = frame(1, 2)
    const b = frame(2, 3)
    const c = frame(3, 1)

    const merged = new Uint8Array(a.length + b.length + c.length)
    merged.set(a, 0)
    merged.set(b, a.length)
    merged.set(c, a.length + b.length)
    r.push(merged)

    expect(frames.map((f) => f.seq)).toEqual([1, 2, 3])
    expect(frames.map((f) => f.count)).toEqual([2, 3, 1])
    expect(r.buffered).toBe(0)
  })

  it('바이트 단위로 쪼개 넣어도 정확히 재조립된다', () => {
    // 가장 가혹한 경우 — 헤더도 페이로드도 1바이트씩 잘려 온다.
    const { r, frames } = collector()
    const a = frame(7, 3)
    const b = frame(8, 2)
    const merged = new Uint8Array(a.length + b.length)
    merged.set(a, 0)
    merged.set(b, a.length)

    for (let i = 0; i < merged.length; i++) {
      r.push(merged.subarray(i, i + 1))
    }

    expect(frames.map((f) => f.seq)).toEqual([7, 8])
    expect(frames[0].count).toBe(3)
    expect(frames[0].firstLon).toBe(126.9)
  })

  it('헤더가 두 청크에 걸쳐 잘려도 기다린다', () => {
    // 헤더가 다 오기 전에는 byteLength 를 모르므로 프레임을 꺼낼 수 없다.
    const { r, frames } = collector()
    const a = frame(5, 2)

    r.push(a.subarray(0, 10)) // 헤더 32바이트 중 10바이트만
    expect(frames).toHaveLength(0)
    expect(r.buffered).toBe(10)

    r.push(a.subarray(10))
    expect(frames.map((f) => f.seq)).toEqual([5])
    expect(r.buffered).toBe(0)
  })

  it('프레임이 다 오기 전에는 꺼내지 않는다', () => {
    const { r, frames } = collector()
    const a = frame(9, 5)

    r.push(a.subarray(0, a.length - 1)) // 마지막 1바이트만 부족
    expect(frames).toHaveLength(0)

    r.push(a.subarray(a.length - 1))
    expect(frames.map((f) => f.seq)).toEqual([9])
  })

  it('keep-alive 는 프레임으로 넘기지 않는다', () => {
    // 델타로 취급하면 seq 0 이 역전으로 잡혀 유실 카운터가 오른다.
    const { r, frames } = collector()
    const ka = encodeKeepAlive()
    const a = frame(3, 1)

    const merged = new Uint8Array(ka.length + a.length)
    merged.set(ka, 0)
    merged.set(a, ka.length)
    r.push(merged)

    expect(frames.map((f) => f.seq)).toEqual([3])
    expect(r.buffered).toBe(0)
  })

  it('magic 이 어긋나면 desync 를 알리고 버퍼를 버린다', () => {
    // 조용히 계속 읽으면 쓰레기 좌표가 지도로 들어간다.
    const { r, frames, desyncs } = collector()
    const garbage = new Uint8Array(HEADER_BYTES)
    garbage.fill(0xab)

    r.push(garbage)

    expect(frames).toHaveLength(0)
    expect(desyncs).toHaveLength(1)
    expect(desyncs[0]).toContain('magic')
    expect(r.buffered).toBe(0)
  })

  it('desync 이후 reset 하면 정상 프레임을 다시 읽는다', () => {
    // 재연결 경로가 이 동작에 기대고 있다.
    const { r, frames, desyncs } = collector()
    r.push(new Uint8Array(HEADER_BYTES).fill(0xab))
    expect(desyncs).toHaveLength(1)

    r.reset()
    r.push(frame(11, 2))
    expect(frames.map((f) => f.seq)).toEqual([11])
  })

  it('재연결 시 reset 하지 않으면 손상된 프레임이 조용히 방출된다', () => {
    // BinaryFeed 가 readOnce 시작에서 reset 하는 이유를 못 박는다.
    //
    // 이게 이 재조립기의 가장 위험한 실패 방식이다. 끊긴 연결의 반쪽 프레임 뒤에 새
    // 스트림의 바이트가 붙으면, 옛 헤더의 byteLength 가 채워질 만큼 길이가 차서
    // **프레임이 완성된 것처럼 보인다.** magic 은 옛 헤더의 것이라 정상이고,
    // desync 도 나지 않는다. 페이로드 뒷부분만 새 스트림의 바이트로 채워진
    // 프레임이 그대로 지도로 들어간다.
    const { r, frames, desyncs } = collector()
    const a = frame(1, 3)
    r.push(a.subarray(0, 40)) // 프레임 앞 40바이트만 (여기서 연결이 끊겼다)
    expect(frames).toHaveLength(0)

    // reset 없이 새 스트림의 첫 프레임을 이어붙인다
    r.push(frame(2, 2))

    // 결과: 손상된 seq 1 이 방출되고, seq 2 는 아예 읽히지 않는다. desync 도 없다.
    expect(desyncs).toHaveLength(0)
    expect(frames.map((f) => f.seq)).toEqual([1])
    expect(frames.map((f) => f.seq)).not.toContain(2)
  })

  it('재연결 시 reset 하면 새 스트림을 정상으로 읽는다', () => {
    // 위 테스트의 대조군. BinaryFeed 가 실제로 하는 동작이다.
    const { r, frames, desyncs } = collector()
    r.push(frame(1, 3).subarray(0, 40))

    r.reset() // ← readOnce 가 연결 성립 직후 부르는 것

    r.push(frame(2, 2))
    expect(desyncs).toHaveLength(0)
    expect(frames.map((f) => f.seq)).toEqual([2])
    expect(frames[0].count).toBe(2)
  })

  it('큰 프레임을 위해 버퍼가 자란다', () => {
    const { r, frames } = collector()
    const big = frame(1, 3000)
    expect(big.length).toBeGreaterThan(64 * 1024)

    // 8KB 씩 흘려 넣는다
    for (let i = 0; i < big.length; i += 8192) {
      r.push(big.subarray(i, Math.min(i + 8192, big.length)))
    }

    expect(frames.map((f) => f.seq)).toEqual([1])
    expect(frames[0].count).toBe(3000)
  })

  it('연속 프레임의 순서와 내용이 보존된다', () => {
    const { r, frames } = collector()
    for (let seq = 1; seq <= 50; seq++) {
      const f = frame(seq, (seq % 3) + 1)
      // 절반은 두 조각으로 쪼개 넣는다
      if (seq % 2 === 0) {
        const mid = Math.floor(f.length / 2)
        r.push(f.subarray(0, mid))
        r.push(f.subarray(mid))
      } else {
        r.push(f)
      }
    }
    expect(frames.map((f) => f.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
    expect(readHeader(frame(1, 1)).seq).toBe(1) // 헬퍼 자체 확인
  })
})
