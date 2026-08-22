import type { Metadata } from 'next'

import { getSimulator } from '@/lib/simulator'

/**
 * /fleet 인덱스 페이지 — Server Component.
 *
 * 아무것도 렌더하지 않는다. 화면의 거의 전부(사이드바·지도·계측)는 이제
 * layout.tsx 의 FleetShell 이 담당하고, page.tsx 는 **상세 패널 슬롯**만 채운다.
 * 선택된 로봇이 없는 이 라우트에서는 그 슬롯이 비어 있는 게 맞다.
 *
 * "페이지가 비어 있다" 가 이상해 보이지만, 이 구조가 정확히 의도한 것이다.
 * page.tsx 는 라우트가 바뀔 때 교체되는 부분이고, 유지되어야 하는 것(지도·SSE)은
 * 전부 레이아웃에 있다. 자세한 이유는 layout.tsx 주석 참고.
 */

export async function generateMetadata(): Promise<Metadata> {
  // generateMetadata 는 App Router 전용 API 다. Pages Router 의 next/head 와 달리
  // 서버에서 실행되므로 시뮬레이터를 직접 읽어 제목을 만들 수 있다.
  const meta = getSimulator().meta()
  return {
    title: `Fleet Ops Console — ${meta.size.toLocaleString()}대 실시간 관제`,
    description: `${meta.zones.length}개 구역 ${meta.size.toLocaleString()}대 AMR 플릿의 실시간 위치·상태 모니터링`,
  }
}

export default function FleetIndexPage() {
  return null
}
