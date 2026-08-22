'use client'

import { useEffect, useState } from 'react'

import { collectAlerts, type Alert } from '@/lib/delta'
import { useFleetUi } from '@/store/fleet-store'

import { useFleet } from './FleetProvider'
import { useSelectRobot } from './useSelectRobot'

/** 경보는 지도보다 느리게 갱신해도 된다. 사람이 읽는 목록이다. */
const REFRESH_MS = 500

/** 화면에 뿌릴 최대 줄 수. 근거는 lib/delta.ts collectAlerts 주석 참고. */
const MAX_ROWS = 40

interface Snapshot {
  alerts: Alert[]
  totalErrors: number
  totalLowBattery: number
}

/**
 * 실시간 경보 목록 — Client Component.
 *
 * Parallel Route 슬롯(@alerts) 안에서 살아 있는 부분이다. 슬롯의 page.tsx 는
 * 서버에서 초기 경보를 렌더하고, 이후 갱신은 이 컴포넌트가 SSE 로 받는다.
 *
 * 경보를 클릭하면 그 로봇의 상세 라우트로 이동한다. 즉 @alerts 슬롯이
 * children 슬롯(/fleet/[id])의 내용을 바꾼다 — 두 슬롯이 독립적으로 렌더되면서도
 * 같은 라우터를 공유한다는 게 Parallel Routes 의 실제 감각이다.
 */
export default function AlertFeed({ initial }: { initial: Snapshot }) {
  const fleet = useFleet()
  const selectedId = useFleetUi((s) => s.selectedId)
  const select = useSelectRobot()
  const [snap, setSnap] = useState<Snapshot>(initial)

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
        setSnap(collectAlerts(fleet.robots.values(), MAX_ROWS))
      })
    })
  }, [fleet])

  const hidden = snap.totalErrors + snap.totalLowBattery - snap.alerts.length

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 gap-1 px-2 pb-1.5">
        <Counter label="오류" value={snap.totalErrors} tone="text-red-400" />
        <Counter label="저전력" value={snap.totalLowBattery} tone="text-amber-400" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5">
        {snap.alerts.length === 0 ? (
          <p className="px-1 py-3 text-center text-[10px] text-slate-600">경보 없음</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {snap.alerts.map((a) => (
              <li key={`${a.kind}:${a.robotId}`}>
                <button
                  onClick={() => select(a.robotId === selectedId ? null : a.robotId)}
                  aria-pressed={a.robotId === selectedId}
                  className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors ${
                    a.robotId === selectedId ? 'bg-slate-700/70' : 'hover:bg-slate-800/70'
                  }`}
                >
                  <i
                    className={`size-1.5 shrink-0 rounded-full ${
                      a.kind === 'error' ? 'bg-red-500' : 'bg-amber-400'
                    }`}
                    aria-hidden
                  />
                  <span className="font-mono text-[10px] text-slate-300">{a.robotId}</span>
                  <span className="ml-auto shrink-0 text-[9px] tabular-nums text-slate-500">
                    {a.kind === 'error' ? '오류' : `${a.battery.toFixed(0)}%`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {hidden > 0 && (
          // 잘린 개수를 반드시 보여준다. 목록이 40줄에서 끝나면 사용자는 그게
          // 전부라고 읽는다.
          <p className="px-1.5 py-1.5 text-[9px] text-slate-600">+{hidden}건 더 (상위 {MAX_ROWS}건만 표시)</p>
        )}
      </div>
    </div>
  )
}

function Counter({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex-1 rounded bg-slate-900/70 px-1.5 py-1">
      <div className="text-[9px] text-slate-500">{label}</div>
      <div className={`text-xs font-semibold tabular-nums ${tone}`}>{value.toLocaleString()}</div>
    </div>
  )
}
