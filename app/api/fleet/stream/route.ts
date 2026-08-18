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

export async function GET(request: Request) {
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
