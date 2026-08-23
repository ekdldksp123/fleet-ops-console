'use client'

import { useState, useTransition } from 'react'

import { haltRobot, recallRobot, type CommandResult } from '../_actions'

/**
 * 로봇 제어 버튼 — Client Component.
 *
 * ── 낙관적 갱신을 하지 않는 이유 ──
 *
 * 보통은 명령 후 UI 를 미리 바꿔 두고(useOptimistic) 서버 응답으로 확정한다.
 * 여기서는 그럴 필요가 없다. 명령의 결과가 **SSE 델타로 100ms 안에 돌아오기**
 * 때문이다. 시뮬레이터는 명령을 받자마자 프레임을 하나 흘려보내므로 사실상 즉시다.
 *
 * 낙관적 갱신을 넣으면 "내가 예측한 상태" 와 "스트림이 알려준 상태" 두 개가 생기고,
 * 둘이 어긋날 때 어느 쪽을 믿을지 정해야 한다. 스트림이 빠르면 그 복잡도를 살 이유가
 * 없다. 대신 요청 중임을 표시하고(isPending) 결과 메시지를 보여준다.
 *
 * ── 상태가 어디에 있나 ──
 *
 * 버튼이 바꾸는 것은 서버의 로봇 상태이고, 화면에 반영하는 것은 SSE 를 구독하는
 * RobotLiveTelemetry 다. 이 컴포넌트는 명령을 보내고 결과 메시지만 들고 있다.
 * "명령은 요청/응답, 상태는 스트림" 이 분리가 이 화면의 설계다.
 */
export default function RobotCommands({ id }: { id: string }) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<CommandResult | null>(null)

  const run = (action: (id: string) => Promise<CommandResult>) => {
    startTransition(async () => {
      setResult(null)
      try {
        setResult(await action(id))
      } catch (err) {
        // Server Action 은 네트워크 호출이다. 실패를 삼키면 버튼이 먹지 않는 것처럼
        // 보인다.
        setResult({ ok: false, message: err instanceof Error ? err.message : '명령 실패' })
      }
    })
  }

  return (
    <div className="border-t border-slate-800 px-3 py-2">
      <div className="flex gap-1.5">
        <button
          onClick={() => run(haltRobot)}
          disabled={pending}
          className="flex-1 rounded bg-slate-800 px-2 py-1 text-[10px] font-medium text-slate-200 ring-1 ring-slate-700 transition-colors hover:bg-slate-700 disabled:opacity-50"
        >
          정지
        </button>
        <button
          onClick={() => run(recallRobot)}
          disabled={pending}
          className="flex-1 rounded bg-slate-800 px-2 py-1 text-[10px] font-medium text-slate-200 ring-1 ring-slate-700 transition-colors hover:bg-slate-700 disabled:opacity-50"
        >
          집결지 호출
        </button>
      </div>

      <p
        // aria-live 로 스크린리더에도 결과를 알린다. 버튼을 누른 뒤 무엇이 일어났는지
        // 시각 정보 없이도 알 수 있어야 한다.
        aria-live="polite"
        className={`mt-1.5 min-h-[13px] text-[9px] leading-relaxed ${
          pending ? 'text-slate-500' : result?.ok ? 'text-green-400' : 'text-red-400'
        }`}
      >
        {pending ? '전송 중…' : (result?.message ?? '')}
      </p>

      <p className="mt-0.5 text-[9px] leading-relaxed text-slate-600">
        명령은 Server Action(요청/응답), 결과 반영은 SSE(스트림)입니다. 상태 변화는
        위 실시간 값에 100ms 안에 나타납니다.
      </p>
    </div>
  )
}
