/**
 * App Router 의 loading.tsx — 이 세그먼트를 Suspense 경계로 자동 감싼다.
 * page.tsx 가 스냅샷을 만드는 동안 서버가 이 셸을 먼저 스트리밍하므로
 * 사용자는 흰 화면 대신 레이아웃을 즉시 본다.
 */
export default function Loading() {
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
