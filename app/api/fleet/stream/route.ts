import { getSimulator } from '@/lib/simulator'
import type { DeltaFrame } from '@/lib/types'

/**
 * SSE 스트림 — App Router Route Handler.
 *
 * 이 파일이 App Router 를 실제로 썼다는 가장 뚜렷한 증거다. Pages Router 의
 * API Route 는 Node 의 `res` 객체를 직접 만지지만, Route Handler 는 표준
 * `Request`/`Response` 위에서 `ReadableStream` 을 그대로 반환한다.
 *
 * WebSocket 이 아니라 SSE 를 고른 이유:
 *  - 데이터 흐름이 서버 → 클라이언트 단방향이다. 명령 전송은 별도 POST 로 충분.
 *  - HTTP 위에서 동작해 프록시·로드밸런서를 그대로 통과한다.
 *  - EventSource 가 재연결과 Last-Event-ID 를 브라우저 레벨에서 처리해준다.
 * 양방향 제어(로봇 정지/호출)가 들어오면 WebSocket 으로 갈아탈 지점이다.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** 프록시가 유휴 연결을 끊지 않도록 보내는 주석 하트비트 주기 */
const HEARTBEAT_MS = 15_000


/**
 * 장애 주입용 파라미터 `?frames=N`.
 *
 * N 프레임을 보낸 뒤 스트림을 닫는다. 재연결 경로를 테스트하려면 연결을 실제로
 * 끊어야 하는데, 그게 브라우저 쪽에서는 불가능하다 — Playwright 의 setOffline 은
 * **이미 성립된 연결에 영향을 주지 않고**(실측 확인), 라우트 가로채기로는 흐르고
 * 있는 스트림을 끊을 수 없다.
 *
 * 그래서 서버가 끊어 준다. 프로덕션 동작에는 영향이 없다(파라미터가 없으면 무한).
 * 테스트 전용 코드를 제품에 넣는 건 꺼릴 만한 일이지만, 이 파라미터가 없으면
 * 재연결이 **아예 검증 불가능**해진다 — 손으로 만든 재연결이 조용히 멈추는 걸
 * 못 잡는 것보다는 낫다는 판단이다. 수동 확인에도 쓸 수 있다.
 */
function frameLimit(request: Request): number {
  const raw = new URL(request.url).searchParams.get('frames')
  const n = raw === null ? 0 : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export async function GET(request: Request) {
  const limit = frameLimit(request)
  let sent = 0
  const simulator = getSimulator()
  const encoder = new TextEncoder()

  let unsubscribe: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let closed = false

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          cleanup()
        }
      }

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

      // 클라이언트가 재연결 간격을 알 수 있도록 먼저 내려준다
      write(`retry: 3000\n\n`)
      write(`event: meta\ndata: ${JSON.stringify(simulator.meta())}\n\n`)

      const onFrame = (frame: DeltaFrame) => {
        write(`id: ${frame.seq}\ndata: ${JSON.stringify(frame)}\n\n`)
        // 장애 주입: N 프레임 뒤 스트림을 닫는다. EventSource 는 스스로 재연결하므로
        // 이진 경로(손으로 만든 재연결)와 대조할 수 있다.
        if (limit > 0 && ++sent >= limit) cleanup()
      }

      unsubscribe = simulator.subscribe(onFrame)

      heartbeat = setInterval(() => write(`: keep-alive\n\n`), HEARTBEAT_MS)
      heartbeat.unref?.()

      // 탭을 닫거나 라우팅을 벗어나면 구독을 반드시 해제한다.
      // 이걸 빼먹으면 시뮬레이터 구독자가 계속 쌓여 메모리 누수가 난다.
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
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx 등 리버스 프록시의 응답 버퍼링을 끈다. 없으면 스트림이 뭉텅이로 온다.
      'X-Accel-Buffering': 'no',
    },
  })
}
