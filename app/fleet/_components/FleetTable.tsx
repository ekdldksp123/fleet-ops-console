'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

import { filterRobots } from '@/lib/delta'
import { STATUS_COLORS, STATUS_LABELS, type Robot, type StatusCode } from '@/lib/types'
import { useFleetUi } from '@/store/fleet-store'

import { useFleet } from './FleetProvider'
import { useSelectRobot } from './useSelectRobot'

/**
 * 표 갱신 주기(ms).
 *
 * 지도는 매 프레임(10Hz) 갱신하지만 표는 4Hz 로 낮춘다. 숫자가 초당 10번
 * 바뀌면 사람은 읽지 못하고 React 리렌더 비용만 든다. "모든 UI 가 같은 주기로
 * 갱신될 필요는 없다" 는 게 실시간 대시보드의 기본 원칙이다.
 */
const TABLE_REFRESH_MS = 250

export default function FleetTable() {
  const fleet = useFleet()
  const parentRef = useRef<HTMLDivElement>(null)

  const [rows, setRows] = useState<Robot[]>(() => fleet.list())
  const statusFilter = useFleetUi((s) => s.statusFilter)
  const query = useFleetUi((s) => s.query)
  const selectedId = useFleetUi((s) => s.selectedId)
  // 스토어 갱신 + /fleet/[id] 이동을 함께 한다. 이유는 useSelectRobot 주석 참고.
  const select = useSelectRobot()

  // ── 스로틀된 구독 ────────────────────────────────────────────────────────
  useEffect(() => {
    let scheduled = false
    let lastAt = 0

    const unsubscribe = fleet.onFrame(() => {
      const now = performance.now()
      if (scheduled || now - lastAt < TABLE_REFRESH_MS) return
      scheduled = true
      requestAnimationFrame(() => {
        scheduled = false
        lastAt = performance.now()
        // 로봇 객체는 제자리 변경되므로 배열만 새로 만들어 렌더를 트리거한다.
        setRows(fleet.list())
      })
    })
    return unsubscribe
  }, [fleet])

  const filtered = useMemo(
    () => filterRobots(rows, { statusFilter, query }),
    [rows, statusFilter, query],
  )

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36,
    overscan: 8,
  })

  // 지도에서 선택한 로봇으로 목록을 스크롤 (양방향 연동)
  useEffect(() => {
    if (!selectedId) return
    const index = filtered.findIndex((r) => r.id === selectedId)
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center' })
    // filtered 가 4Hz 로 바뀌므로 의존성에서 뺀다. selectedId 변화에만 반응.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 py-1.5 text-[10px] text-slate-500">
        <span>
          {filtered.length.toLocaleString()} / {rows.length.toLocaleString()} 대
        </span>
        <span>{TABLE_REFRESH_MS}ms 스로틀</span>
      </div>

      <div ref={parentRef} className="scroll-stable min-h-0 flex-1 overflow-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const robot = filtered[item.index]
            if (!robot) return null
            const isSelected = robot.id === selectedId
            return (
              <button
                key={robot.id}
                onClick={() => select(isSelected ? null : robot.id)}
                className={`absolute left-0 flex w-full items-center gap-2 px-3 text-left text-[11px] transition-colors ${
                  isSelected ? 'bg-amber-500/15 text-amber-100' : 'hover:bg-slate-800/60'
                }`}
                style={{ top: item.start, height: item.size }}
              >
                <i
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: STATUS_COLORS[robot.statusCode] }}
                  aria-hidden
                />
                <span className="w-[74px] shrink-0 font-mono text-slate-300">{robot.id}</span>
                <span className="w-[68px] shrink-0 truncate text-slate-500">{robot.zone}</span>
                <span className="w-[44px] shrink-0 text-slate-400">
                  {STATUS_LABELS[robot.statusCode]}
                </span>
                <span
                  className={`ml-auto shrink-0 tabular-nums ${
                    robot.battery < 20 ? 'text-red-400' : 'text-slate-400'
                  }`}
                >
                  {robot.battery.toFixed(0)}%
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <StatusLegend />
    </div>
  )
}

function StatusLegend() {
  return (
    <div className="flex shrink-0 flex-wrap gap-x-3 gap-y-1 border-t border-slate-800 px-3 py-1.5">
      {([0, 1, 2, 3] as StatusCode[]).map((code) => (
        <span key={code} className="flex items-center gap-1 text-[10px] text-slate-500">
          <i className="size-2 rounded-full" style={{ background: STATUS_COLORS[code] }} />
          {STATUS_LABELS[code]}
        </span>
      ))}
    </div>
  )
}
