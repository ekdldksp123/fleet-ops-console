'use client'

import { useEffect, useState } from 'react'

import { summarizeByZone, type ZoneSummary } from '@/lib/delta'
import { STATUS_COLORS, STATUS_LABELS, type StatusCode } from '@/lib/types'
import { ZONE_NAMES } from '@/lib/zones'
import { useFleetUi } from '@/store/fleet-store'

import { useFleet } from './FleetProvider'

/** LiveStatusBar 와 같은 주기. 사람 눈에는 2.5Hz 로 충분하다. */
const REFRESH_MS = 400

/**
 * 구역별 실시간 집계.
 *
 * ── 왜 이 숫자를 믿을 수 있나 ──
 *
 * `Robot.zone` 문자열을 세는데, 시뮬레이터가 로봇을 자기 구역 폴리곤 안에서만
 * 움직이게 만들어 두었다(lib/zones.ts 주석). 그래서 이 표의 숫자와 지도의 구역
 * 오버레이가 같은 이야기를 한다. 좌표로 다각형 판정을 하지 않으므로 20,000대에서도
 * 집계는 그냥 O(n) 문자열 카운트다.
 *
 * ── 왜 스로틀링하나 ──
 *
 * 이 컴포넌트는 setState 를 호출한다 = React 리렌더를 유발한다. 10Hz 프레임마다
 * 리렌더하면 지도의 프레임 예산을 React 가 먹는다. 그래서 LiveStatusBar 와 똑같이
 * 400ms + rAF 로 묶는다. 지도(리렌더 0회)와 이 패널(2.5Hz 리렌더)의 대비가
 * 이 프로젝트의 "갱신 빈도에 따라 렌더 경로를 나눈다" 원칙 그 자체다.
 */
export default function ZoneStatsPanel() {
  const fleet = useFleet()
  const query = useFleetUi((s) => s.query)
  const setQuery = useFleetUi((s) => s.setQuery)

  // ZONE_NAMES 를 순서의 정본으로 쓴다. 시뮬레이터의 meta.zones 도 같은 배열에서
  // 나온다. 서버와 어긋나면 summarizeByZone 이 모르는 구역을 뒤에 붙여 드러낸다.
  const [rows, setRows] = useState<ZoneSummary[]>(() =>
    summarizeByZone(fleet.robots.values(), ZONE_NAMES),
  )

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
        setRows(summarizeByZone(fleet.robots.values(), ZONE_NAMES))
      })
    })
  }, [fleet])

  return (
    <section className="shrink-0 border-b border-slate-800 px-3 py-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[10px] font-medium text-slate-400">구역별 현황</h3>
        <span className="text-[9px] text-slate-600">클릭하면 목록이 걸러집니다</span>
      </div>

      <div className="mt-1.5 flex flex-col gap-0.5">
        {rows.map((row) => (
          <ZoneRow
            key={row.zone}
            row={row}
            active={query === row.zone}
            // 구역 필터를 새로 만들지 않고 기존 검색어를 재사용한다. FilterBar 의
            // query 가 이미 zone 부분 일치를 지원하므로(lib/delta.ts filterRobots)
            // 스토어에 상태를 추가할 이유가 없다.
            onClick={() => setQuery(query === row.zone ? '' : row.zone)}
          />
        ))}
      </div>
    </section>
  )
}

function ZoneRow({
  row,
  active,
  onClick,
}: {
  row: ZoneSummary
  active: boolean
  onClick: () => void
}) {
  const codes = [0, 1, 2, 3] as StatusCode[]

  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      title={codes.map((c) => `${STATUS_LABELS[c]} ${row.byStatus[c]}`).join(' · ')}
      className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors ${
        active ? 'bg-slate-700/70' : 'hover:bg-slate-800/60'
      }`}
    >
      <span className="w-[68px] shrink-0 truncate text-[10px] text-slate-300">{row.zone}</span>

      {/* 상태 구성을 누적 막대로 보여준다. 숫자 4개를 나란히 놓는 것보다
          "어느 구역이 오류가 많은지" 가 한눈에 들어온다. */}
      <span className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-slate-900">
        {row.total > 0 &&
          codes.map((code) => (
            <i
              key={code}
              className="h-full"
              style={{
                width: `${(row.byStatus[code] / row.total) * 100}%`,
                background: STATUS_COLORS[code],
              }}
            />
          ))}
      </span>

      <span className="w-8 shrink-0 text-right text-[10px] font-semibold tabular-nums text-slate-200">
        {row.total}
      </span>

      {/* 오류 대수는 따로 뽑는다. 관제에서 제일 먼저 봐야 하는 숫자다. */}
      <span
        className={`w-6 shrink-0 text-right text-[10px] tabular-nums ${
          row.byStatus[3] > 0 ? 'text-red-400' : 'text-slate-700'
        }`}
      >
        {row.byStatus[3]}
      </span>
    </button>
  )
}
