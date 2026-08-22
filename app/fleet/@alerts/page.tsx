import AlertsSlotContent from '../_components/AlertsSlotContent'

/**
 * @alerts 슬롯 — Parallel Route. /fleet 에서 렌더된다.
 *
 * ── Parallel Routes 가 뭘 바꾸나 ──
 *
 * 폴더 이름 앞의 `@` 가 이 폴더를 **이름 있는 슬롯**으로 만든다. 부모 layout.tsx 가
 * `children` 과 나란히 `alerts` prop 으로 받는다. URL 에는 아무 흔적이 없다.
 *
 * 그냥 layout 안에 <AlertRail/> 컴포넌트를 두는 것과 무엇이 다른가:
 *
 *  1. **독립적인 로딩·에러 경계.** 이 슬롯의 loading.tsx / error.tsx 는 이 레일만
 *     덮는다. 경보 조회가 느리거나 터져도 지도와 목록은 멀쩡하다. 관제 화면에서
 *     사이드 패널 하나 때문에 전체가 죽으면 안 된다.
 *  2. **독립적인 스트리밍.** 슬롯이 각자 suspend 하므로 준비된 것부터 먼저 보인다.
 *  3. **독립적으로 라우팅 가능.** 지금은 안 쓰지만, @alerts/[alertId] 같은 하위
 *     라우트를 두면 children 슬롯(지도·상세)과 무관하게 이 레일만 라우팅된다.
 *
 * 반대로 얻지 못하는 것도 분명히 해두자. 슬롯은 같은 라우터·같은 React 트리를
 * 공유하므로 "독립적으로 리렌더" 되지는 않는다. 성능 격리가 아니라
 * **경계 격리**가 목적이다.
 */
export default function AlertsSlotPage() {
  return <AlertsSlotContent />
}
