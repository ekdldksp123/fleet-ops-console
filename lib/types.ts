/**
 * 플릿 도메인 타입.
 *
 * 설계 노트: status 를 문자열이 아니라 숫자 코드로 들고 다닌다.
 * OpenLayers 의 WebGLPointsLayer 스타일 표현식은 숫자 속성에서 가장 안정적으로
 * 동작하고, 델타 프레임 크기도 줄어든다. 사람이 읽는 라벨은 표시 직전에만 붙인다.
 */

export const STATUS_LABELS = ['대기', '이동중', '충전중', '오류'] as const
export type StatusCode = 0 | 1 | 2 | 3

export const STATUS_COLORS: Record<StatusCode, string> = {
  0: '#94a3b8', // slate-400  대기
  1: '#22c55e', // green-500  이동중
  2: '#3b82f6', // blue-500   충전중
  3: '#ef4444', // red-500    오류
}

export interface Robot {
  id: string
  name: string
  zone: string
  /** WGS84 경도 (EPSG:4326) */
  lon: number
  /** WGS84 위도 (EPSG:4326) */
  lat: number
  statusCode: StatusCode
  /** 0~100 */
  battery: number
}

/**
 * 델타 프레임의 로봇 1대 표현.
 * 객체 대신 튜플을 쓰는 이유: 2,000대 × 10Hz 기준으로 JSON 키 이름이
 * 전체 페이로드의 절반 이상을 차지한다. 튜플로 바꾸면 대역폭이 크게 준다.
 *
 * [id, lon, lat, statusCode, battery]
 */
export type RobotDelta = [string, number, number, number, number]

export interface DeltaFrame {
  /** 서버 타임스탬프(ms) */
  t: number
  /** 순번. 클라이언트에서 유실/역전 감지에 쓴다. */
  seq: number
  updates: RobotDelta[]
}

export interface FleetMeta {
  size: number
  tickMs: number
  zones: string[]
  /** 초기 스냅샷 시점의 상태별 분포 */
  initialDistribution: Record<StatusCode, number>
}
