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

패키지 매니저는 **Yarn 4**(Corepack)이다.

```bash
yarn install
yarn dev             # http://localhost:3000/fleet
```

> ⚠️ **Yarn PnP 로는 동작하지 않는다.** Tailwind v4 의 postcss 플러그인이 `require` 에
> `conditions` 옵션을 쓰는데 PnP 가 이를 지원하지 않아, 개발 서버와 프로덕션 빌드가
> 모두 실패한다(`Some options passed to require() aren't supported by PnP yet`).
> 그래서 `.yarnrc.yml` 에 `nodeLinker: node-modules` 를 지정해 두었다. 이 파일을
> 지우면 앱이 뜨지 않는다.

환경변수 (`.env.example` 참고):

```bash
FLEET_SIZE=2000      # 시뮬레이션 로봇 대수
FLEET_TICK_MS=100    # 서버 tick 주기
```

```bash
yarn typecheck       # tsc --noEmit
yarn test            # Vitest 단위 테스트 (34개)
yarn test:e2e        # Playwright E2E
yarn build           # 프로덕션 빌드
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

1. `FLEET_SIZE`를 2000 → 5000 → 20000으로 바꿔가며 `yarn build && yarn start`
2. 각 조건에서 Canvas 모드로 30초 방치 후 FPS 기록 (**before**)
3. WebGL 모드로 전환, 동일하게 30초 후 기록 (**after**)
4. 지도를 팬·줌하며 최저 FPS도 함께 기록 — 평균만 보면 스터터가 숨는다

> 💡 **2,000대로는 아무 차이도 안 보인다.** 최적화 전에도 60 FPS가 나온다. 차이가
> 드러나기 시작하는 지점이 20,000대다. 아래 "결과 표 — 최적화 단계" 참고.

> ⚠️ 헤드리스 환경이나 GPU 가속이 꺼진 브라우저에서는 WebGL이 소프트웨어 렌더링
> (SwiftShader)으로 떨어져 Canvas보다 **느리게** 나온다. 반드시 실제 GPU가 있는
> 브라우저에서 측정할 것. `chrome://gpu`에서 하드웨어 가속을 먼저 확인한다.

### 결과 표 — 렌더 경로 (직접 채울 것)

| 로봇 대수 | Canvas 평균 FPS | Canvas 최저 | WebGL 평균 FPS | WebGL 최저 | 개선 |
| --- | --- | --- | --- | --- | --- |
| 500 | | | | | |
| 1,000 | | | | | |
| 2,000 | | | | | |
| 5,000 | | | | | |

### 결과 표 — 최적화 단계

최적화 단계는 **단계별 커밋을 하나씩 체크아웃해** 측정한다.

```bash
git log --oneline               # 단계별 커밋 확인
git checkout <커밋>             # 해당 단계 상태로 이동
FLEET_SIZE=20000 yarn dev       # 측정 → http://localhost:3000/fleet
```

> ⚠️ **부하를 충분히 올려야 차이가 보인다.** 2,000대와 5,000대에서는 최적화 전에도
> 60 FPS가 나온다. 아낀 시간이 16.6ms 프레임 예산 안에 묻히기 때문이다. 병목이
> 아닌 곳을 최적화하면 측정에 아무것도 안 나온다 — 그 사실 자체가 배울 점이다.

측정 환경: 설치된 Chrome을 헤드리스로 구동, **dev 빌드**, `FLEET_SIZE=20000`,
뷰포트 1400×900, Canvas 모드, 워밍업 후 9초 측정. dev 빌드라 절대값은 프로덕션보다
나쁘다 — 상대 비교용으로만 쓸 것.

| 단계 | 평균 FPS | 최저 FPS | 최장 프레임 |
| --- | --- | --- | --- |
| 0. 소박한 루프 (before) | **1.6 ~ 28.0** (불안정) | 0.9 ~ 8.6 | 67 ~ 955ms |
| 1. silent 갱신 + `changed()` 1회 | 57.7 | 12.0 | 33.2ms |
| 2. + rAF 코얼레싱 | 56.2 | 10.0 | 34.2ms |
| 3. + 뷰포트 컬링 (줌아웃) | 58.2 | 10.0 | 32.5ms |
| 3. + 뷰포트 컬링 (줌인) | 60.1 | 4.7* | **17.3ms** |

