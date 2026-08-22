import type { ReactNode } from 'react'

/**
 * 상세 패널의 공통 껍데기 — Server Component.
 *
 * [id]/page.tsx, [id]/loading.tsx, [id]/not-found.tsx 세 상태가 같은 위치·크기로
 * 나타나야 한다. 껍데기를 각각 복사하면 로딩 → 완료 전환에서 패널이 미세하게
 * 움직인다. 여기 한 곳에 모아 둔다.
 *
 * pointer-events 주의: 패널은 지도 위에 떠 있으므로, 패널 영역의 클릭이 지도로
 * 새어 나가면 상세를 보려다 로봇 선택이 바뀐다. 패널은 이벤트를 받아야 하므로
 * pointer-events-auto 를 명시한다(부모가 none 이어도 안전하게).
 */
export default function DetailShell({ children }: { children: ReactNode }) {
  return (
    <aside
      // 높이는 내용에 맞춘다(전체 높이 고정 아님). 상세 내용이 짧아서 bottom 을
      // 고정하면 패널 절반이 빈 공간이 되고, 그만큼 지도를 가린다.
      // max-h 로 상한만 걸고 넘치면 패널 안에서 스크롤한다.
      className="pointer-events-auto absolute left-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] w-[268px] flex-col overflow-y-auto rounded-lg bg-slate-950/92 ring-1 ring-slate-700 backdrop-blur"
      aria-label="로봇 상세"
    >
      {children}
    </aside>
  )
}
