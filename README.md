# Fleet Ops Console

로봇 플릿(AMR) **실시간 관제 콘솔**. 2,000대 규모 플릿의 위치·상태를 지도와 목록에서
동시에 추적하고, 렌더링 방식에 따른 성능 차이를 화면에서 직접 계측한다.

Next.js 15 **App Router** · React 19 · TypeScript · **OpenLayers** · Zustand · SSE

---

## 이 프로젝트가 답하려는 문제

대규모 플릿 관제 화면은 프론트엔드 입장에서 두 개의 상충하는 요구가 만난다.

1. **초당 수천 건의 위치 갱신**을 60fps로 그려야 한다.
2. 동시에 **목록·필터·선택** 같은 평범한 인터랙션이 끊기면 안 된다.

두 요구를 같은 렌더 파이프라인에 태우면 반드시 한쪽이 죽는다. 이 프로젝트는
**갱신 빈도에 따라 상태를 어디에 둘지 나누는 것**으로 문제를 푼다.

| 데이터 | 갱신 빈도 | 보관 위치 | 렌더 경로 |
| --- | --- | --- | --- |
| 로봇 좌표·상태 | 10Hz × 2,000대 | `FleetClient` 내부 `Map` (React 밖) | OpenLayers 피처 직접 변경 |
| 목록 스냅샷 | 4Hz (스로틀) | `useState` | 가상 스크롤 (`@tanstack/react-virtual`) |
| 집계 카운터 | 2.5Hz (스로틀) | `useState` | 일반 렌더 |
| 선택·필터·렌더모드 | 사람 조작 빈도 | Zustand | 일반 렌더 |
| 사이트 메타데이터 | 정적 | 서버 | **Server Component** (클라이언트 번들 0) |

---

## 실행

```bash
npm install
npm run dev          # http://localhost:3000/fleet
```

환경변수 (`.env.example` 참고):

```bash
FLEET_SIZE=2000      # 시뮬레이션 로봇 대수
FLEET_TICK_MS=100    # 서버 tick 주기
```

```bash
npm run typecheck    # tsc --noEmit
npm test             # Vitest 단위 테스트 (24개)
npm run test:e2e     # Playwright E2E
npm run build        # 프로덕션 빌드
```

---

## 구조

```
app/
  layout.tsx                        Server — 루트 셸
  fleet/
    layout.tsx                      Server — 중첩 레이아웃(헤더)
    page.tsx                        Server — 초기 스냅샷 + generateMetadata
    loading.tsx                     Suspense 폴백 (스켈레톤)
    error.tsx                       Client — 에러 바운더리
    _components/
      SiteInfoPanel.tsx             Server — 정적 사이트 정보
      FleetShell.tsx                Client — 클라이언트 트리 루트
      FleetProvider.tsx             Client — SSE 수명주기
      FleetMap.tsx                  Client — OpenLayers (Canvas / WebGL)
      FleetTable.tsx                Client — 가상 스크롤 목록
      LiveStatusBar.tsx             Client — 실시간 집계
      FilterBar.tsx                 Client — 검색·상태 필터
      RenderModeToggle.tsx          Client — 벤치마크 스위치
      StatsOverlay.tsx              Client — FPS·프레임 계측
  api/fleet/stream/route.ts         Route Handler — SSE (ReadableStream)

lib/
  types.ts        도메인 타입 (statusCode를 숫자로 두는 이유 포함)
  geo.ts          EPSG:4326 ↔ EPSG:3857 변환 (순수 함수)
  delta.ts        델타 병합·집계·필터 (순수 함수)
  fleet-client.ts 클라이언트 실시간 보관소 ★ 핵심 설계
  simulator.ts    서버 사이드 플릿 시뮬레이터 (결정적 PRNG)

store/fleet-store.ts   Zustand — UI 상태 전용
tests/                 Vitest — geo, delta
e2e/                   Playwright
```

---

## 설계 결정

### 1. 좌표를 React state에 두지 않는다

2,000대 × 10Hz = 초당 20,000회 상태 변경이다. 이걸 `useState`나 Zustand에 넣으면
리렌더만으로 프레임 예산이 전부 소진된다. 좌표의 원본은 `FleetClient` 내부의 plain
`Map`이고, 프레임이 오면 **OpenLayers 피처를 직접 변경**한다. React는 이 경로에
전혀 관여하지 않는다.

Zustand는 `selectedId`, `statusFilter`, `query`, `renderMode`처럼 **사람이 만드는
빈도**의 상태만 담당한다. → `store/fleet-store.ts`

### 2. Server Component 경계

- **서버**: 초기 스냅샷 조회, 초기 집계, `generateMetadata`, 정적 사이트 정보
- **클라이언트**: 지도(Canvas/WebGL), EventSource, 가상 스크롤, 실시간 집계

`page.tsx`는 `SiteInfoPanel`(Server Component)을 **prop으로 주입**한다.
`FleetShell`이 `'use client'`임에도 `SiteInfoPanel`의 코드는 클라이언트 번들에
포함되지 않는다 — composition 패턴. `FleetShell` 안에서 직접 import했다면
그 순간 서버 컴포넌트가 아니게 된다.

### 3. WebSocket이 아니라 SSE

데이터 흐름이 서버 → 클라이언트 단방향이고, HTTP 위에서 동작해 프록시를 그대로
통과하며, `EventSource`가 재연결과 `Last-Event-ID`를 브라우저 레벨에서 처리한다.
양방향 제어(로봇 정지·호출)가 들어오면 WebSocket으로 갈아탈 지점이다.

### 4. 델타 프레임을 튜플로 보낸다

