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

import { lonLatExtent, mercatorX, mercatorY, toMercator, toMercatorExtent } from '@/lib/geo'
import { STATUS_COLORS, type StatusCode } from '@/lib/types'
import { useFleetUi } from '@/store/fleet-store'

import { useFleet } from './FleetProvider'

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
    // 이 한 줄은 성능 옵션이 아니라 **아래 프레임 루프의 silent 좌표 쓰기가
    // 성립하기 위한 전제조건**이다. 순서대로 따라가 보자.
    //
    //  1. 기본값(true)이면 소스가 RBush 공간 인덱스를 들고, 피처가 change 이벤트를
    //     낼 때마다 해당 항목을 지우고 새 extent 로 다시 넣는다.
    //       → ol/source/Vector.js  handleFeatureChange_()  ...  featuresRtree_.update()
    //  2. 프레임 루프는 좌표를 silent 로 쓴다. change 이벤트가 안 나간다.
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
    // 않는다.
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
  // 여기에 최적화 1·2단계가 들어 있다. 코드 순서대로 읽으면 된다.
  //
  //   [2단계]  dirty Set / rafId 선언
  //   [1단계]  flush() 루프 안 — flatCoordinates 인플레이스 쓰기
  //   [1단계]  flush() 끝 — source.changed() 1회
  //   [2단계]  onFrame 콜백 — id 만 적고 rAF 예약
  //
  // ── 최적화 전 원본 ──
  //
  //   fleet.onFrame((changed) => {              // ← SSE 태스크 안에서 전부 처리
  //     for (const id of changed) {
  //       const [x, y] = toMercator(robot.lon, robot.lat)
  //       feature.getGeometry()?.setCoordinates([x, y])
  //     }
  //   })
  //
  // 아래 코드를 이것과 나란히 놓고 읽으면 각 단계가 무엇을 바꿨는지 보인다.
  // 바뀐 줄 수는 얼마 안 되고, 대신 **왜 그래도 안전한지**를 아는 데 필요한
  // 배경지식이 많다. 그 배경이 아래 주석들이다.
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

      for (const id of dirty) {
        const feature = index.get(id)
        if (!feature) continue
        const robot = fleet.get(id)
        if (!robot) continue

        // ── [1단계] 좌표를 이벤트 없이 쓴다 ────────────────────────────────
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
        // 2,000대면 이벤트 6,000회 + RBush 재삽입 2,000회다. 로드맵은 이벤트를
        // 지목했지만, 실제로 더 무거운 쪽은 ★ 표시한 R-tree 리밸런싱이다.
        //
        // 그런데 이 통보는 애초에 **낭비다.** 렌더러는 다시 그릴 때 소스를 처음부터
        // 전부 다시 읽는다(Canvas 는 replay group 을 새로 만들고, WebGL 은 버퍼를
        // 새로 채운다). 증분 갱신 같은 건 없다. 즉 "누가 변했는지" 를 2,000번
        // 알려줄 필요가 없고 "뭔가 변했다" 를 1번 알리면 결과가 같다.
        //
        // 그래서 Point 가 좌표를 담고 있는 내부 배열(flatCoordinates)을 직접
        // 덮어쓴다. setCoordinates 를 우회하므로 위 연쇄가 전부 일어나지 않는다.
        // 대신 루프가 끝난 뒤 source.changed() 를 딱 한 번 부른다(아래).
        //
        // getFlatCoordinates() 가 **복사본이 아니라 내부 배열 그 자체**를 돌려준다는
        // 점에 기대고 있다. 공개 API 로 보장된 동작이 아니라서
        // tests/ol-invariants.test.ts 가 이 가정을 못 박는다. 여기가 깨지면 지도는
        // 에러 없이 그냥 얼어붙는다.
        //
        // mercatorX/Y 를 스칼라로 쓰는 것도 같은 결의 이유다. toMercator 는 호출마다
        // 길이 2 배열을 새로 만들어 초당 20,000개의 단명 객체를 남긴다.
        const flat = feature.getGeometry()?.getFlatCoordinates()
        if (!flat) continue
        flat[0] = mercatorX(robot.lon)
        flat[1] = mercatorY(robot.lat)

        // ── [1단계] statusCode 는 일부러 silent 로 쓰지 않는다 ──────────────
        //
        // 좌표와 달리 여기서는 feature.set() 을 그대로 쓴다. 상태 전환은 프레임당
        // 기껏 몇 대라 이벤트 몇 번이 문제가 안 된다. 그리고 4단계에서 밝혀지듯
        // WebGL 경로가 이 이벤트를 필요로 한다.
        //
        // if 로 감싼 것도 의미가 있다. 값이 같을 때 set() 을 부르면 OL 이 그대로
        // 이벤트를 흘려서, 안 변한 로봇 2,000대가 매 프레임 이벤트를 낸다.
        if (feature.get('statusCode') !== robot.statusCode) {
          feature.set('statusCode', robot.statusCode)
        }
      }

      dirty.clear()

      // ── [1단계] 프레임당 딱 한 번 ────────────────────────────────────────
      //
      // 여기서 소스 revision 이 1 오르고, 두 렌더러가 각자 그걸 보고 다시 그린다.
      //   Canvas : 다음 렌더에서 replay group 을 새로 만든다.
      //   WebGL  : prepareFrameInternal 이 sourceRevision_ 비교로 버퍼를 다시 채운다.
      //
      // 이 한 줄이 위에서 없앤 2,000번의 source.changed() 를 대신한다. 반대로
      // 이 줄을 빼먹으면 좌표는 조용히 바뀌었는데 다시 그릴 이유가 없어서
      // **지도가 정지 화면이 된다** — silent 갱신에서 가장 흔한 실수다.
      source.changed()
    }

    // ── [2단계] SSE 콜백은 최대한 짧게 ──────────────────────────────────────
    //
    // 1단계까지는 이 콜백 안에서 2,000대의 좌표 변환과 쓰기를 다 했다.
    // 지금은 id 를 Set 에 담고 rAF 한 번 예약하는 것으로 끝난다.
    //
    // 10Hz(SSE) vs 60Hz(화면)이라 평상시엔 프레임이 겹치지 않는다. 그래서 이
    // 단계의 FPS 이득은 **거의 0으로 측정될 것이다.** 값을 하는 구간은 따로 있다.
    //
    //  - 백그라운드 탭: rAF 가 멈춘다 → OL 작업이 0이 된다. 1단계까지는 안 보이는
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

    return () => {
      unsubscribe()
      // 예약된 플러시가 남아 있으면 취소한다. 안 하면 언마운트된 뒤 dispose 된
      // 소스에 changed() 를 부른다.
      if (rafId !== 0) cancelAnimationFrame(rafId)
    }
  }, [fleet])

  /*
   * ⚑ 최적화 착수 지점 (여기서부터가 이 프로젝트의 본론)
   *
   * 개선 여지가 순서대로 이렇다. 완료한 단계는 ✅ 로 표시한다.
   *
   *  1) ✅ 완료 — 이벤트 디스패치 줄이기. 위 [1단계] 주석 참고.
   *
   *  2) ✅ 완료 — rAF 코얼레싱. 위 [2단계] 주석 참고.
   *
   *  3) 화면 밖 로봇도 전부 갱신하고 있다.
   *     → map.getView().calculateExtent() 로 뷰포트 컬링. 줌 아웃 상태에서는
   *       효과가 없지만 줌 인 상태에서는 갱신량이 크게 준다.
   *
   *  4) Canvas → WebGL 전환 (우상단 토글). 여기가 가장 큰 폭의 개선이다.
   *
   * 각 단계마다 StatsOverlay 의 FPS 를 기록해 README 의 표를 채운다.
   * 한 번에 다 고치지 말고 단계별 커밋으로 남기면 그 자체가 포트폴리오가 된다.
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
