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
 *
 * `detail` 도 같은 패턴이다. 이쪽은 하위 라우트의 page.tsx 결과이고, 라우트가
 * 바뀔 때마다 이 노드만 교체된다. 지도와 SSE 는 그대로 유지된다 —
 * 이 컴포넌트가 layout.tsx 에 있기 때문이다(layout.tsx 주석 참고).
 */
export default function FleetShell({
  initialRobots,
  meta,
  siteInfo,
  detail,
}: {
  initialRobots: Robot[]
  meta: FleetMeta
  siteInfo: ReactNode
  /** 하위 라우트(page.tsx)의 결과. /fleet 에서는 null, /fleet/[id] 에서는 상세 패널. */
  detail: ReactNode
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
          {/*
            상세 패널은 지도 위에 떠 있는 오버레이다. 사이드바처럼 자리를 차지하게
            만들면 라우트를 오갈 때마다 지도 컨테이너의 너비가 바뀌고, OL 이 캔버스를
            다시 잡으면서 화면이 튄다. 오버레이면 지도 크기가 절대 변하지 않는다.
            선택된 로봇이 없을 때 빈 패널이 공간을 먹지 않는 것도 이득이다.
          */}
          {detail}
        </div>
      </div>
    </FleetProvider>
  )
}