`{"id":"RB-00001","lon":126.9,...}` 대신 `["RB-00001",126.9,37.2,1,80]`.
2,000대 규모에서 JSON 키 이름이 페이로드의 절반 이상을 차지한다.

### 5. `statusCode`를 문자열이 아닌 숫자로

OpenLayers `WebGLPointsLayer`의 스타일은 GPU 셰이더로 컴파일되는 표현식이고,
숫자 속성에서 가장 안정적으로 동작한다. 사람이 읽는 라벨은 표시 직전에만 붙인다.

---

## 벤치마크 — 여기서부터가 본론

우상단 **Canvas / WebGL** 토글은 같은 `VectorSource`를 공유한 채 렌더 경로만
바꾼다. 데이터가 동일하므로 비교가 공정하다. 우하단 계측 오버레이에서
FPS·최저 FPS·최장 프레임·수신 지연을 읽는다.

### 측정 절차

1. `FLEET_SIZE`를 500 → 1000 → 2000 → 5000으로 바꿔가며 `npm run build && npm start`
2. 각 조건에서 Canvas 모드로 30초 방치 후 FPS 기록 (**before**)
3. WebGL 모드로 전환, 동일하게 30초 후 기록 (**after**)
4. 지도를 팬·줌하며 최저 FPS도 함께 기록 — 평균만 보면 스터터가 숨는다

> ⚠️ 헤드리스 환경이나 GPU 가속이 꺼진 브라우저에서는 WebGL이 소프트웨어 렌더링
> (SwiftShader)으로 떨어져 Canvas보다 **느리게** 나온다. 반드시 실제 GPU가 있는
> 브라우저에서 측정할 것. `chrome://gpu`에서 하드웨어 가속을 먼저 확인한다.

### 결과 표 (직접 채울 것)

| 로봇 대수 | Canvas 평균 FPS | Canvas 최저 | WebGL 평균 FPS | WebGL 최저 | 개선 |
| --- | --- | --- | --- | --- | --- |
| 500 | | | | | |
| 1,000 | | | | | |
| 2,000 | | | | | |
| 5,000 | | | | | |

---

## 최적화 로드맵

`FleetMap.tsx`의 프레임 갱신 루프는 **의도적으로 소박하게** 짜여 있다. 이게
"before"다. 아래를 순서대로 적용하고 **단계마다 커밋과 측정치를 남기면** 그 자체가
포트폴리오가 된다.

1. **이벤트 디스패치 줄이기** — `setCoordinates`는 피처마다 change 이벤트를 낸다.
   프레임당 2,000회다. geometry를 silent로 갱신하고 프레임 끝에 `source.changed()`를
   한 번만 호출하면 2,000 → 1이 된다.
2. **rAF 코얼레싱** — SSE 프레임(10Hz)과 화면 주사율(60Hz)이 어긋난다.
   `requestAnimationFrame`으로 묶어 프레임당 정확히 한 번만 그린다.
3. **뷰포트 컬링** — `map.getView().calculateExtent()`로 화면 밖 로봇의 갱신을 건너뛴다.
   줌 인 상태에서 효과가 크다.
4. **Canvas → WebGL 전환** — 가장 큰 폭의 개선.
5. (선택) **Web Worker에서 델타 파싱** — JSON.parse가 메인 스레드를 막는 구간을
   Performance 탭에서 확인한 뒤에만 착수할 것.

---

## 알아둘 함정

- **히트 디텍션 API가 다르다.** Canvas는 동기 `forEachFeatureAtPixel`, WebGL은 비동기
  `layer.getFeatures(pixel)`. WebGL 전환 시 클릭 선택이 가장 먼저 깨지는 지점이라
  `FleetMap.tsx`에서 분기해 두었다.
- **좌표계.** 델타는 EPSG:4326(경위도)로 오고 지도는 EPSG:3857(Web Mercator)로 그린다.
  변환은 프레임당 갱신된 로봇에 대해서만 한 번 수행한다.
- **SSE 구독 해제.** `request.signal`의 abort에서 반드시 unsubscribe해야 한다.
  빠뜨리면 시뮬레이터 구독자가 계속 쌓여 메모리 누수가 난다.
- **지도 타일.** OSM 공개 타일을 쓴다. 오프라인이면 타일만 비고 벡터 레이어는 정상
  동작한다. 실서비스라면 자체 타일 서버나 벡터 타일로 교체할 지점.

---

## 테스트 전략

순수 함수(`lib/geo.ts`, `lib/delta.ts`)를 먼저 테스트로 못 박았다. 좌표 변환과 델타
병합은 화면에 뭔가 그려지긴 하는데 값이 미묘하게 틀리는 방식으로 실패하기 때문에
눈으로는 잡히지 않는다.

- `tests/geo.test.ts` — 알려진 기준값, 왕복 변환, 극지방 클램프
- `tests/delta.test.ts` — seq 역전/중복 방어, 무변경 감지, 미지의 id 노출, 객체 아이덴티티 보존
- `e2e/fleet.spec.ts` — 서버 렌더 확인, SSE seq 증가, 선택 연동, 필터, 렌더모드 전환

캔버스 픽셀은 검증하지 않는다. 의미가 없고 깨지기만 한다.

---

## 다음에 붙일 것

- [ ] `/fleet/[id]` 상세 라우트 — 중첩 레이아웃 덕에 지도 인스턴스를 유지한 채 전환 가능
- [ ] Parallel Routes로 알림 패널 분리
- [ ] 로봇 경로(LineString) 히스토리 레이어
- [ ] 구역 폴리곤 오버레이 + 구역별 집계
- [ ] Server Actions로 로봇 정지/호출 명령 (여기서 WebSocket 전환 검토)
