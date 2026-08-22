/**
 * children 슬롯의 default.tsx.
 *
 * Parallel Routes 를 쓰는 세그먼트에서는 **모든 슬롯**에 default 가 필요하다.
 * children 은 /fleet/[id] 에 대응하는 page 가 있으니 필요 없어 보이지만, 슬롯 하나가
 * 매칭에 실패하면 Next 는 그 레벨의 슬롯 조합 전체를 해석하지 못한다.
 *
 * /fleet 에서의 page.tsx 와 같은 내용(상세 슬롯 비움)이므로 null 을 돌려준다.
 */
export default function FleetDefault() {
  return null
}