읽는 법 — 표에서 실제로 배울 것은 네 가지다.

1. **1단계가 개선의 거의 전부다.** 1.6~28 → 58 FPS. 나머지 두 단계는 이 조건에서
   측정 오차 안에 있다. "최적화 4개를 했으니 4배 좋아졌다"가 아니다.

2. **before는 재현이 안 된다.** 같은 커밋을 3회 측정해 23.2 / 1.6 / 28.0이 나왔다.
   프레임 예산을 초과한 시스템은 붕괴가 자기 강화되기 때문이다(프레임이 늦으면
   델타가 쌓이고, 쌓인 델타가 다음 프레임을 더 늦춘다). **병목 상태의 측정값은
   불안정하다**는 것 자체가 관찰 결과다. 최적화 후에는 56~60으로 안정적이다.

3. **2단계는 예상대로 안 나타난다.** 설계상 이 조건(10Hz, 포그라운드 탭)에서는
   이득이 없다. 근거는 위 "2. rAF 코얼레싱" 절에 적어 두었다. 효과를 보려면
   `FLEET_TICK_MS`를 16 아래로 내리거나 탭을 백그라운드로 보내야 한다.

4. **3단계는 평균 FPS로는 안 보이고 최장 프레임으로 보인다.** 이미 60 FPS 상한에
   걸려 있어 평균은 못 오른다. 대신 줌인 시 최장 프레임이 32.5 → 17.3ms로 절반이
   된다. 이게 컬링이 실제로 일했다는 증거다. **평균만 보면 놓친다.**

\* 줌인 행의 최저 FPS 4.7은 컬링 탓이 아니다. 측정을 위해 지도를 더블클릭으로
확대하는 동안의 줌 애니메이션 스터터가 잡힌 값이다. `StatsOverlay`는 최저 FPS를
렌더 모드가 바뀔 때만 리셋하므로 조작 중 스터터가 남는다.

---

## 최적화 로드맵

`FleetMap.tsx`의 프레임 갱신 루프에 1~4단계를 순서대로 적용했다. 각 단계가 **무엇을
아끼는지**와 **어떤 대가를 치르는지**를 아래에 적고, 근거가 되는 OpenLayers 내부
동작은 `FleetMap.tsx`의 해당 지점 주석에 남겼다.

### 1. 이벤트 디스패치 줄이기 ✅

`setCoordinates` 한 번이 실제로 하는 일은 좌표 대입이 아니다.

```
Point.setCoordinates → geometry.changed()          revision++ / 'change'
  → Feature.handleGeometryChange_ → feature.changed()   'change'
    → VectorSource.handleFeatureChange_
        ├ geometry.getExtent()
        ├ featuresRtree_.update(extent, feature)   ← RBush remove + insert
        ├ source.changed()
        └ dispatchEvent('changefeature')
```

프레임당 2,000대면 이벤트 6,000회 + RBush 재삽입 2,000회다. 주석이 지목한
이벤트보다 **R-tree 리밸런싱이 더 무겁다.**

→ `Point`의 내부 `flatCoordinates`를 인플레이스로 덮어쓰고, 루프가 끝난 뒤
`source.changed()`를 한 번만 호출한다.

**전제조건이 두 개 있고, 둘 다 빠뜨리면 조용히 깨진다.**

- `useSpatialIndex: false`가 **필수**다. 기본값이면 R-tree가 옛 좌표에 멈추고,
  Canvas 렌더러는 매 프레임 `getFeaturesInExtent()`로 그릴 대상을 고르기 때문에
  줌인 상태에서 로봇이 사라지거나 옛 자리에 남는다. 이 앱은 피처 수가 고정이고
  로딩 전략도 없어서 공간 인덱스로 얻을 게 없다.
- `flatCoordinates` 배열 아이덴티티가 유지된다는 가정에 기대고 있다. 공개 API가
  아니므로 `tests/ol-invariants.test.ts`가 `ol` 업그레이드 시 깨지도록 못 박았다.
