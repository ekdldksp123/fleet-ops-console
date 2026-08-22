'use client'

import { create } from 'zustand'
import type { StatusCode } from '@/lib/types'

export type RenderMode = 'canvas' | 'webgl'

/**
 * UI 상태 전용 스토어.
 *
 * ⚠️ 여기에 로봇 좌표를 넣지 말 것. 고빈도 데이터를 Zustand 에 넣는 순간
 * 구독 중인 모든 컴포넌트가 초당 수십 번 리렌더되고, 지도의 프레임 예산이
 * React 렌더에 잡아먹힌다. 좌표의 원본은 lib/fleet-client.ts 의 Map 이다.
 *
 * 이 스토어가 다루는 건 전부 "사람이 만드는 빈도"의 상태다.
 */
interface FleetUiState {
  selectedId: string | null
  statusFilter: StatusCode | 'all'
  query: string
  renderMode: RenderMode
  followSelected: boolean
  showStats: boolean
  showZones: boolean

  select: (id: string | null) => void
  setStatusFilter: (v: StatusCode | 'all') => void
  setQuery: (v: string) => void
  setRenderMode: (v: RenderMode) => void
  toggleFollow: () => void
  toggleStats: () => void
  toggleZones: () => void
}

export const useFleetUi = create<FleetUiState>((set) => ({
  selectedId: null,
  statusFilter: 'all',
  query: '',
  // 기본값을 canvas 로 두는 건 의도적이다. 벤치마크의 "before" 가 기본 상태여야
  // 개선 폭이 정직하게 드러난다.
  renderMode: 'canvas',
  followSelected: true,
  showStats: true,
  showZones: true,

  select: (id) => set({ selectedId: id }),
  setStatusFilter: (statusFilter) => set({ statusFilter }),
  setQuery: (query) => set({ query }),
  setRenderMode: (renderMode) => set({ renderMode }),
  toggleFollow: () => set((s) => ({ followSelected: !s.followSelected })),
  toggleStats: () => set((s) => ({ showStats: !s.showStats })),
  // 구역 오버레이는 껐다 켤 수 있어야 한다. 벤치마크할 때 폴리곤 6개의 렌더 비용을
  // 빼고 재려면 필요하고, 로봇이 빽빽한 구역에서는 시야를 가린다.
  toggleZones: () => set((s) => ({ showZones: !s.showZones })),
}))
