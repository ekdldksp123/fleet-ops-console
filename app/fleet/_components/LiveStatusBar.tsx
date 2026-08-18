'use client'

import { useEffect, useState } from 'react'

import { summarize, type FleetSummary } from '@/lib/delta'
import { STATUS_COLORS, STATUS_LABELS, type StatusCode } from '@/lib/types'
import type { ConnectionState } from '@/lib/fleet-client'

import { useFleet } from './FleetProvider'

const REFRESH_MS = 400

const STATE_LABEL: Record<ConnectionState, string> = {
  idle: '대기',
  connecting: '연결 중',
  open: '수신 중',
  reconnecting: '재연결 중',
  closed: '끊김',
}

const STATE_COLOR: Record<ConnectionState, string> = {
  idle: 'bg-slate-500',
  connecting: 'bg-amber-400',
  open: 'bg-green-400',
  reconnecting: 'bg-amber-400',
  closed: 'bg-red-500',
}

/**
 * 실시간으로 흔들리는 집계는 여기(Client)에서 담당한다.
 * 서버 컴포넌트인 SiteInfoPanel 은 초기 스냅샷만 보여준다 — 역할이 다르다.
 */
export default function LiveStatusBar() {
  const fleet = useFleet()
  const [summary, setSummary] = useState<FleetSummary>(() => summarize(fleet.robots.values()))
  const [state, setState] = useState<ConnectionState>(fleet.state)

  useEffect(() => fleet.onState(setState), [fleet])

  useEffect(() => {
    let lastAt = 0
    let scheduled = false
    return fleet.onFrame(() => {
      const now = performance.now()
      if (scheduled || now - lastAt < REFRESH_MS) return
      scheduled = true
      requestAnimationFrame(() => {
        scheduled = false
        lastAt = performance.now()
        setSummary(summarize(fleet.robots.values()))
      })
    })
  }, [fleet])

  return (
    <section className="shrink-0 border-b border-slate-800 px-3 py-2">
      <div className="flex items-center gap-1.5">
        <span className={`size-1.5 rounded-full ${STATE_COLOR[state]}`} aria-hidden />
        <span className="text-[10px] font-medium text-slate-400">
          SSE {STATE_LABEL[state]}
        </span>
        <span className="ml-auto text-[10px] text-slate-500">
          저전력 <span className="tabular-nums text-amber-400">{summary.lowBattery}</span>대 · 평균{' '}
          <span className="tabular-nums">{summary.avgBattery.toFixed(1)}%</span>
        </span>
      </div>

      <div className="mt-1.5 grid grid-cols-4 gap-1">
        {([0, 1, 2, 3] as StatusCode[]).map((code) => (
          <div key={code} className="rounded bg-slate-900/60 px-1.5 py-1">
            <div className="flex items-center gap-1 text-[9px] text-slate-500">
              <i className="size-1.5 rounded-full" style={{ background: STATUS_COLORS[code] }} />
              {STATUS_LABELS[code]}
            </div>
            <div className="text-xs font-semibold tabular-nums text-slate-200">
              {summary.byStatus[code]}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
