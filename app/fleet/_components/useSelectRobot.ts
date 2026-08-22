'use client'

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'

import { useFleetUi } from '@/store/fleet-store'

/**
 * 로봇 선택 = Zustand 갱신 + 라우트 이동, 두 가지를 한 번에.
 *
 * ── 왜 상태가 두 곳에 있나 ──
 *
 * 진실의 원천을 URL 하나로 몰면 깔끔하지만, 클릭할 때마다 RSC 왕복이 끝나야
 * 지도의 강조 표시가 뜬다. 관제 화면에서 클릭 반응이 한 박자 늦는 건 안 된다.
 *
 * 그래서 역할을 나눈다.
 *   - Zustand `selectedId` : **즉각 반응**용. 지도 강조·목록 하이라이트가 이걸 본다.
 *   - URL `/fleet/[id]`    : **탐색 가능한 진실**. 공유·새로고침·뒤로가기가 이걸 본다.
 *
 * 클릭은 둘을 동시에 갱신하고(아래), 반대 방향(뒤로가기·직접 링크)은
 * SelectionSync 가 URL → store 로 한 번만 흘려준다. 양방향 동기화가 아니라
 * "클릭은 둘 다, 그 외에는 URL → store 단방향" 이라 순환이 생기지 않는다.
 */
export function useSelectRobot() {
  const router = useRouter()
  const select = useFleetUi((s) => s.select)

  return useCallback(
    (id: string | null) => {
      select(id)
      // push 를 쓴다. replace 면 상세를 여러 개 오간 뒤 뒤로가기가 /fleet 을 건너뛰고
      // 관제 화면 밖으로 나가버린다.
      router.push(id ? `/fleet/${id}` : '/fleet')
    },
    [router, select],
  )
}
