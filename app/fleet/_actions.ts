'use server'

import { getSimulator } from '@/lib/simulator'

/**
 * 로봇 제어 명령 — Server Actions.
 *
 * ── 왜 Server Action 이고 WebSocket 이 아닌가 ──
 *
 * README 는 이 지점을 "WebSocket 전환 검토" 로 남겨 두었다. 실제로 검토한 결론은
 * **전환하지 않는다** 다.
 *
 * 데이터 흐름을 두 방향으로 나눠 보면 요구가 서로 다르다.
 *
 *   서버 → 클라이언트 (텔레메트리) : 초당 수천 건, 순서 보장 필요, 유실 감지 필요
 *                                    → SSE 가 맞다. HTTP 위에서 돌고 재연결과
 *                                      Last-Event-ID 를 브라우저가 처리한다.
 *   클라이언트 → 서버 (명령)       : 사람이 버튼을 누르는 빈도, 개별 성공/실패가
 *                                    중요, 인증·권한·감사 로그가 붙어야 함
 *                                    → 요청/응답이 맞다. Server Action 이 그것이다.
 *
 * WebSocket 으로 명령을 보내면 요청/응답 상관관계를 직접 만들어야 하고(요청 id,
 * 타임아웃, 재시도), 인증은 연결 수립 시점에 한 번만 걸리고, 실패를 UI 로 되돌리는
 * 경로도 직접 짜야 한다. Server Action 은 그걸 전부 HTTP 로 공짜로 얻는다.
 *
 * WebSocket 이 실제로 필요해지는 건 **저지연 양방향 스트림**이 생길 때다 —
 * 조이스틱 원격조작, 실시간 영상, 서버가 클라이언트에 응답을 요구하는 협상 같은 것.
 * 버튼 몇 개는 그 조건이 아니다.
 *
 * ── revalidatePath 를 부르지 않는 이유 ──
 *
 * 명령의 결과(statusCode 변경)는 다음 델타 프레임으로 SSE 를 타고 도착한다.
 * 읽기 경로가 캐시가 아니라 **스트림**이므로 무효화할 캐시가 없다. Server Action 을
 * 쓰면 반사적으로 revalidate 를 붙이는 습관이 있는데, 여기서는 불필요한 서버 렌더만
 * 유발한다.
 *
 * ── 입력 검증 ──
 *
 * Server Action 은 공개 HTTP 엔드포인트다. 클라이언트를 거치지 않고 직접 호출될 수
 * 있으므로 id 를 반드시 검증한다. 실제 시스템이라면 여기에 인증·권한 확인과
 * 감사 로그가 붙는다.
 */

export interface CommandResult {
  ok: boolean
  message: string
}

export async function haltRobot(id: string): Promise<CommandResult> {
  if (typeof id !== 'string' || !/^RB-\d+$/.test(id)) {
    return { ok: false, message: '잘못된 로봇 id' }
  }
  const ok = getSimulator().command(id, 'halt')
  return ok
    ? { ok: true, message: '정지 명령을 보냈습니다' }
    : { ok: false, message: '등록되지 않은 로봇입니다' }
}

export async function recallRobot(id: string): Promise<CommandResult> {
  if (typeof id !== 'string' || !/^RB-\d+$/.test(id)) {
    return { ok: false, message: '잘못된 로봇 id' }
  }
  const ok = getSimulator().command(id, 'recall')
  return ok
    ? { ok: true, message: '구역 집결지로 호출했습니다' }
    : { ok: false, message: '등록되지 않은 로봇입니다' }
}
