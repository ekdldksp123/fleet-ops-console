import AlertsSlotContent from '../_components/AlertsSlotContent'

/**
 * @alerts 슬롯의 default.tsx — **없으면 /fleet/[id] 를 직접 열 때 경보 레일이 사라진다.**
 *
 * 이유: @alerts 폴더에는 [id] 하위 폴더가 없다. soft navigation 에서는 Next 가
 * 슬롯의 활성 상태를 기억해 유지하지만, 새로고침이나 직접 링크(hard navigation)에서는
 * 기억할 상태가 없다. 그때 렌더할 것을 default.tsx 가 정한다.
 *
 * ⚠️ **이 파일을 추가한 뒤에는 .next 를 지우고 다시 빌드할 것.** 증분 빌드는 새로
 * 생긴 라우트 파일(default.tsx)을 잡지 못한다. 프로덕션 빌드에서 레일이 계속
 * 사라져 Parallel Routes 설정을 한참 의심했는데, 원인은 빌드 캐시였다.
 * dev 서버(.next 삭제 후 시작)에서는 처음부터 정상이었다.
 *
 * 여기서는 슬롯의 page 와 똑같이 렌더한다. 경보 레일은 어느 라우트에서든 같은
 * 내용이어야 하기 때문이다. (하위 라우트마다 다른 내용을 원하면 그때 갈라진다.)
 */
export default function AlertsSlotDefault() {
  return <AlertsSlotContent />
}
