import FleetSkeleton from './_components/FleetSkeleton'

/**
 * App Router 의 loading.tsx — 이 세그먼트의 **page** 를 Suspense 로 감싼다.
 *
 * ⚠️ layout.tsx 는 이 경계 **밖**이다. loading.tsx 는 page.js 와 그 하위를 감싸므로,
 * 같은 레벨 layout.tsx 의 await 는 덮지 못한다. 스냅샷 조회가 layout 으로 올라간
 * 뒤로는 그쪽에 별도의 Suspense 를 두어야 스켈레톤이 보인다 — layout.tsx 참고.
 */
export default function Loading() {
  return <FleetSkeleton />
}
