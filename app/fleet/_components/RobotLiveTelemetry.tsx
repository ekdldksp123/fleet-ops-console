'use client'

import { useEffect, useState } from 'react'

import { haversine } from '@/lib/geo'
import { STATUS_COLORS, STATUS_LABELS, type Robot } from '@/lib/types'

import { useFleet } from './FleetProvider'

/** 사람이 읽을 수 있는 주기. 지도(10Hz)와 다르게 잡는 이유는 프로젝트 원칙 그대로다. */
const REFRESH_MS = 300

interface Live {
  robot: Robot
  /** 패널을 연 시점 이후 누적 이동 거리 (m) */
  travelled: number
}

/**
 * 로봇 1대의 실시간 값 — Client Component.
 *
 * ── 이 컴포넌트가 상세 패널에 있는 이유 ──
 *
 * 서버 컴포넌트([id]/page.tsx)는 **신원**을 렌더한다: id, 이름, 소속 구역.
 * 이 값들은 안 변하므로 서버에서 한 번 그리면 끝이고 클라이언트 번들에도 안 실린다.
 *
 * 반면 좌표·상태·배터리는 10Hz 로 변한다. 이걸 서버에서 그리면 새로고침해야
 * 값이 바뀌는 죽은 화면이 된다. 그래서 **살아 있는 값만** 클라이언트로 내린다.
 *
 * 프로젝트 전체의 경계 원칙(정적은 서버, 실시간만 클라이언트)이 상세 패널 안에서
 * 한 번 더 반복되는 셈이다.
 *
 * ── 전체 플릿을 구독하지 않는다 ──
 *
 * onFrame 은 플릿 전체의 변경 통지를 받지만, 여기서는 내 로봇 하나만 읽는다.
 * 20,000대가 움직여도 이 패널의 비용은 1대분이다.
 */
export default function RobotLiveTelemetry({ id }: { id: string }) {
  const fleet = useFleet()
  const [live, setLive] = useState<Live | null>(() => {
    const robot = fleet.get(id)
    return robot ? { robot: { ...robot }, travelled: 0 } : null
  })

  useEffect(() => {
    let lastAt = 0
    let scheduled = false
    // 누적 거리는 프레임마다 재야 정확하다. 스로틀된 렌더 시점의 값만 이으면
    // 그 사이의 이동이 빠지고 직선으로 잘린다.
    let prev = fleet.get(id)
    let travelled = 0
    let prevLon = prev?.lon
    let prevLat = prev?.lat

    return fleet.onFrame(() => {
      const robot = fleet.get(id)
      if (!robot) return

      if (prevLon !== undefined && prevLat !== undefined) {
        travelled += haversine([prevLon, prevLat], [robot.lon, robot.lat])
      }
      prevLon = robot.lon
      prevLat = robot.lat

      const now = performance.now()
      if (scheduled || now - lastAt < REFRESH_MS) return
      scheduled = true
      requestAnimationFrame(() => {
        scheduled = false
        lastAt = performance.now()
        const latest = fleet.get(id)
        if (latest) setLive({ robot: { ...latest }, travelled })
      })
    })
  }, [fleet, id])

  if (!live) {
    return <p className="px-3 py-2 text-[10px] text-slate-500">실시간 데이터 없음</p>
  }

  const { robot, travelled } = live

  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      <div className="flex items-center gap-1.5">
        <i
          className="size-2 rounded-full"
          style={{ background: STATUS_COLORS[robot.statusCode] }}
          aria-hidden
        />
        <span className="text-[11px] font-medium text-slate-200">
          {STATUS_LABELS[robot.statusCode]}
        </span>
        <span className="ml-auto text-[10px] text-slate-500">실시간</span>
      </div>

      {/* 배터리는 막대로도 보여준다. 관제에서 제일 자주 보는 값이다. */}
      <div>
        <div className="flex items-baseline justify-between text-[10px]">
          <span className="text-slate-500">배터리</span>
          <span
            className={`font-semibold tabular-nums ${
              robot.battery < 20 ? 'text-red-400' : 'text-slate-200'
            }`}
          >
            {robot.battery.toFixed(1)}%
          </span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-800">
          <div
            className={`h-full transition-[width] duration-300 ${
              robot.battery < 20 ? 'bg-red-500' : 'bg-green-500'
            }`}
            style={{ width: `${Math.max(0, Math.min(100, robot.battery))}%` }}
          />
        </div>
      </div>

      <Field label="위도" value={robot.lat.toFixed(6)} />
      <Field label="경도" value={robot.lon.toFixed(6)} />
      <Field
        label="누적 이동"
        value={travelled < 1000 ? `${travelled.toFixed(0)} m` : `${(travelled / 1000).toFixed(2)} km`}
      />
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between text-[10px]">
      <span className="text-slate-500">{label}</span>
      <span className="font-mono tabular-nums text-slate-300">{value}</span>
    </div>
  )
}
