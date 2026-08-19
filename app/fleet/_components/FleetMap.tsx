'use client'

import { useEffect, useRef } from 'react'

import Feature from 'ol/Feature'
import OLMap from 'ol/Map'
import View from 'ol/View'
import Point from 'ol/geom/Point'
import TileLayer from 'ol/layer/Tile'
import VectorLayer from 'ol/layer/Vector'
import WebGLPointsLayer from 'ol/layer/WebGLPoints'
import OSM from 'ol/source/OSM'
import VectorSource from 'ol/source/Vector'
import { Circle as CircleStyle, Fill, Stroke, Style } from 'ol/style'

import {
  extentContainsXY,
  lonLatExtent,
  mercatorX,
  mercatorY,
  padExtent,
  toMercator,
  toMercatorExtent,
} from '@/lib/geo'
import { STATUS_COLORS, type StatusCode } from '@/lib/types'
import { useFleetUi } from '@/store/fleet-store'

import { useFleet } from './FleetProvider'

/*
 * ══════════════════════════════════════════════════════════════════════════
 *  최적화 단계별 위치 안내 — README 의 "최적화 로드맵" 절과 짝을 이룬다.
 *  각 지점에 [1단계]~[4단계] 태그를 달아 뒀으니 태그로 검색해도 된다.
 * ══════════════════════════════════════════════════════════════════════════
 *
 *  [1단계] 이벤트 디스패치 줄이기
 *      · new VectorSource({ useSpatialIndex: false })    ← effect 1 (지도 초기화)
 *      · flush() 안, flatCoordinates 인플레이스 쓰기      ← effect 2
 *      · flush() 끝, source.changed() 딱 1회             ← effect 2
 *      · lib/geo.ts  mercatorX / mercatorY  (할당 0인 스칼라 변환)
 *      · tests/ol-invariants.test.ts  (기댄 ol 내부 동작을 테스트로 못 박음)
 *
 *  [2단계] rAF 코얼레싱
 *      · dirty Set + rafId 선언, onFrame 콜백, flush 예약  ← effect 2
 *
 *  [3단계] 뷰포트 컬링
 *      · CULL_MARGIN_PX (바로 아래)
 *      · flush() 앞부분 뷰 extent 1회 계산                ← effect 2
 *      · 루프 안 컬링 판정                                ← effect 2
 *      · moveend → resyncAll (컬링의 유일한 구멍 막기)     ← effect 2
 *      · lib/geo.ts  padExtent / extentContainsXY
 *
 *  [4단계] Canvas → WebGL
 *      · 갱신 루프 코드 변경 **없음**. 왜 없어도 되는지와 제약은
 *        effect 2 아래의 ⚑ 블록에 정리했다.
 *      · WebGLPointsLayer 생성부의 ⚠️ deprecated 함정 주석도 함께 볼 것.
 */

/**
 * [3단계] 컬링 판정에 쓰는 화면 밖 여유(px).
 *
 * 0으로 두면 화면 경계에 딱 걸친 로봇이 프레임마다 컬링/갱신을 왕복하며 떨린다.
 * VectorLayer 의 기본 renderBuffer(100px)보다 넉넉하게 잡아, "렌더러는 그리는데
 * 우리는 갱신을 건너뛴 로봇" 이 생기지 않게 한다.
 *
 * 판정 자체는 lib/geo.ts 의 순수 함수로 빼서 테스트로 덮었다. 경계에서 틀리면
 * 로봇이 조용히 사라지는 방식으로 실패하기 때문이다.
 */
const CULL_MARGIN_PX = 128

/**
 * OpenLayers 관제 지도.
 *
 * 이 컴포넌트는 React 렌더 사이클 밖에서 동작한다. 실시간 프레임이 와도
 * setState 를 호출하지 않고 OL 피처를 직접 변경한다. React 가 관여하는 건
 * 마운트/언마운트와 renderMode·selectedId 같은 저빈도 UI 상태뿐이다.
 */
