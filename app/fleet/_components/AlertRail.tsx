import type { ReactNode } from 'react'

/**
 * @alerts 슬롯의 공통 껍데기 — Server Component.
 *
 * 슬롯은 page.tsx / default.tsx / loading.tsx / error.tsx 네 파일이 같은 자리에
 * 같은 크기로 나타나야 한다. 껍데기를 각각 복사하면 상태가 바뀔 때 레일 폭이
 * 흔들리고, 그 옆의 지도까지 리사이즈된다.
 */
export default function AlertRail({ children }: { children: ReactNode }) {
  return (
    <aside
      className="flex w-[196px] shrink-0 flex-col border-l border-slate-800 bg-slate-950/40 py-2"
      aria-label="경보"
    >
      <h2 className="shrink-0 px-3 pb-1.5 text-[10px] font-medium text-slate-400">경보</h2>
      {children}
    </aside>
  )
}