- `useGeographic()`을 켜면 안 된다. 사용자 투영이 설정되면 렌더러가
  `simplifyTransformed`에서 geometry를 **clone해 revision으로 메모이즈**하므로,
  revision이 안 오르는 silent 쓰기는 영원히 무시된다.

### 2. rAF 코얼레싱 ✅

`onFrame`에서는 변한 **id만** Set에 적고, 실제 쓰기는 `requestAnimationFrame`에서
한 번에 한다. 값을 큐에 쌓지 않는 게 핵심 — 플러시 시점에 최신값을 읽으므로 한
로봇이 한 화면 프레임 안에 세 번 갱신돼도 좌표 변환은 한 번만 한다.

10Hz vs 60Hz라 평상시에는 프레임이 겹치지 않는다. **값을 하는 구간은 따로 있다.**

- 백그라운드 탭에서 rAF가 멈춘다 → OL 작업이 0이 되고, 복귀 시 한 번에 반영된다.
- 메인 스레드가 밀려 프레임이 몰려 들어올 때(재연결 직후) 한 번의 쓰기로 접힌다.
- `FLEET_TICK_MS`를 16 아래로 내리면 곧바로 배수만큼 이득이다.
- 상시 이득: SSE `onmessage` 태스크가 짧아진다. 무거운 쓰기가 네트워크 콜백에서
  페인트 직전 프레임 콜백으로 옮겨가 입력 처리와 덜 충돌한다.

대가는 최대 한 화면 프레임(~16ms)의 표시 지연.

### 3. 뷰포트 컬링 ✅

플러시마다 뷰 extent를 **한 번** 계산해(로봇마다 계산하면 절약분을 초과한다)
화면 밖 로봇의 좌표 변환·쓰기를 건너뛴다.

- 판정은 **새 위치와 직전에 쓴 위치를 함께** 본다. 새 위치만 보면 화면을 벗어나는
  로봇의 갱신이 끊겨 경계에 얼어붙는다.
- 경계에 걸친 로봇이 떨지 않도록 `renderBuffer`(기본 100px)보다 넉넉한 128px
  여유를 둔다.
- **컬링의 유일한 구멍**: 화면 밖에서 갱신을 건너뛴 로봇이 그대로 멈춰 서면 델타에
  더 이상 등장하지 않으므로, 사용자가 그쪽으로 팬했을 때 옛 좌표가 남는다. 로봇이
  아니라 **뷰가 움직여서** 생기는 얼룩이라 데이터 이벤트로는 안 씻긴다. → `moveend`에
  전체를 한 번 다시 쓴다(사람 조작 빈도라 비용 없음).
- 줌 아웃해서 전체가 보이는 상태에서는 당연히 효과가 0이다.
- ⚠️ 계측 오버레이의 **"갱신 대수"로는 컬링 효과를 볼 수 없다.** 그 값은 SSE 델타에
  몇 대가 담겨 왔는지(`FleetClient.changedCount`)이고, 우리가 실제로 몇 대를 썼는지와
  무관하다. 효과는 FPS·최장 프레임으로 본다.

### 4. Canvas → WebGL 전환 ✅

갱신 루프에 렌더 모드 분기가 없다. 그게 1~3단계의 성과다. 다만 **우연이 아니라
구체적인 이유로** 동작한다.

- `WebGLPointsLayerRenderer`는 피처별 캐시에 `getFlatCoordinates()`가 돌려준
  **배열을 참조로** 들고 있고, `rebuildBuffers_`가 소스 revision이 오를 때마다 그
  참조를 다시 읽는다. 그래서 인플레이스 쓰기가 이벤트 없이 반영된다.
- 반면 **속성**(`statusCode`)은 `changefeature` 이벤트로만 갱신된다. 그래서 루프는
  좌표만 silent로 쓰고 `statusCode`는 일부러 `feature.set()`으로 쓴다. 이 비대칭이
  "위치는 움직이는데 색만 안 바뀌는" 버그의 정체다.

제약:

- 팬·줌 **중**에는 점이 멈춘다(`viewHints`의 ANIMATING/INTERACTING 동안 rebuild
  스킵). `followSelected`의 400ms 애니메이션 구간도 해당한다. Canvas에는 없다.
