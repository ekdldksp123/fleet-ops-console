import type { ReactNode } from 'react'

/**
 * /fleet 세그먼트의 중첩 레이아웃 — Server Component.
 *
 * 헤더는 매 렌더마다 서버에서만 그려지고 클라이언트 번들에 실리지 않는다.
 * 라우트가 바뀌어도 이 레이아웃은 언마운트되지 않으므로, 나중에 /fleet/[id]
 * 상세 라우트를 추가해도 지도 인스턴스를 유지한 채 전환할 수 있다.
 */
export default function FleetLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-3 border-b border-slate-800 bg-slate-950/80 px-4 py-2.5">
        <span className="text-sm font-semibold tracking-tight text-slate-100">
          Fleet Ops Console
        </span>
        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
          App Router · Server Component 셸
        </span>
        <span className="ml-auto text-[11px] text-slate-500">
          통합관제 · 실시간 모니터링 데모
        </span>
      </header>
      <main className="min-h-0 flex-1">{children}</main>
    </div>
  )
}
