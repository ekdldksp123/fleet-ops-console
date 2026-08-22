import DetailShell from '../_components/DetailShell'

/**
 * 상세 패널의 Suspense 폴백.
 *
 * App Router 가 이 세그먼트만 감싸므로, 상세를 불러오는 동안 **지도는 계속
 * 렌더되고 SSE 도 흐른다.** 로딩 표시가 패널 안에서만 나타난다.
 * page.tsx 를 통째로 갈아치우는 구조였다면 지도까지 스켈레톤으로 덮였을 것이다.
 *
 * DetailShell 을 공유해서 로딩 → 완료 전환에 패널이 움직이지 않게 한다.
 */
export default function Loading() {
  return (
    <DetailShell>
      <div className="flex animate-pulse flex-col gap-2 p-3">
        <div className="h-4 w-20 rounded bg-slate-800" />
        <div className="mt-1 h-3 rounded bg-slate-800/70" />
        <div className="h-3 w-2/3 rounded bg-slate-800/70" />
        <div className="h-3 w-1/2 rounded bg-slate-800/70" />
        <div className="mt-2 h-1.5 rounded-full bg-slate-800" />
        <div className="h-3 w-3/4 rounded bg-slate-800/50" />
        <div className="h-3 w-3/5 rounded bg-slate-800/50" />
      </div>
    </DetailShell>
  )
}
