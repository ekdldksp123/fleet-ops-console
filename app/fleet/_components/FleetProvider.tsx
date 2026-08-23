'use client'

import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'

import { FleetClient } from '@/lib/fleet-client'
import type { FleetMeta, Robot } from '@/lib/types'
import { useFleetUi } from '@/store/fleet-store'

const FleetContext = createContext<FleetClient | null>(null)

export function FleetProvider({
  initialRobots,
  meta,
  children,
}: {
  initialRobots: Robot[]
  meta: FleetMeta
  children: ReactNode
}) {
  // useMemo 로 인스턴스를 한 번만 만든다. useState 초기화 함수를 써도 되지만,
  // 이 값은 렌더 결과에 직접 관여하지 않으므로 memo 로 충분하다.
  const client = useMemo(() => new FleetClient(initialRobots, meta), [initialRobots, meta])

  // 파싱 위치(메인/워커)는 사람이 토글하는 저빈도 상태라 Zustand 에 둔다.
  const parseMode = useFleetUi((s) => s.parseMode)

  useEffect(() => {
    // 첫 연결 전에 모드를 정해 둔다. connect 안에서 분기하므로 순서가 중요하다.
    client.parseMode = parseMode
    client.connect()
    return () => client.disconnect()
    // parseMode 를 의존성에 넣지 않는다 — 넣으면 모드 변경 시 연결을 끊고 다시
    // 맺는 게 아니라 effect 전체가 재실행되며 클라이언트 수명주기가 흔들린다.
    // 모드 변경은 아래 별도 effect 가 setParseMode 로 처리한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  useEffect(() => {
    client.setParseMode(parseMode)
  }, [client, parseMode])

  return <FleetContext.Provider value={client}>{children}</FleetContext.Provider>
}

export function useFleet(): FleetClient {
  const client = useContext(FleetContext)
  if (!client) throw new Error('useFleet 은 FleetProvider 안에서만 사용할 수 있습니다')
  return client
}
