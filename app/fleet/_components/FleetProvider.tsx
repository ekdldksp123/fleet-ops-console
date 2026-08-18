'use client'

import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'

import { FleetClient } from '@/lib/fleet-client'
import type { FleetMeta, Robot } from '@/lib/types'

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

  useEffect(() => {
    client.connect()
    return () => client.disconnect()
  }, [client])

  return <FleetContext.Provider value={client}>{children}</FleetContext.Provider>
}

export function useFleet(): FleetClient {
  const client = useContext(FleetContext)
  if (!client) throw new Error('useFleet 은 FleetProvider 안에서만 사용할 수 있습니다')
  return client
}
