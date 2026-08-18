import type { Metadata } from 'next'

import { summarize } from '@/lib/delta'
import { getSimulator } from '@/lib/simulator'

import FleetShell from './_components/FleetShell'
import SiteInfoPanel from './_components/SiteInfoPanel'

/**
 * /fleet 페이지 — Server Component.
 *
 * 여기서 하는 일과 하지 않는 일이 이 프로젝트의 핵심 경계다.
 *
 *  ✅ 서버에서: 초기 스냅샷 조회, 초기 집계, 정적 사이트 메타데이터 렌더
 *     → 이 코드와 데이터는 클라이언트 번들에 실리지 않는다.
 *  ❌ 서버에서 하지 않는 것: 실시간 갱신. 지도와 표는 브라우저 API(Canvas/WebGL,
 *     EventSource)가 필요하므로 Client Component 로 내려보낸다.
 *
 * 결과적으로 "초기 스냅샷은 서버, 실시간 갱신 레이어만 클라이언트" 라는
 * 구조가 코드로 드러난다.
 */

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  // generateMetadata 는 App Router 전용 API 다. Pages Router 의 next/head 와 달리
  // 서버에서 실행되므로 시뮬레이터를 직접 읽어 제목을 만들 수 있다.
  const meta = getSimulator().meta()
  return {
    title: `Fleet Ops Console — ${meta.size.toLocaleString()}대 실시간 관제`,
    description: `${meta.zones.length}개 구역 ${meta.size.toLocaleString()}대 AMR 플릿의 실시간 위치·상태 모니터링`,
  }
}

export default async function FleetPage() {
  const simulator = getSimulator()
  const snapshot = simulator.snapshot()
  const meta = simulator.meta()
  const initialSummary = summarize(snapshot)

  return (
    <FleetShell
      initialRobots={snapshot}
      meta={meta}
      // ⬇︎ Server Component 를 prop 으로 주입한다 (composition 패턴).
      // FleetShell 은 'use client' 지만, 이 노드는 서버에서 이미 렌더된 결과라
      // SiteInfoPanel 의 코드는 클라이언트 번들에 포함되지 않는다.
      siteInfo={<SiteInfoPanel meta={meta} summary={initialSummary} />}
    />
  )
}
