import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { getSimulator } from '@/lib/simulator'
import { STATUS_LABELS } from '@/lib/types'
import { ZONES } from '@/lib/zones'

import DetailShell from '../_components/DetailShell'
import RobotCommands from '../_components/RobotCommands'
import RobotLiveTelemetry from '../_components/RobotLiveTelemetry'
import SelectionSync from '../_components/SelectionSync'

/**
 * /fleet/[id] 상세 라우트 — Server Component.
 *
 * ── 이 라우트가 보여주려는 것 ──
 *
 * 여기로 전환해도 **지도와 SSE 연결이 유지된다.** 화면의 나머지 전부가
 * layout.tsx 에 있고 이 파일은 상세 패널만 채우기 때문이다. 팬·줌해 둔 뷰가
 * 그대로 남고, 델타 seq 가 끊기지 않는다. 자세한 이유는 layout.tsx 주석.
 *
 * ── 서버가 렌더하는 것과 안 하는 것 ──
 *
 *  ✅ 서버: id·이름·소속 구역·구역 정점 수 같은 **안 변하는 값**, generateMetadata
 *  ❌ 서버: 좌표·상태·배터리 — 10Hz 로 변하므로 RobotLiveTelemetry(Client)가 맡는다
 *
 * 제어 버튼(RobotCommands)은 Server Action 을 호출한다. 명령은 요청/응답, 결과 반영은
 * 스트림 — 왜 그렇게 나눴는지는 app/fleet/_actions.ts 주석 참고.
 *
 * 서버에서 실시간 값을 그리면 새로고침해야 갱신되는 죽은 화면이 된다. 반대로
 * 신원 정보를 클라이언트로 내리면 번들만 커진다.
 */

// params 는 Next 15 에서 Promise 다. 동기적으로 열면 런타임 경고가 뜬다.
type Params = Promise<{ id: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params
  const robot = getSimulator().robot(id)

  // 없는 로봇이면 제목으로도 그 사실을 알려준다. 링크 공유 시 미리보기에 드러난다.
  if (!robot) return { title: '알 수 없는 로봇 — Fleet Ops Console' }

  return {
    title: `${robot.id} · ${robot.name} — Fleet Ops Console`,
    description: `${robot.zone} 소속 ${robot.name}(${robot.id})의 실시간 위치·상태`,
  }
}

export default async function RobotDetailPage({ params }: { params: Params }) {
  const { id } = await params
  const robot = getSimulator().robot(id)

  // notFound() 는 이 세그먼트의 not-found.tsx 를 렌더한다. 상세 패널 안에서만
  // 처리되므로 지도는 그대로 살아 있다.
  if (!robot) notFound()

  const zone = ZONES.find((z) => z.name === robot.zone)

  return (
    <DetailShell>
      {/* URL 로 먼저 들어온 경우(직접 링크·뒤로가기) 스토어를 맞춰 지도 강조를 켠다 */}
      <SelectionSync id={robot.id} />

      <header className="flex items-baseline gap-2 border-b border-slate-800 px-3 py-2">
        <h2 className="font-mono text-xs font-semibold text-slate-100">{robot.id}</h2>
        <Link
          href="/fleet"
          className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-800 hover:text-slate-300"
        >
          닫기 ✕
        </Link>
      </header>

      {/* ── 서버 렌더: 안 변하는 신원 정보 ── */}
      <div className="flex flex-col gap-1.5 border-b border-slate-800 px-3 py-2">
        <Field label="이름" value={robot.name} />
        <Field label="구역" value={robot.zone} />
        <Field label="구역 정점" value={zone ? `${zone.ring.length}개` : '—'} />
        <Field label="스냅샷 상태" value={STATUS_LABELS[robot.statusCode]} />
        <p className="mt-0.5 text-[9px] leading-relaxed text-slate-600">
          위 값은 서버에서 렌더된 신원 정보입니다. 아래는 클라이언트가 SSE 로 받는
          실시간 값입니다.
        </p>
      </div>

      {/* ── 클라이언트 렌더: 10Hz 로 변하는 값 ── */}
      <RobotLiveTelemetry id={robot.id} />

      {/* ── 제어: Server Action 으로 명령, 결과는 SSE 로 확인 ── */}
      <RobotCommands id={robot.id} />

      <p className="border-t border-slate-800 px-3 py-2 text-[9px] leading-relaxed text-slate-600">
        이 패널만 라우트 전환으로 교체됩니다. 지도 인스턴스와 SSE 연결은
        중첩 레이아웃에 있어 유지됩니다 — 계측 오버레이의 프레임 seq 가 끊기지
        않는 것으로 확인할 수 있습니다.
      </p>
    </DetailShell>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between text-[10px]">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-300">{value}</span>
    </div>
  )
}
