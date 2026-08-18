'use client'

// error.tsx 는 반드시 Client Component 다. 에러 바운더리는 클라이언트에서만
// 리셋 가능하기 때문. App Router 가 이 세그먼트를 자동으로 감싼다.
export default function FleetError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-sm font-semibold text-red-400">플릿 스냅샷을 불러오지 못했습니다</p>
      <p className="max-w-md text-xs text-slate-500">{error.message}</p>
      {error.digest && <p className="text-[10px] text-slate-600">digest: {error.digest}</p>}
      <button
        onClick={reset}
        className="mt-2 rounded bg-slate-700 px-3 py-1.5 text-xs font-medium text-slate-100 hover:bg-slate-600"
      >
        다시 시도
      </button>
    </div>
  )
}
