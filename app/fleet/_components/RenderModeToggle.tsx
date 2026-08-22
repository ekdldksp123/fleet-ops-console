'use client'

import { useFleetUi, type RenderMode } from '@/store/fleet-store'

/**
 * 벤치마크 스위치.
 *
 * 같은 VectorSource 를 Canvas 레이어와 WebGL 레이어가 공유하므로, 이 토글은
 * 데이터를 건드리지 않고 렌더 경로만 바꾼다. 그래서 before/after 비교가 공정하다.
 */
export default function RenderModeToggle() {
  const renderMode = useFleetUi((s) => s.renderMode)
  const setRenderMode = useFleetUi((s) => s.setRenderMode)
  const followSelected = useFleetUi((s) => s.followSelected)
  const toggleFollow = useFleetUi((s) => s.toggleFollow)
  const showStats = useFleetUi((s) => s.showStats)
  const toggleStats = useFleetUi((s) => s.toggleStats)
  const showZones = useFleetUi((s) => s.showZones)
  const toggleZones = useFleetUi((s) => s.toggleZones)
  const showTrail = useFleetUi((s) => s.showTrail)
  const toggleTrail = useFleetUi((s) => s.toggleTrail)

  return (
    <div className="absolute right-3 top-3 z-10 flex flex-col items-end gap-1.5">
      <div
        className="flex overflow-hidden rounded-md ring-1 ring-slate-700"
        role="radiogroup"
        aria-label="렌더링 방식"
      >
        {(['canvas', 'webgl'] as RenderMode[]).map((mode) => (
          <button
            key={mode}
            role="radio"
            aria-checked={renderMode === mode}
            onClick={() => setRenderMode(mode)}
            className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
              renderMode === mode
                ? 'bg-slate-100 text-slate-900'
                : 'bg-slate-900/85 text-slate-400 hover:bg-slate-800'
            }`}
          >
            {mode === 'canvas' ? 'Canvas' : 'WebGL'}
          </button>
        ))}
      </div>

      <div className="flex gap-1.5">
        <MiniToggle active={followSelected} onClick={toggleFollow}>
          선택 추적
        </MiniToggle>
        <MiniToggle active={showZones} onClick={toggleZones}>
          구역
        </MiniToggle>
        <MiniToggle active={showTrail} onClick={toggleTrail}>
          경로
        </MiniToggle>
        <MiniToggle active={showStats} onClick={toggleStats}>
          계측
        </MiniToggle>
      </div>
    </div>
  )
}

function MiniToggle({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`rounded px-1.5 py-0.5 text-[10px] ring-1 transition-colors ${
        active
          ? 'bg-slate-800 text-slate-200 ring-slate-600'
          : 'bg-slate-900/85 text-slate-500 ring-slate-800 hover:text-slate-300'
      }`}
    >
      {children}
    </button>
  )
}