- WebGLPoints에는 뷰포트 컬링이 없다. 화면 밖 피처까지 전부 재업로드하므로
  3단계가 아끼는 건 CPU 쪽뿐이다.
- 히트 디텍션이 프레임당 렌더 패스를 하나 더 쓴다. WebGL FPS가 기대만 못하면 첫
  손질 지점 — 단 클릭 선택을 포기해야 한다.

### 5. (선택) Web Worker에서 델타 파싱

`JSON.parse`가 메인 스레드를 막는 구간을 Performance 탭에서 확인한 뒤에만 착수할 것.

---

## 알아둘 함정

- **히트 디텍션 API가 다르다.** Canvas는 동기 `forEachFeatureAtPixel`, WebGL은 비동기
  `layer.getFeatures(pixel)`. WebGL 전환 시 클릭 선택이 가장 먼저 깨지는 지점이라
  `FleetMap.tsx`에서 분기해 두었다.
- **좌표계.** 델타는 EPSG:4326(경위도)로 오고 지도는 EPSG:3857(Web Mercator)로 그린다.
  변환은 프레임당 갱신된 로봇에 대해서만 한 번 수행한다.
- **SSE 구독 해제.** `request.signal`의 abort에서 반드시 unsubscribe해야 한다.
  빠뜨리면 시뮬레이터 구독자가 계속 쌓여 메모리 누수가 난다.
- **WebGLPoints는 deprecated.** `ol` 10은 `ol/layer/WebGLVector`로 옮기라고 안내하지만
  **그대로 갈아타면 점이 움직이지 않는다.** WebGLVector의 렌더러는 좌표를
  `MixedGeometryBatch`에 담고 그 배치를 `changefeature` 이벤트로만 갱신하므로, 1단계의
  silent 쓰기가 전부 무시된다. 비교 측정 전까지는 deprecated 레이어를 의식적으로 유지한다.
- **지도 타일.** OSM 공개 타일을 쓴다. 오프라인이면 타일만 비고 벡터 레이어는 정상
  동작한다. 실서비스라면 자체 타일 서버나 벡터 타일로 교체할 지점.

---

## 테스트 전략

순수 함수(`lib/geo.ts`, `lib/delta.ts`)를 먼저 테스트로 못 박았다. 좌표 변환과 델타
병합은 화면에 뭔가 그려지긴 하는데 값이 미묘하게 틀리는 방식으로 실패하기 때문에
눈으로는 잡히지 않는다.

- `tests/geo.test.ts` — 알려진 기준값, 왕복 변환, 극지방 클램프, 컬링 판정 경계값
- `tests/delta.test.ts` — seq 역전/중복 방어, 무변경 감지, 미지의 id 노출, 객체 아이덴티티 보존
- `tests/ol-invariants.test.ts` — **OpenLayers 내부 동작에 대한 가정**을 못 박는다.
  1단계의 silent 좌표 갱신은 `getFlatCoordinates()`가 복사본이 아니라 내부 배열 그
  자체를 돌려준다는, 공개 API가 아닌 성질에 기대고 있다. `ol` 업그레이드가 이 가정을
  깨면 지도는 에러 없이 그냥 얼어붙는다 — 타입으로도 눈으로도 안 잡히는 실패다.
  그래서 가정 자체를 테스트로 만들었다. 여기가 빨개지면 `FleetMap.tsx`의 갱신 경로를
  다시 검토해야 한다는 신호다.
- `e2e/fleet.spec.ts` — 서버 렌더 확인, SSE seq 증가, 선택 연동, 필터, 렌더모드 전환

캔버스 픽셀은 검증하지 않는다. 의미가 없고 깨지기만 한다.

---

## 다음에 붙일 것

- [ ] `/fleet/[id]` 상세 라우트 — 중첩 레이아웃 덕에 지도 인스턴스를 유지한 채 전환 가능
- [ ] Parallel Routes로 알림 패널 분리
- [ ] 로봇 경로(LineString) 히스토리 레이어
- [ ] 구역 폴리곤 오버레이 + 구역별 집계
- [ ] Server Actions로 로봇 정지/호출 명령 (여기서 WebSocket 전환 검토)
