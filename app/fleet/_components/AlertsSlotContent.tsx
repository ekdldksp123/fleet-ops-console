import { collectAlerts } from '@/lib/delta'
import { getSimulator } from '@/lib/simulator'

import AlertFeed from './AlertFeed'
import AlertRail from './AlertRail'

/**
 * @alerts 슬롯의 실제 내용 — Server Component.
 *
 * page.tsx 와 default.tsx 가 **각각** 이걸 렌더한다. 처음에는 default.tsx 에서
 * `export default AlertsSlot`(page.tsx 의 기본 내보내기 재수출)로 짰는데, Next 가
 * 그 파일을 라우트 파일로 인식하지 못해 default.js 를 아예 빌드하지 않았다 —
 * 결과적으로 /fleet/[id] 에서 슬롯이 통째로 사라졌다.
 *
 * 라우트 파일(page/default/layout/...)끼리 서로 import 하지 않는다. 공유할 내용은
 * 이렇게 평범한 컴포넌트로 뺀다.
 *
 * 초기 경보는 서버에서 계산해 첫 페인트에 실어 보낸다(빈 목록이 잠깐 보이지 않게).
 * 이후 갱신은 AlertFeed(Client)가 SSE 로 받는다.
 */
export default function AlertsSlotContent() {
  const initial = collectAlerts(getSimulator().snapshot())

  return (
    <AlertRail>
      <AlertFeed initial={initial} />
    </AlertRail>
  )
}
