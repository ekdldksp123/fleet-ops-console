'use client'

import { useEffect, useRef, useState } from 'react'

import type { FrameStats } from '@/lib/fleet-client'
import { useFleetUi } from '@/store/fleet-store'

import { useFleet } from './FleetProvider'

interface Sample {
  fps: number
  minFps: number
  frameMs: number
}

/**
 * 계측 오버레이 — README 의 before/after 표를 채우는 데 쓰는 도구.
 *
 * FPS 는 requestAnimationFrame 간격으로 잰다. rAF 는 브라우저가 실제로 화면을
 * 그린 시점에 호출되므로, 메인 스레드가 막히면 그대로 수치에 반영된다.
 * 최저 FPS(minFps)를 같이 보는 이유는 평균만 보면 끊김(스터터)이 숨기 때문이다.
 *
 * "삼킴(메인)" 은 프레임 하나를 처리하는 데 메인 스레드가 쓴 시간이다. 프레임 예산
 * 16.6ms 와 직접 비교하라고 색을 입혔다(3ms 넘으면 주의, 8ms 넘으면 위험).
 * 이 값이 Web Worker 전환의 판단 근거다 — 작으면 옮길 이유가 없다.
 */
export default function StatsOverlay() {
  const fleet = useFleet()
  const show = useFleetUi((s) => s.showStats)
  const renderMode = useFleetUi((s) => s.renderMode)
  const feedMode = useFleetUi((s) => s.feedMode)

  const [sample, setSample] = useState<Sample>({ fps: 0, minFps: 0, frameMs: 0 })
  const [stats, setStats] = useState<FrameStats | null>(null)
  const minFpsRef = useRef(Infinity)

  // 렌더 모드가 바뀌면 최저 FPS 를 리셋한다. 안 그러면 이전 모드의 스터터가
  // 새 측정치를 오염시킨다.
  useEffect(() => {
    minFpsRef.current = Infinity
  }, [renderMode])

  useEffect(() => {
    let rafId = 0
    let frames = 0
    let windowStart = performance.now()
    let prev = windowStart
    let worstFrameMs = 0

    const loop = (now: number) => {
      frames++
      const delta = now - prev
      prev = now
      if (delta > worstFrameMs) worstFrameMs = delta

      const elapsed = now - windowStart
      if (elapsed >= 500) {
        const fps = (frames * 1000) / elapsed
        const instantMin = worstFrameMs > 0 ? 1000 / worstFrameMs : 0
        if (instantMin < minFpsRef.current) minFpsRef.current = instantMin

        setSample({
          fps,
          minFps: Number.isFinite(minFpsRef.current) ? minFpsRef.current : 0,
          frameMs: worstFrameMs,
        })

        frames = 0
        windowStart = now
        worstFrameMs = 0
      }
      rafId = requestAnimationFrame(loop)
    }

    rafId = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafId)
  }, [])

  useEffect(() => {
    let lastAt = 0
    return fleet.onFrame((_changed, next) => {
      const now = performance.now()
      if (now - lastAt < 400) return
      lastAt = now
      setStats(next)
    })
  }, [fleet])

  if (!show) return null

  const fpsColor =
    sample.fps >= 50 ? 'text-green-400' : sample.fps >= 30 ? 'text-amber-400' : 'text-red-400'

  return (
    <div className="pointer-events-none absolute bottom-3 right-3 z-10 w-[218px] rounded-md bg-slate-950/85 p-2.5 font-mono text-[10px] leading-relaxed text-slate-400 ring-1 ring-slate-800 backdrop-blur">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-slate-500">렌더</span>
        <span className="text-slate-200">{renderMode === 'canvas' ? 'Canvas 2D' : 'WebGL'}</span>
      </div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-slate-500">수신</span>
        <span className="text-slate-200">
          {feedMode === 'main' ? 'SSE·메인' : feedMode === 'worker' ? 'SSE·워커' : '이진·워커'}
        </span>
      </div>
      <Row label="FPS" value={sample.fps.toFixed(1)} className={fpsColor} />
      <Row label="최저 FPS" value={sample.minFps.toFixed(1)} />
      <Row label="최장 프레임" value={`${sample.frameMs.toFixed(1)}ms`} />
      <div className="my-1.5 h-px bg-slate-800" />
      <Row label="프레임 seq" value={stats ? String(stats.seq) : '—'} />
      <Row label="갱신 대수" value={stats ? stats.changedCount.toLocaleString() : '—'} />
      <Row label="수신 지연" value={stats ? `${stats.latencyMs}ms` : '—'} />
      <Row
        label="삼킴(메인)"
        value={stats ? `${stats.ingestMs.toFixed(2)}ms` : '—'}
        className={
          stats && stats.ingestMs > 8
            ? 'text-red-400'
            : stats && stats.ingestMs > 3
              ? 'text-amber-400'
              : 'text-slate-200'
        }
      />
      <Row
        label="페이로드"
        value={stats ? `${(stats.payloadBytes / 1024).toFixed(0)}KB` : '—'}
      />
      {/*
        버퍼 할당은 워커 모드에서만 의미가 있다. 연결 직후 몇 번 오르고 멈춰야
        정상이고, 계속 오르면 풀링이 동작하지 않는 것이다.
      */}
      {feedMode !== 'main' && (
        <Row
          label="버퍼 할당"
          value={stats ? String(stats.bufferAllocs) : '—'}
          className={stats && stats.bufferAllocs > 10 ? 'text-amber-400' : 'text-slate-200'}
        />
      )}
      <Row label="유실 프레임" value={stats ? String(stats.droppedFrames) : '—'} />
    </div>
  )
}

function Row({
  label,
  value,
  className = 'text-slate-200',
}: {
  label: string
  value: string
  className?: string
}) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-slate-500">{label}</span>
      <span className={`tabular-nums ${className}`}>{value}</span>
    </div>
  )
}