export default function FleetMap() {
  const fleet = useFleet()
  const containerRef = useRef<HTMLDivElement>(null)

  const mapRef = useRef<OLMap | null>(null)
  const sourceRef = useRef<VectorSource<Feature<Point>> | null>(null)
  const featureIndex = useRef(new Map<string, Feature<Point>>())
  const canvasLayerRef = useRef<VectorLayer<VectorSource<Feature<Point>>> | null>(null)
  const webglLayerRef = useRef<WebGLPointsLayer<VectorSource<Feature<Point>>> | null>(null)
  const selectionSourceRef = useRef<VectorSource<Feature<Point>> | null>(null)

  const renderMode = useFleetUi((s) => s.renderMode)
  const selectedId = useFleetUi((s) => s.selectedId)
  const followSelected = useFleetUi((s) => s.followSelected)

  // ── 1. 지도 초기화 (한 번만) ──────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const robots = fleet.list()

    const features = robots.map((r) => {
      const feature = new Feature({ geometry: new Point(toMercator(r.lon, r.lat)) })
      feature.setId(r.id)
      // 세 번째 인자 silent=true — 초기 구성 중에는 change 이벤트를 흘리지 않는다.
      feature.set('statusCode', r.statusCode, true)
      featureIndex.current.set(r.id, feature)
      return feature
    })

    // ── [1단계] useSpatialIndex: false ─────────────────────────────────────
    //
    // 이 한 줄은 성능 옵션이 아니라 **effect 2 의 silent 좌표 쓰기가 성립하기 위한
    // 전제조건**이다. 순서대로 따라가 보자.
    //
    //  1. 기본값(true)이면 소스가 RBush 공간 인덱스를 들고, 피처가 change 이벤트를
    //     낼 때마다 해당 항목을 지우고 새 extent 로 다시 넣는다.
    //       → ol/source/Vector.js  handleFeatureChange_()  ...  featuresRtree_.update()
    //  2. effect 2 는 좌표를 silent 로 쓴다. change 이벤트가 안 나간다.
    //  3. 그러면 인덱스는 **초기 좌표에 영구히 멈춘다.**
    //  4. Canvas 렌더러는 매 프레임 그 인덱스로 그릴 대상을 고른다.
    //       → ol/renderer/canvas/VectorLayer.js  vectorSource.getFeaturesInExtent()
    //
    // 이 조합이 만드는 버그의 증상: 전체가 보이는 줌 아웃에서는 아무 문제가 없고,
    // **줌인하면 로봇이 사라지거나 옛 자리에 유령처럼 남는다.** 인덱스가 낡았다는
    // 신호가 어디에도 안 뜨기 때문에 원인을 찾기가 아주 고약하다.
    //
    // 인덱스를 끄면 getFeaturesInExtent() 가 전체 배열을 돌려준다(ol 이 문서화한
    // 동작이다). 낡을 인덱스 자체가 없어진다.
    //
    // 대가: Canvas 렌더러가 화면 밖 피처까지 replay 대상에 넣는다. 그래도 끄는 게
    // 맞다 — 피처 수가 고정(2,000)이고 로딩 전략도 없어서 공간 인덱스로 얻을 게
    // 원래 없었고, 최종 목적지인 WebGLPointsLayer 는 애초에 뷰포트 컬링을 하지
    // 않는다. 갱신 쪽 컬링은 3단계에서 우리가 직접 한다.
    const source = new VectorSource<Feature<Point>>({
      features,
      wrapX: false,
      useSpatialIndex: false,
    })
    sourceRef.current = source

    // ── Canvas 렌더링 경로 ──
    // 스타일 객체를 상태 코드별로 캐싱한다. 스타일 함수 안에서 매번 new Style()
    // 을 만들면 피처 수 × 프레임 수만큼 객체가 생겨 GC 가 폭발한다.
    const styleCache = new Map<number, Style>()
    const styleFor = (code: number): Style => {
      let style = styleCache.get(code)
      if (!style) {
        style = new Style({
          image: new CircleStyle({
            radius: 4,
            fill: new Fill({ color: STATUS_COLORS[code as StatusCode] ?? '#ffffff' }),
          }),
        })
        styleCache.set(code, style)
      }
      return style
    }

    const canvasLayer = new VectorLayer({
      source,
      style: (feature) => styleFor(feature.get('statusCode') as number),
      visible: true,
    })
    canvasLayerRef.current = canvasLayer

    // ── WebGL 렌더링 경로 ──
    // 스타일은 GPU 셰이더로 컴파일되는 표현식이다. 그래서 statusCode 를 문자열이
    // 아니라 숫자로 들고 다닌다(lib/types.ts 주석 참고).
    //
    // ⚠️ ol 10 에서 WebGLPointsLayer 는 deprecated 이고 ol/layer/WebGLVector 로
    // 옮기라고 안내한다. **그대로 갈아타면 점이 움직이지 않는다.** WebGLVector 의
    // 렌더러는 좌표를 MixedGeometryBatch 에 담고, 그 배치를 changefeature
    // 이벤트로만 갱신한다(ol/renderer/webgl/VectorLayer.js). 좌표 배열 참조를
    // 다시 읽어주는 WebGLPoints 와 달라서, 우리의 silent 쓰기가 전부 무시된다.
    // 마이그레이션하려면 피처별 change 이벤트를 되살리거나(= 1단계 되돌리기)
    // 배치를 직접 무효화하는 경로를 찾아야 한다. 그 비교를 하기 전까지는
    // deprecated 레이어를 의식적으로 유지한다.
    const webglLayer = new WebGLPointsLayer({
      source,
      visible: false,
      style: {
        'circle-radius': 4,
        'circle-fill-color': [
          'match',
          ['get', 'statusCode'],
          0,
          STATUS_COLORS[0],
          1,
          STATUS_COLORS[1],
          2,
          STATUS_COLORS[2],
          3,
          STATUS_COLORS[3],
          '#ffffff',
        ],
        'circle-opacity': 0.95,
      },
    })
    webglLayerRef.current = webglLayer

    // 선택 강조는 별도의 작은 레이어로 뺀다. 본 레이어를 restyle 하면
    // 2,000개 피처 전체가 다시 그려진다.
    const selectionSource = new VectorSource<Feature<Point>>({ wrapX: false })
    selectionSourceRef.current = selectionSource
    const selectionLayer = new VectorLayer({
      source: selectionSource,
      style: new Style({
        image: new CircleStyle({
          radius: 10,
          stroke: new Stroke({ color: '#fbbf24', width: 2 }),
          fill: new Fill({ color: 'rgba(251, 191, 36, 0.15)' }),
        }),
      }),
      zIndex: 10,
    })

    const initialExtent = lonLatExtent(robots.map((r) => [r.lon, r.lat] as const))

    const map = new OLMap({
      target: containerRef.current,
      layers: [new TileLayer({ source: new OSM() }), canvasLayer, webglLayer, selectionLayer],
      view: new View({ center: toMercator(126.9012, 37.241), zoom: 14 }),
      controls: [],
    })
    mapRef.current = map

    if (initialExtent) {
      map.getView().fit(toMercatorExtent(initialExtent), { padding: [40, 40, 40, 40] })
    }

    // ── 클릭 → 선택 ──
    // 주의: Canvas 레이어와 WebGL 레이어의 히트 디텍션 API 가 다르다.
    // Canvas 는 동기 forEachFeatureAtPixel, WebGL 은 비동기 getFeatures(pixel).
    // 실제로 WebGL 로 전환할 때 가장 먼저 깨지는 지점이라 분기해 둔다.
    const onClick = (evt: { pixel: number[] }) => {
      const mode = useFleetUi.getState().renderMode
      if (mode === 'canvas') {
        const hit = map.forEachFeatureAtPixel(evt.pixel, (f) => f, {
          layerFilter: (l) => l === canvasLayer,
          hitTolerance: 5,
        })
        useFleetUi.getState().select(hit ? String(hit.getId()) : null)
      } else {
        void webglLayer.getFeatures(evt.pixel).then((hits) => {
          useFleetUi.getState().select(hits.length ? String(hits[0].getId()) : null)
        })
      }
    }
    map.on('click', onClick)

    return () => {
      map.un('click', onClick)
      map.setTarget(undefined)
      webglLayer.dispose()
      map.dispose()
      mapRef.current = null
      featureIndex.current.clear()
    }
  }, [fleet])

  // ── 2. 실시간 프레임 → 피처 갱신 ─────────────────────────────────────────
  //
  // 최적화 1·2·3 단계가 전부 이 effect 안에 있다. 코드 순서대로 읽으면 된다.
  //
  //   [2단계]  dirty Set / rafId 선언
  //   [3단계]  flush() 앞부분 — 뷰 extent 1회 계산
  //   [1단계]  flush() 루프 안 — flatCoordinates 인플레이스 쓰기
  //   [3단계]  flush() 루프 안 — 컬링 판정
  //   [1단계]  flush() 끝 — source.changed() 1회
  //   [2단계]  onFrame 콜백 — id 만 적고 rAF 예약
  //   [3단계]  moveend → resyncAll
  //
  // ── 최적화 전 원본(git show HEAD:...FleetMap.tsx) ──
  //
  //   useEffect(() => {
  //     const unsubscribe = fleet.onFrame((changed) => {      // ← SSE 태스크 안에서
  //       const index = featureIndex.current                  //   전부 처리 (2단계 표적)
  //       for (const id of changed) {                         // ← 화면 밖도 전부 (3단계 표적)
  //         const feature = index.get(id)
  //         if (!feature) continue
  //         const robot = fleet.get(id)
  //         if (!robot) continue
  //
  //         const [x, y] = toMercator(robot.lon, robot.lat)    // ← 배열 할당 2,000회/프레임
  //         feature.getGeometry()?.setCoordinates([x, y])      // ← 1단계의 주 표적
  //
  //         if (feature.get('statusCode') !== robot.statusCode) {
  //           feature.set('statusCode', robot.statusCode)
  //         }
  //       }
  //     })
  //     return unsubscribe
  //   }, [fleet])
  //
  // 아래 코드를 이 원본과 나란히 놓고 읽으면 각 단계가 정확히 무엇을 바꿨는지
  // 보인다. 바뀐 줄 수는 얼마 안 되고, 대신 **왜 그래도 안전한지**를 아는 데
  // 필요한 배경지식이 많다. 그 배경이 아래 주석들이다.
  useEffect(() => {
    const source = sourceRef.current
    if (!source) return

    // ── [2단계] 코얼레싱 상태 ──────────────────────────────────────────────
    //
    // dirty 에는 **id 만** 넣는다. 좌표값을 큐에 쌓지 않는 게 핵심이다.
    //
    //   값을 쌓으면      : 같은 로봇이 한 화면 프레임에 3번 오면 3개가 쌓이고,
    //                      플러시에서 3번 다 쓰거나 마지막 것만 골라내야 한다.
    //   id 만 적으면     : Set 이 알아서 합쳐주고, 플러시 시점에 fleet 에서 최신값을
    //                      한 번 읽으면 된다. 좌표 변환도 쓰기도 정확히 1회.
    //
    // 즉 "무엇이 변했는지" 만 기록하고 "무슨 값인지" 는 쓰는 순간에 조회한다.
    // 실시간 렌더 루프의 일반적인 패턴이다(dirty flag + pull).
    const dirty = new Set<string>()

    // 0 = 예약 없음. rAF 핸들은 항상 0보다 크므로 센티널로 0을 쓸 수 있다.
    let rafId = 0

    const flush = () => {
      rafId = 0
      if (dirty.size === 0) return

      const index = featureIndex.current

      // ── [3단계] 뷰 extent 를 프레임당 한 번만 계산 ────────────────────────
      //
      // 로봇마다 calculateExtent() 를 부르면 컬링으로 아낀 것보다 더 쓴다.
      // 루프 밖에서 한 번 계산해 두고 2,000번 재사용한다.
      //
      // resolution 은 "지도 단위(m) / 픽셀" 이다. 그래서 픽셀 여유를 지도 단위로
      // 바꿀 때 곱해 준다. 줌 레벨이 달라지면 같은 128px 이 다른 미터 값이 된다.
      //
      // 첫 렌더 전에는 resolution 이 undefined 다. 그때는 viewExtent 를 null 로
      // 두고 **컬링을 아예 하지 않는다** — 확신이 없을 때는 전부 갱신하는 쪽이
      // 안전하다. 반대로 하면 초기 화면이 빈 지도로 보인다.
      const view = mapRef.current?.getView()
      const size = mapRef.current?.getSize()
      const resolution = view?.getResolution()
      const viewExtent =
        view && size && resolution
          ? padExtent(view.calculateExtent(size), resolution * CULL_MARGIN_PX)
          : null

      for (const id of dirty) {
        const feature = index.get(id)
        if (!feature) continue
        const robot = fleet.get(id)
        if (!robot) continue

        // ── [1단계] 좌표를 이벤트 없이 쓴다 ────────────────────────────────
        //
        // before:  const [x, y] = toMercator(robot.lon, robot.lat)
        //          feature.getGeometry()?.setCoordinates([x, y])
        //
        // setCoordinates 한 줄이 실제로 하는 일:
        //
        //   Point.setCoordinates()
        //     └ geometry.changed()                    revision++ , 'change' 디스패치
        //         └ Feature.handleGeometryChange_()
        //             └ feature.changed()             'change' 디스패치
        //                 └ VectorSource.handleFeatureChange_()
        //                     ├ geometry.getExtent()          extent 재계산
        //                     ├ featuresRtree_.update(...)    RBush remove + insert ★
        //                     ├ source.changed()              소스 revision++ , 'change'
        //                     └ dispatchEvent('changefeature')
        //
        // 2,000대면 이벤트 6,000회 + RBush 재삽입 2,000회다. 로드맵 주석은
        // 이벤트를 지목했지만, 실제로 더 무거운 쪽은 ★ 표시한 R-tree 리밸런싱이다.
        //
        // after: Point 가 좌표를 담고 있는 내부 배열(flatCoordinates)을 직접 덮어쓴다.
        // setCoordinates 를 우회하므로 위 연쇄가 전부 일어나지 않는다. 대신 루프가
        // 끝난 뒤 source.changed() 를 딱 한 번 부른다(아래).
        //
        // getFlatCoordinates() 가 **복사본이 아니라 내부 배열 그 자체**를 돌려준다는
        // 점에 기대고 있다. 공개 API 로 보장된 동작이 아니라서 tests/ol-invariants.test.ts
        // 가 이 가정을 못 박는다. 여기가 깨지면 지도는 에러 없이 그냥 얼어붙는다.
        //
        // mercatorX/Y 를 스칼라로 쓰는 것도 같은 결의 이유다. toMercator 는 호출마다
        // 길이 2 배열을 새로 만들어 초당 20,000개의 단명 객체를 남긴다.
        const flat = feature.getGeometry()?.getFlatCoordinates()
        if (!flat) continue

        const x = mercatorX(robot.lon)
        const y = mercatorY(robot.lat)

        // ── [3단계] 컬링 판정 ─────────────────────────────────────────────
        //
        // 새 위치와 **직전에 쓴 위치**(= flat 에 아직 남아 있는 값)를 OR 로 본다.
        // 새 위치만 보면 이런 버그가 난다:
        //
        //   화면 안에 있던 로봇이 밖으로 나간다
        //     → 새 위치가 밖이라 갱신을 건너뛴다
        //     → flat 에는 마지막으로 쓴 "화면 안" 좌표가 남는다
        //     → 렌더러는 그 좌표를 계속 그린다
        //     → **로봇이 화면 경계에 얼어붙는다**
        //
        // 직전 위치도 함께 보면, 나가는 순간의 한 프레임은 반드시 써지고 그 값이
        // 화면 밖이 되어 다음 프레임부터 정상적으로 컬링된다.
        //
        // 반대 방향(밖 → 안)은 새 위치 검사가 잡아준다. 그래서 두 조건의 OR 로
        // 진입·이탈이 모두 덮인다.
        if (
          viewExtent &&
          !extentContainsXY(viewExtent, x, y) &&
          !extentContainsXY(viewExtent, flat[0], flat[1])
        ) {
          continue
        }

        flat[0] = x
        flat[1] = y

        // ── [1단계·4단계] statusCode 는 일부러 silent 로 쓰지 않는다 ────────
        //
        // 좌표와 달리 여기서는 feature.set() 을 그대로 쓴다. 이유가 두 개다.
        //
        //  1. 싸다. 상태 전환은 프레임당 기껏 몇 대라 이벤트 몇 번이 문제가 안 된다.
        //  2. **WebGL 경로가 이 이벤트를 필요로 한다.** WebGLPointsLayerRenderer 는
        //     좌표는 배열 참조로 다시 읽지만, 속성은 changefeature 이벤트를 받을 때만
        //     캐시를 갱신한다(handleSourceFeatureChanged_ 가 item.properties 를 다시
        //     읽는다). 여기까지 silent 로 바꾸면 WebGL 모드에서 **위치는 움직이는데
        //     색만 안 바뀌는** 버그가 된다. 4단계 ⚑ 블록 참고.
        //
        // if 로 감싼 것도 의미가 있다. 값이 같을 때 set() 을 부르면 OL 이 그대로
        // 이벤트를 흘려서, 안 변한 로봇 2,000대가 매 프레임 이벤트를 낸다.
        if (feature.get('statusCode') !== robot.statusCode) {
          feature.set('statusCode', robot.statusCode)
        }
      }

      dirty.clear()

      // ── [1단계] 프레임당 딱 한 번 ──────────────────────────────────────────
      //
      // 여기서 소스 revision 이 1 오르고, 두 렌더러가 각자 그걸 보고 다시 그린다.
      //   Canvas : 다음 렌더에서 replay group 을 새로 만든다.
      //   WebGL  : prepareFrameInternal 이 sourceRevision_ 비교로 rebuildBuffers_ 를 돈다.
      //
      // 이 한 줄이 위에서 없앤 2,000번의 source.changed() 를 대신한다. 반대로
      // 이 줄을 빼먹으면 좌표는 조용히 바뀌었는데 다시 그릴 이유가 없어서
      // **지도가 정지 화면이 된다** — silent 갱신에서 가장 흔한 실수다.
      source.changed()
    }

    // ── [2단계] SSE 콜백은 최대한 짧게 ──────────────────────────────────────
    //
    // before 에서는 이 콜백 안에서 2,000대의 좌표 변환과 쓰기를 다 했다.
    // 지금은 id 를 Set 에 담고 rAF 한 번 예약하는 것으로 끝난다.
    //
    // 10Hz(SSE) vs 60Hz(화면)이라 평상시엔 프레임이 겹치지 않는다. 그래서 이
    // 단계의 FPS 이득은 **거의 0으로 측정될 것이다.** 값을 하는 구간은 따로 있다.
    //
    //  - 백그라운드 탭: rAF 가 멈춘다 → OL 작업이 0이 된다. before 는 안 보이는
    //    탭에서도 계속 피처를 갱신하고 렌더를 요청했다. 복귀하면 쌓인 dirty 가
    //    한 번에 반영된다(Set 이라 크기는 플릿 대수로 상한이 걸린다).
    //  - 메인 스레드가 한 번 밀려 프레임이 몰려 들어올 때(재연결 직후 등)
    //    몰린 프레임들이 한 번의 쓰기로 접힌다.
    //  - FLEET_TICK_MS 를 16 아래로 내리면 곧바로 배수만큼 이득이 된다.
    //  - 상시 이득: 무거운 쓰기가 네트워크 콜백에서 페인트 직전 프레임 콜백으로
    //    옮겨간다. 긴 태스크가 입력 처리와 겹칠 확률이 줄어 체감 스터터가 준다.
    //
    // 대가는 최대 한 화면 프레임(~16ms)의 표시 지연. 10Hz 데이터엔 무의미하다.
    const unsubscribe = fleet.onFrame((changed) => {
      for (const id of changed) dirty.add(id)
      // 이미 예약돼 있으면 다시 예약하지 않는다. 이 한 줄이 코얼레싱의 전부다.
      if (rafId === 0) rafId = requestAnimationFrame(flush)
    })

    // ── [3단계] 컬링의 유일한 구멍을 막는다 ─────────────────────────────────
    //
    // 컬링은 "화면 밖 로봇의 갱신을 건너뛴다" 인데, 건너뛴 좌표는 언젠가 다시
    // 써져야 한다. 보통은 로봇이 계속 움직이니 다음 델타에 다시 등장해서 저절로
    // 해결된다. 딱 한 경우가 안 된다.
    //
    //   화면 밖에서 갱신을 건너뛴 로봇이 그 자리에 멈춰 선다(대기·충전 전환)
    //     → 더 이상 값이 안 변하니 델타에 등장하지 않는다
    //     → 사용자가 그쪽으로 팬한다
    //     → 옛 좌표가 그려진 채 남는다. 영구히.
    //
    // 로봇이 아니라 **뷰가 움직여서** 생기는 얼룩이라 데이터 쪽 이벤트로는 절대
    // 안 씻긴다. 그래서 뷰 이벤트로 씻어낸다 — 팬·줌이 끝나면 전체를 다시 쓴다.
    // 사람 조작 빈도의 2,000회 쓰기라 비용이 없다.
    //
    // moveend 를 쓰는 이유: 팬 중(pointerdrag)마다 돌면 드래그가 무거워진다.
    // 어차피 드래그 중에는 3단계 판정이 새 extent 를 매 프레임 다시 계산하므로
    // 화면에 들어온 로봇은 이미 정상 갱신되고 있다. 멈춘 로봇만 남는데, 그건
    // 손을 뗀 뒤 한 번 씻어도 늦지 않다.
    const resyncAll = () => {
      for (const id of featureIndex.current.keys()) dirty.add(id)
      if (rafId === 0) rafId = requestAnimationFrame(flush)
    }
    mapRef.current?.on('moveend', resyncAll)

    return () => {
      unsubscribe()
      mapRef.current?.un('moveend', resyncAll)
      // 예약된 플러시가 남아 있으면 취소한다. 안 하면 언마운트된 뒤 dispose 된
      // 소스에 changed() 를 부른다.
      if (rafId !== 0) cancelAnimationFrame(rafId)
    }
  }, [fleet])

  /*
   * ══════════════════════════════════════════════════════════════════════
   *  ⚑ [4단계] Canvas → WebGL 전환 (우상단 토글)
   * ══════════════════════════════════════════════════════════════════════
   *
   * **이 단계에는 갱신 루프 코드 변경이 없다.** 위 effect 2 를 다시 봐도 renderMode
   * 분기가 한 줄도 없다. 그게 1~3단계의 성과다 — 두 레이어가 같은 VectorSource 를
   * 공유하므로, 갱신 경로는 "소스" 까지만 알면 되고 렌더러를 몰라도 된다.
   *
   * 하지만 "분기가 없다" 가 "아무거나 해도 된다" 는 뜻은 절대 아니다. silent 좌표
   * 쓰기가 WebGL 에서도 통하는 이유는 아주 구체적이고, 조금만 달랐으면 안 통했다.
   *
   * ── 왜 통하는가 (좌표) ──
   *
   *   ol/renderer/webgl/PointsLayer.js 를 열어 보면 렌더러가 피처별 캐시를 둔다.
   *
   *     this.featureCache_[uid] = {
   *       feature,
   *       properties:      feature.getProperties(),
   *       flatCoordinates: geometry.getFlatCoordinates(),   // ← 배열을 "참조로" 보관
   *     }
   *
   *   그리고 rebuildBuffers_() 가 소스 revision 이 오를 때마다 그 참조를 다시 읽어
   *   Float32Array 를 채운다.
   *
   *     tmpCoords[0] = featureCache.flatCoordinates[0]
   *     tmpCoords[1] = featureCache.flatCoordinates[1]
   *
   *   우리가 인플레이스로 덮어쓴 값이 바로 이 배열이다. 그래서 이벤트를 하나도
   *   안 보내도 다음 rebuild 에 그대로 실린다. rebuild 를 촉발하는 건 flush() 끝의
   *   source.changed() 한 줄이다.
   *
   * ── 왜 statusCode 는 다른가 (속성) ──
   *
   *   같은 캐시의 properties 는 changefeature 이벤트를 받을 때만 다시 읽힌다
   *   (handleSourceFeatureChanged_). 좌표처럼 참조를 들고 있는 게 아니라 그 시점의
   *   스냅샷이다. 그래서 effect 2 는 좌표만 silent 로 쓰고 statusCode 는 일부러
   *   feature.set() 으로 쓴다. 이 비대칭을 모르고 둘 다 silent 로 바꾸면
   *   **위치는 움직이는데 색만 안 바뀌는** 버그가 난다.
   *
   * ── 알아둘 제약 세 가지 ──
   *
   *  1) 팬·줌 **중**에는 점이 멈춘다. prepareFrameInternal 이 viewHints 의
   *     ANIMATING / INTERACTING 동안 rebuild 를 건너뛴다. followSelected 의
   *     animate(400ms) 구간도 여기 해당한다. Canvas 에는 없는 현상이라, 토글을
   *     오가며 드래그해 보면 차이가 바로 보인다.
   *  2) WebGLPoints 에는 뷰포트 컬링이 없다. rebuildBuffers_ 는 featureCache_ 를
   *     전부 돌며 화면 밖 피처까지 다시 업로드한다. 즉 3단계가 아끼는 건 CPU 쪽
   *     좌표 변환·쓰기뿐이고, GPU 업로드량은 그대로다.
   *  3) 히트 디텍션이 프레임당 렌더 패스를 하나 더 쓴다(점당 float 3개 추가 +
   *     hit render target 재렌더). WebGL FPS 가 기대만 못하면 여기가 첫 손질
   *     지점이다 — 단 클릭 선택을 포기해야 한다(disableHitDetection: true).
   *
   * ── 측정 ──
   *
   *   토글은 데이터를 건드리지 않고 렌더 경로만 바꾼다. 숨긴 레이어는 OL 이
   *   prepareFrame 자체를 건너뛰므로 비용이 0이고, 그래서 A/B 가 공정하다.
   *   숫자는 우하단 StatsOverlay 에서 읽어 README 표에 남긴다.
   *   ⚠️ GPU 가속이 꺼진 브라우저에선 WebGL 이 소프트웨어 렌더링으로 떨어져
   *   Canvas 보다 느리게 나온다. chrome://gpu 를 먼저 확인할 것.
   */

  // ── 3. 렌더 모드 토글 ────────────────────────────────────────────────────
  useEffect(() => {
    canvasLayerRef.current?.setVisible(renderMode === 'canvas')
    webglLayerRef.current?.setVisible(renderMode === 'webgl')
  }, [renderMode])

  // ── 4. 선택 강조 + 추적 ──────────────────────────────────────────────────
  useEffect(() => {
    const selectionSource = selectionSourceRef.current
    if (!selectionSource) return
    selectionSource.clear()
    if (!selectedId) return

    const robot = fleet.get(selectedId)
    if (!robot) return

    const marker = new Feature({ geometry: new Point(toMercator(robot.lon, robot.lat)) })
    selectionSource.addFeature(marker)

    if (followSelected) {
      mapRef.current?.getView().animate({
        center: toMercator(robot.lon, robot.lat),
        duration: 400,
      })
    }

    // 선택된 1대만 실시간으로 따라간다. 전체를 추적하는 것과 비용이 다르다.
    const unsubscribe = fleet.onFrame(() => {
      const latest = fleet.get(selectedId)
      if (!latest) return
      marker.getGeometry()?.setCoordinates(toMercator(latest.lon, latest.lat))
    })
    return () => {
      unsubscribe()
      selectionSource.clear()
    }
  }, [selectedId, followSelected, fleet])

  return <div ref={containerRef} className="absolute inset-0 bg-slate-900" role="application" aria-label="플릿 관제 지도" />
}
