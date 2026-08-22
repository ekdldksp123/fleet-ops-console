import { Suspense, type ReactNode } from 'react'

import { summarize } from '@/lib/delta'
import { getSimulator } from '@/lib/simulator'

import { FleetProvider } from './_components/FleetProvider'
import FleetShell from './_components/FleetShell'
import FleetSkeleton from './_components/FleetSkeleton'
import SiteInfoPanel from './_components/SiteInfoPanel'

/**
 * /fleet 세그먼트의 중첩 레이아웃 — Server Component.
 *
 * ── 왜 FleetShell 이 page.tsx 가 아니라 여기에 있나 ──
 *
 * 이게 이 파일의 존재 이유 전체다. App Router 에서 **레이아웃은 하위 라우트가
 * 바뀌어도 언마운트되지 않는다.** page.tsx 는 바뀐다.
 *
 * FleetShell 안에는 두 가지 비싸고 상태를 가진 것이 들어 있다.
 *   - OpenLayers 지도 인스턴스 (WebGL 컨텍스트, 피처 2,000~20,000개, 뷰 상태)
 *   - EventSource SSE 연결 (FleetClient 의 로봇 Map)
 *
 * 이걸 page.tsx 에 두면 /fleet → /fleet/RB-00001 로 갈 때마다 지도가 파괴되고
 * 다시 만들어진다. 사용자가 팬·줌해 둔 뷰가 초기화되고, SSE 가 끊고 재연결하며
 * 델타 seq 가 리셋된다. 로봇 하나를 클릭할 때마다 그런 일이 벌어진다.
 *
 * 레이아웃에 두면 라우트 전환이 **상세 패널만** 교체한다. 지도는 그대로 살아 있다.
 * children(= 하위 page.tsx 의 결과)을 detail prop 으로 내려보내는 게 그 장치다.
 *
 * ── 데이터 조회도 여기로 올라왔다 ──
 *
 * 초기 스냅샷을 레이아웃에서 조회하므로 /fleet 과 /fleet/[id] 가 같은 데이터를
 * 공유하고, 라우트를 오갈 때 다시 조회하지 않는다(레이아웃이 재실행되지 않으므로).
 *
 * ── @alerts 슬롯 (Parallel Routes) ──
 *
 * `children` 옆에 `alerts` 를 하나 더 받는다. `app/fleet/@alerts/` 폴더가 그 슬롯이고,
 * URL 에는 흔적이 없다. 슬롯마다 독립적인 loading.tsx / error.tsx 를 둘 수 있어서,
 * 경보 레일이 느리거나 터져도 지도와 목록은 멀쩡하다. 자세한 이유와 한계는
 * app/fleet/@alerts/page.tsx 주석 참고.
 *
 * ⚠️ **슬롯은 React 트리에서 형제다.** 그래서 FleetProvider 가 여기(슬롯들보다
 * 위)에 있어야 한다. 원래는 FleetShell 안에 있었는데, 그 상태로 @alerts 를 붙이니
 * 슬롯의 useFleet 이 컨텍스트를 못 찾고 터졌다 —
 * "useFleet 은 FleetProvider 안에서만 사용할 수 있습니다".
 *
 * 증상이 고약했다. /fleet 은 경보 레일이 스켈레톤에서 멈추고(SSR 중 throw),
 * /fleet/[id] 는 레일이 통째로 사라졌다. 화면만 보면 default.tsx 를 안 만든 것처럼
 * 보여서 Parallel Routes 설정을 계속 의심하게 된다. 서버 로그를 봐야 알 수 있다.
 *
 * 프로바이더를 올린 결과 두 슬롯이 **하나의 SSE 연결**을 공유한다. 슬롯마다
 * 프로바이더를 두면 EventSource 가 두 개 열려 서버 구독자와 트래픽이 두 배가 된다
 * (e2e 가 /api/fleet/stream 요청 수를 1로 못 박고 있다).
 *
 * ⚠️ 그 대가로 loading.tsx 가 이 조회를 덮지 못한다. loading.tsx 는 page.js 와 그
 * 하위만 Suspense 로 감싸고 같은 레벨의 layout 은 경계 밖이다. 그래서 아래에서
 * 조회 부분을 별도 컴포넌트로 떼어 Suspense 로 직접 감싼다 — 안 하면 스냅샷을
 * 만드는 동안 빈 화면이 보인다.
 */

// 스냅샷은 매 요청 시점의 살아 있는 값이라 정적 생성 대상이 아니다.
export const dynamic = 'force-dynamic'

export default function FleetLayout({
  children,
  alerts,
}: {
  children: ReactNode
  /** @alerts 슬롯. 폴더명의 @ 가 이 prop 이름을 정한다. */
  alerts: ReactNode
}) {
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-3 border-b border-slate-800 bg-slate-950/80 px-4 py-2.5">
        <span className="text-sm font-semibold tracking-tight text-slate-100">
          Fleet Ops Console
        </span>
        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
          App Router · Server Component 셸
        </span>
        <span className="ml-auto text-[11px] text-slate-500">
          통합관제 · 실시간 모니터링 데모
        </span>
      </header>

      {/*
        슬롯을 main 밖에 나란히 둔다. FleetShell 안으로 넘기면(prop drilling) 슬롯이
        FleetShell 의 렌더에 묶여서, 슬롯 단위 경계를 두는 의미가 흐려진다.
      */}
      <Suspense fallback={<FleetSkeleton />}>
        <FleetData detail={children} alerts={alerts} />
      </Suspense>
    </div>
  )
}

/**
 * 스냅샷 조회 담당 — 레이아웃 본문에서 떼어낸 이유는 위 ⚠️ 주석 참고.
 * 이 컴포넌트가 suspend 하는 동안 헤더는 이미 스트리밍되어 보인다.
 */
async function FleetData({ detail, alerts }: { detail: ReactNode; alerts: ReactNode }) {
  const simulator = getSimulator()
  const snapshot = simulator.snapshot()
  const meta = simulator.meta()
  const initialSummary = summarize(snapshot)

  return (
    // FleetProvider 가 두 슬롯을 모두 감싼다. 위 ⚠️ 주석이 이 배치의 이유다.
    <FleetProvider initialRobots={snapshot} meta={meta}>
      <div className="flex h-full min-h-0">
        <main className="min-w-0 flex-1">
          <FleetShell
            // ⬇︎ Server Component 를 prop 으로 주입한다 (composition 패턴).
            // FleetShell 은 'use client' 지만, 이 노드는 서버에서 이미 렌더된 결과라
            // SiteInfoPanel 의 코드는 클라이언트 번들에 포함되지 않는다.
            siteInfo={<SiteInfoPanel meta={meta} summary={initialSummary} />}
            // ⬇︎ 하위 라우트의 page.tsx 결과. 같은 composition 패턴이고, 이쪽은
            // 라우트가 바뀔 때마다 이 노드만 교체된다.
            detail={detail}
          />
        </main>
        {alerts}
      </div>
    </FleetProvider>
  )
}
