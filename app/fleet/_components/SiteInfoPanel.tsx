import { STATUS_COLORS, STATUS_LABELS, type FleetMeta, type StatusCode } from '@/lib/types'
import type { FleetSummary } from '@/lib/delta'

/**
 * Server Component — 'use client' 가 없다.
 *
 * 여기서 보여주는 값은 전부 "초기 스냅샷 시점"의 정적 정보다. 실시간으로
 * 흔들리는 수치를 서버 컴포넌트에 넣으면 의미가 없으므로, 살아 움직이는
 * 카운터는 LiveStatusBar(Client) 가 따로 담당한다.
 *
 * 이 분리가 곧 면접 답변이 된다:
 *   "정적 메타데이터는 서버 컴포넌트, 실시간 갱신 레이어만 클라이언트."
 */
export default function SiteInfoPanel({
  meta,
  summary,
}: {
  meta: FleetMeta
  summary: FleetSummary
}) {
  return (
    <section className="border-b border-slate-800 px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <h2 className="text-xs font-semibold text-slate-300">동탄 물류 캠퍼스</h2>
        <span className="text-[10px] text-slate-500">
          {meta.zones.length}개 구역 · tick {meta.tickMs}ms
        </span>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <Tile label="등록 대수" value={meta.size.toLocaleString()} />
        <Tile label="초기 평균 배터리" value={`${summary.avgBattery.toFixed(1)}%`} />
      </div>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {(Object.keys(meta.initialDistribution) as unknown as StatusCode[]).map((code) => (
          <span key={code} className="flex items-center gap-1 text-[10px] text-slate-400">
            <i
              className="inline-block size-2 rounded-full"
              style={{ background: STATUS_COLORS[code] }}
            />
            {STATUS_LABELS[code]} {meta.initialDistribution[code]}
          </span>
        ))}
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
        위 수치는 서버에서 렌더된 초기 스냅샷입니다. 실시간 값은 아래 상태바에서
        갱신됩니다.
      </p>
    </section>
  )
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-slate-900/60 px-2 py-1.5">
      <div className="text-[10px] text-slate-500">{label}</div>
      <div className="text-sm font-semibold tabular-nums text-slate-200">{value}</div>
    </div>
  )
}
