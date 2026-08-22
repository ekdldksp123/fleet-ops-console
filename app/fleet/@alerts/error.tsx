'use client'

import AlertRail from '../_components/AlertRail'

/**
 * @alerts 슬롯만 덮는 에러 바운더리.
 *
 * 경보 레일이 터져도 지도와 목록은 계속 동작한다 — 관제 화면에서 사이드 패널
 * 하나 때문에 전체를 잃으면 안 된다. 슬롯 단위로 error.tsx 를 둘 수 있다는 게
 * Parallel Routes 를 쓰는 실질적 이유다.
 */
export default function AlertsError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <AlertRail>
      <div className="flex flex-col gap-1.5 px-3">
        <p className="text-[10px] font-medium text-red-400">경보를 불러오지 못했습니다</p>
        <p className="break-words text-[9px] leading-relaxed text-slate-600">{error.message}</p>
        <button
          onClick={reset}
          className="mt-1 self-start rounded bg-slate-700 px-2 py-0.5 text-[10px] text-slate-100 hover:bg-slate-600"
        >
          다시 시도
        </button>
      </div>
    </AlertRail>
  )
}
