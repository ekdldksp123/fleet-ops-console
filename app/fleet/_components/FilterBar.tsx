'use client'

import { STATUS_LABELS, type StatusCode } from '@/lib/types'
import { useFleetUi } from '@/store/fleet-store'

/**
 * 필터는 사람이 만드는 저빈도 상태라 Zustand 에 두어도 안전하다.
 * (좌표를 여기 두면 안 되는 이유는 store/fleet-store.ts 주석 참고)
 */
export default function FilterBar() {
  const query = useFleetUi((s) => s.query)
  const setQuery = useFleetUi((s) => s.setQuery)
  const statusFilter = useFleetUi((s) => s.statusFilter)
  const setStatusFilter = useFleetUi((s) => s.setStatusFilter)

  return (
    <div className="shrink-0 border-b border-slate-800 px-3 py-2">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="ID · 이름 · 구역 검색"
        aria-label="로봇 검색"
        className="w-full rounded bg-slate-900 px-2 py-1.5 text-[11px] text-slate-200 outline-none ring-1 ring-slate-800 placeholder:text-slate-600 focus:ring-slate-600"
      />
      <div className="mt-1.5 flex flex-wrap gap-1">
        <Chip active={statusFilter === 'all'} onClick={() => setStatusFilter('all')}>
          전체
        </Chip>
        {([0, 1, 2, 3] as StatusCode[]).map((code) => (
          <Chip
            key={code}
            active={statusFilter === code}
            onClick={() => setStatusFilter(statusFilter === code ? 'all' : code)}
          >
            {STATUS_LABELS[code]}
          </Chip>
        ))}
      </div>
    </div>
  )
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
        active ? 'bg-slate-200 text-slate-900' : 'bg-slate-800/70 text-slate-400 hover:bg-slate-700'
      }`}
    >
      {children}
    </button>
  )
}
