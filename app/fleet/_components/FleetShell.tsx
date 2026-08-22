'use client'

import type { ReactNode } from 'react'

import type { FleetMeta, Robot } from '@/lib/types'

import { FleetProvider } from './FleetProvider'
import FleetMap from './FleetMap'
import FleetTable from './FleetTable'
import FilterBar from './FilterBar'
import LiveStatusBar from './LiveStatusBar'
import RenderModeToggle from './RenderModeToggle'
import StatsOverlay from './StatsOverlay'
import ZoneStatsPanel from './ZoneStatsPanel'

/**
 * 클라이언트 트리의 루트.
 *
 * `siteInfo` 를 children 성격의 prop 으로 받는 게 핵심이다. 이 노드는 서버에서
 * 이미 렌더된 Server Component 라서, 이 컴포넌트가 'use client' 임에도
 * SiteInfoPanel 의 코드는 클라이언트 번들에 들어가지 않는다.
 *
 * 만약 FleetShell 안에서 `import SiteInfoPanel from './SiteInfoPanel'` 로
 * 직접 임포트했다면 그 순간 서버 컴포넌트가 아니게 되고 번들로 딸려 온다.
 * 이 차이가 App Router 경계 설계의 전부라고 해도 과언이 아니다.
 */
export default function FleetShell({
  initialRobots,
  meta,
  siteInfo,
}: {
  initialRobots: Robot[]
  meta: FleetMeta
  siteInfo: ReactNode
}) {
  return (
    <FleetProvider initialRobots={initialRobots} meta={meta}>
      <div className="flex h-full min-h-0">
        <aside className="flex w-[380px] shrink-0 flex-col border-r border-slate-800 bg-slate-950/40">
          {siteInfo}
          <LiveStatusBar />
          <ZoneStatsPanel />
          <FilterBar />
          <FleetTable />
        </aside>

        <div className="relative min-w-0 flex-1">
          <FleetMap />
          <RenderModeToggle />
          <StatsOverlay />
        </div>
      </div>
    </FleetProvider>
  )
}
