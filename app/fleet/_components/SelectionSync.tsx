'use client'

import { useEffect } from 'react'

import { useFleetUi } from '@/store/fleet-store'

/**
 * URL 의 로봇 id 를 스토어로 흘려주는 동기화 컴포넌트 — 렌더 결과 없음.
 *
 * 클릭 경로는 useSelectRobot 이 스토어와 URL 을 동시에 갱신하므로 이 컴포넌트가
 * 할 일이 없다. 이게 필요한 건 **URL 이 먼저 바뀌는 경우**다.
 *
 *   - 뒤로/앞으로 가기
 *   - /fleet/RB-00042 링크를 직접 열기 (첫 렌더)
 *   - 새로고침
 *
 * 이때 스토어를 맞춰주지 않으면 상세 패널은 열려 있는데 지도에는 강조 표시가
 * 없는 상태가 된다.
 *
 * 상세 페이지(서버)가 이 컴포넌트를 렌더하므로 id 는 항상 유효한 로봇이다
 * (없는 id 는 page.tsx 가 notFound() 로 걸러낸다). /fleet 에서는 아예
 * 렌더되지 않으므로, 선택 해제는 클릭 경로가 담당한다.
 */
export default function SelectionSync({ id }: { id: string }) {
  useEffect(() => {
    // 값이 같으면 set 하지 않는다. Zustand 는 같은 값이어도 구독자를 깨우므로
    // 라우트 전환마다 불필요한 리렌더가 생긴다.
    if (useFleetUi.getState().selectedId !== id) {
      useFleetUi.getState().select(id)
    }
  }, [id])

  return null
}
