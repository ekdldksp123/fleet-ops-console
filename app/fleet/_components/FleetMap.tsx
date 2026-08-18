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

import { lonLatExtent, toMercator, toMercatorExtent } from '@/lib/geo'
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

    const source = new VectorSource<Feature<Point>>({ features, wrapX: false })
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
  useEffect(() => {
    const unsubscribe = fleet.onFrame((changed) => {
      const index = featureIndex.current
      for (const id of changed) {
        const feature = index.get(id)
        if (!feature) continue
        const robot = fleet.get(id)
        if (!robot) continue

        const [x, y] = toMercator(robot.lon, robot.lat)
        feature.getGeometry()?.setCoordinates([x, y])

        if (feature.get('statusCode') !== robot.statusCode) {
          feature.set('statusCode', robot.statusCode)
        }
      }
    })
    return unsubscribe
  }, [fleet])

  /*
   * ⚑ 최적화 착수 지점 (여기서부터가 이 프로젝트의 본론)
   *
   * 위 루프는 의도적으로 소박하게 짜여 있다. 개선 여지가 순서대로 이렇다.
   *
   *  1) setCoordinates 는 피처마다 change 이벤트를 발생시킨다. 프레임당 2,000회의
   *     이벤트 디스패치가 곧 프레임 예산이다.
   *     → geometry 내부 좌표를 silent 로 갱신하고 프레임 끝에 source.changed()
   *       한 번만 호출하면 이벤트가 2,000 → 1 로 줄어든다.
   *
   *  2) SSE 프레임 주기(10Hz)와 화면 주사율(60Hz)이 어긋난다.
   *     → requestAnimationFrame 으로 코얼레싱해 프레임당 정확히 한 번만 그린다.
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
