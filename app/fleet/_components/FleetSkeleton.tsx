/**
 * 초기 로딩 스켈레톤 — Server Component.
 *
 * 두 곳에서 쓴다.
 *   - layout.tsx 의 Suspense fallback (스냅샷 조회 중)
 *   - loading.tsx (세그먼트 전환 중)
 *
 * 한쪽에만 두고 복사하면 두 폴백의 모양이 갈라진다.
 */
export default function FleetSkeleton() {
  return (
    <div className="flex h-full animate-pulse">
      <div className="flex w-[380px] shrink-0 flex-col gap-2 border-r border-slate-800 p-3">
        <div className="h-8 rounded bg-slate-800/70" />
        <div className="h-6 w-2/3 rounded bg-slate-800/50" />
        <div className="mt-2 flex-1 space-y-1.5">
          {Array.from({ length: 14 }).map((_, i) => (
            <div key={i} className="h-9 rounded bg-slate-800/40" />
          ))}
        </div>
      </div>
      <div className="flex-1 bg-slate-900/60" />
    </div>
  )
}
