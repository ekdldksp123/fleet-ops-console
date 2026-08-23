import { describe, expect, it } from 'vitest'

import { applyPackedFrame, createFrameBuffers } from '@/lib/frame-codec'
import {
  HEADER_BYTES,
  IS_LITTLE_ENDIAN,
  MAGIC,
  copyFrameInto,
  encodeFrame,
  encodeKeepAlive,
  frameByteLength,
  readHeader,
  sectionOffsets,
  type WireUpdates,
} from '@/lib/wire-format'
import type { Robot } from '@/lib/types'

const ids = ['RB-00000', 'RB-00001', 'RB-00002', 'RB-00003']
const idToIndex = new Map(ids.map((id, i) => [id, i]))

function fleet(): Map<string, Robot> {
  return new Map(
    ids.map((id) => [
      id,
      { id, name: id, zone: 'A동 적재', lon: 126.9, lat: 37.24, statusCode: 1, battery: 80 } as Robot,
    ]),
  )
}

/**
 * 이진 와이어 포맷.
 *
 * 이 포맷이 틀리면 좌표가 **쓰레기 값**이 된다. 로봇이 지구 반대편으로 날아가거나
 * NaN 이 되어 지도에서 사라진다 — 에러는 안 난다. 오프셋 하나만 어긋나도 전부
 * 어긋나므로 왕복 검증이 필수다.
 */
describe('이진 와이어 포맷', () => {
  it('이 플랫폼은 리틀 엔디언이다', () => {
    // 페이로드는 바이트 복사 후 타입 배열로 해석하므로 플랫폼 엔디언을 따른다.
    // 빅 엔디언이면 클라이언트가 JSON 경로로 물러나야 한다.
    expect(IS_LITTLE_ENDIAN).toBe(true)
  })

  it('구획 오프셋이 정렬 요구를 만족한다', () => {
    // Float64Array 뷰는 8바이트 정렬, Int32/Float32 는 4바이트 정렬을 요구한다.
    for (const count of [0, 1, 7, 1000, 60000]) {
      const off = sectionOffsets(count)
      expect(off.lonLat % 8, `lonLat@${count}`).toBe(0)
      expect(off.idx % 4, `idx@${count}`).toBe(0)
      expect(off.battery % 4, `battery@${count}`).toBe(0)
      expect(frameByteLength(count) % 8, `총길이@${count}`).toBe(0)
    }
  })

  it('왕복 후 좌표가 정확히 보존된다', () => {
    // 좌표는 Float64 라 근사가 아니라 **정확히** 같아야 한다.
    const frame: WireUpdates = {
      t: 1787000000123,
      seq: 42,
      updates: [
        ['RB-00001', 126.884394, 37.251015, 3, 43.5],
        ['RB-00003', -122.419416, 37.774929, 2, 99.9],
      ],
    }
    const bytes = encodeFrame(frame, idToIndex)
    const header = readHeader(bytes)

    expect(header.magic).toBe(MAGIC)
    expect(header.seq).toBe(42)
    expect(header.count).toBe(2)
    expect(header.t).toBe(1787000000123)
    expect(header.byteLength).toBe(bytes.byteLength)

    const buffers = createFrameBuffers(4)
    copyFrameInto(bytes, 0, header, buffers)

    const robots = fleet()
    const result = applyPackedFrame(
      robots,
      ids,
      {
        seq: header.seq,
        t: header.t,
        count: header.count,
        unknown: 0,
        payloadBytes: bytes.byteLength,
        allocated: false,
        idx: buffers.idx.subarray(0, header.count),
        lonLat: buffers.lonLat.subarray(0, header.count * 2),
        status: buffers.status.subarray(0, header.count),
        battery: buffers.battery.subarray(0, header.count),
      },
      0,
    )

    expect(result.changed.sort()).toEqual(['RB-00001', 'RB-00003'])
    expect(robots.get('RB-00001')).toMatchObject({
      lon: 126.884394,
      lat: 37.251015,
      statusCode: 3,
      battery: 43.5,
    })
    expect(robots.get('RB-00003')).toMatchObject({ lon: -122.419416, lat: 37.774929 })
  })

  it('정렬되지 않은 위치에서 읽어도 정확하다', () => {
    // 스트림 청크는 프레임 경계와 무관하게 잘려 온다. 프레임이 버퍼의 홀수 오프셋에
    // 놓여도 바이트 복사 방식이라 결과가 같아야 한다.
    const frame: WireUpdates = {
      t: 5,
      seq: 1,
      updates: [['RB-00002', 126.884394, 37.251015, 1, 12.3]],
    }
    const bytes = encodeFrame(frame, idToIndex)

    // 3바이트 밀린 위치에 같은 프레임을 심는다
    const shifted = new Uint8Array(3 + bytes.byteLength)
    shifted.set(bytes, 3)

    const header = readHeader(shifted, 3)
    expect(header.magic).toBe(MAGIC)

    const buffers = createFrameBuffers(4)
    copyFrameInto(shifted, 3, header, buffers)

    expect(buffers.lonLat[0]).toBe(126.884394)
    expect(buffers.lonLat[1]).toBe(37.251015)
    expect(buffers.idx[0]).toBe(2)
    expect(buffers.status[0]).toBe(1)
  })

  it('빈 프레임은 헤더만이고 count 가 0이다', () => {
    const bytes = encodeFrame({ t: 1, seq: 9, updates: [] }, idToIndex)
    expect(bytes.byteLength).toBe(HEADER_BYTES)
    expect(readHeader(bytes)).toMatchObject({ seq: 9, count: 0 })
  })

  it('keep-alive 는 seq 0 으로 구분된다', () => {
    // 데이터 프레임과 섞이지 않아야 한다. seq 0 을 델타로 취급하면 유실 카운터가 오른다.
    const header = readHeader(encodeKeepAlive())
    expect(header.magic).toBe(MAGIC)
    expect(header.seq).toBe(0)
    expect(header.count).toBe(0)
    expect(header.byteLength).toBe(HEADER_BYTES)
  })

  it('인덱스 표에 없는 id 는 담기지 않는다', () => {
    const bytes = encodeFrame(
      {
        t: 1,
        seq: 1,
        updates: [
          ['RB-99999', 1, 2, 1, 50],
          ['RB-00000', 126.95, 37.25, 2, 60],
        ],
      },
      idToIndex,
    )
    const header = readHeader(bytes)
    expect(header.count).toBe(1)
    expect(header.byteLength).toBe(bytes.byteLength)

    const buffers = createFrameBuffers(4)
    copyFrameInto(bytes, 0, header, buffers)
    expect(buffers.idx[0]).toBe(0)
    expect(buffers.lonLat[0]).toBe(126.95)
  })

  it('큰 프레임도 길이와 오프셋이 일관된다', () => {
    const many = Array.from({ length: 4 }, (_, i) => [ids[i], 126.9 + i / 1e6, 37.2, i % 4, i] as const)
    const bytes = encodeFrame({ t: 1, seq: 1, updates: many }, idToIndex)
    expect(bytes.byteLength).toBe(frameByteLength(4))

    const buffers = createFrameBuffers(4)
    const header = readHeader(bytes)
    copyFrameInto(bytes, 0, header, buffers)
    for (let i = 0; i < 4; i++) {
      expect(buffers.lonLat[i * 2]).toBe(126.9 + i / 1e6)
      expect(buffers.idx[i]).toBe(i)
      expect(buffers.status[i]).toBe(i % 4)
    }
  })
})
