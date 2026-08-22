import Link from 'next/link'

import DetailShell from '../_components/DetailShell'

/**
 * 없는 로봇 id — page.tsx 의 notFound() 가 여기로 온다.
 *
 * 세그먼트 단위로 처리되므로 지도는 그대로 살아 있다. 404 라고 전체 화면을
 * 갈아치우지 않는 게 관제 화면에서는 중요하다 — 오타 하나로 관제를 잃으면 안 된다.
 */
export default function RobotNotFound() {
  return (
    <DetailShell>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
        <p className="text-xs font-semibold text-amber-400">등록되지 않은 로봇입니다</p>
        <p className="text-[10px] leading-relaxed text-slate-500">
          id 를 확인해 주세요. 플릿 크기는 <code className="text-slate-400">FLEET_SIZE</code>
          환경변수로 정해집니다.
        </p>
        <Link
          href="/fleet"
          className="mt-1 rounded bg-slate-700 px-2.5 py-1 text-[10px] font-medium text-slate-100 hover:bg-slate-600"
        >
          목록으로
        </Link>
      </div>
    </DetailShell>
  )
}
