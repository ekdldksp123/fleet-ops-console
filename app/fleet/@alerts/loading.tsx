import AlertRail from '../_components/AlertRail'

/**
 * @alerts 슬롯만 덮는 Suspense 폴백.
 *
 * 이게 Parallel Routes 의 실질적 이득이다. 경보 조회가 느려도 지도·목록은 이미
 * 보이고, 스켈레톤은 이 레일 안에만 나타난다.
 */
export default function Loading() {
  return (
    <AlertRail>
      <div className="flex animate-pulse flex-col gap-1 px-2">
        <div className="flex gap-1">
          <div className="h-8 flex-1 rounded bg-slate-800/70" />
          <div className="h-8 flex-1 rounded bg-slate-800/70" />
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-5 rounded bg-slate-800/40" />
        ))}
      </div>
    </AlertRail>
  )
}
