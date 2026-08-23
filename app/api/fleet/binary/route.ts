import { getSimulator } from '@/lib/simulator'
import type { DeltaFrame } from '@/lib/types'
import { encodeFrame, encodeKeepAlive } from '@/lib/wire-format'

/**
 * 이진 델타 스트림 — Route Handler.
 *
 * `/api/fleet/stream`(SSE, JSON)과 **같은 데이터를 다른 인코딩으로** 내려보낸다.
 * 두 라우트를 나란히 두는 이유는 A/B 측정이다 — 데이터가 동일해야 인코딩 차이만
 * 비교할 수 있다. 하나로 합쳐 쿼리 파라미터로 분기하면 두 경로가 서로 얽혀서
 * "이 차이가 인코딩 때문인지 분기 때문인지" 를 말할 수 없게 된다.
 *
 * ── SSE 를 쓰지 않는다 ──
 *
 * SSE 는 텍스트 전용이라 이진을 실으려면 base64 가 필요하다(대역폭 +33%, 디코딩 비용).
 * 여기서는 `ReadableStream<Uint8Array>` 를 그대로 흘려보내고 클라이언트가 `fetch` 로
 * 읽는다. 그 대가로 EventSource 의 자동 재연결을 잃고, 클라이언트가 직접 구현한다
 * (lib/binary-feed.ts).
 *
 * 프레임 형식은 lib/wire-format.ts 에 정의되어 있고 길이 접두 방식이라, 청크가 프레임
 * 경계와 무관하게 잘려도 클라이언트가 다시 이어붙일 수 있다.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** 프록시가 유휴 연결을 끊지 않도록 보내는 하트비트 주기 */
const HEARTBEAT_MS = 15_000

export async function GET(request: Request) {
  const simulator = getSimulator()
  const idIndex = simulator.idIndex()

  let unsubscribe: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let closed = false

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = () => {
        if (closed) return
        closed = true
        unsubscribe?.()
        if (heartbeat) clearInterval(heartbeat)
        try {
          controller.close()
        } catch {
          // 이미 닫힌 컨트롤러
        }
      }

      const write = (chunk: Uint8Array) => {
        if (closed) return
        try {
          controller.enqueue(chunk)
        } catch {
          cleanup()
        }
      }

      const onFrame = (frame: DeltaFrame) => {
        // 백프레셔 방어. 이진 프레임은 60,000대 기준 1.5MB 라, 클라이언트가 느릴 때
        // 그냥 밀어 넣으면 큐가 무한히 자라 서버 메모리를 먹는다. 큐가 찼으면 이
        // 프레임을 버린다 — 델타는 다음 프레임이 어차피 최신 상태를 담고 있으므로,
        // 밀린 과거를 굳이 배달할 이유가 없다.
        //
        // SSE 라우트에는 이 방어가 없다. 텍스트 프레임이 훨씬 작아서 아직 문제가 된
        // 적이 없지만, 같은 위험을 안고 있다.
        if (controller.desiredSize !== null && controller.desiredSize <= 0) return
        write(encodeFrame(frame, idIndex))
      }

      unsubscribe = simulator.subscribe(onFrame)

      heartbeat = setInterval(() => write(encodeKeepAlive()), HEARTBEAT_MS)
      heartbeat.unref?.()

      // 탭을 닫거나 라우팅을 벗어나면 구독을 반드시 해제한다.
      // 빠뜨리면 시뮬레이터 구독자가 계속 쌓여 메모리 누수가 난다.
      request.signal.addEventListener('abort', cleanup)
    },

    cancel() {
      closed = true
      unsubscribe?.()
      if (heartbeat) clearInterval(heartbeat)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-cache, no-transform',
      // 이진 스트림은 압축하면 안 된다. 좌표는 이미 밀도 높은 부동소수라 gzip 이
      // 거의 줄이지 못하는데 CPU 는 양쪽에서 쓴다.
      'Content-Encoding': 'identity',
      'X-Accel-Buffering': 'no',
    },
  })
}
