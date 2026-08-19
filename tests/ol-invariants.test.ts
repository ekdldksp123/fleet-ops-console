import Feature from 'ol/Feature'
import Point from 'ol/geom/Point'
import VectorSource from 'ol/source/Vector'
import { describe, expect, it } from 'vitest'

import { mercatorX, mercatorY } from '@/lib/geo'

/**
 * [1단계] silent 좌표 갱신이 기대는 가정을 못 박는 테스트.
 *
 * FleetMap 의 프레임 루프는 OpenLayers 의 공개 API 가 아닌 **내부 동작 두 가지**에
 * 기대고 있다. 라이브러리 업그레이드가 이 가정을 깨면 지도는 에러 없이 그냥
 * 멈추거나 엉뚱한 자리를 그린다 — 눈으로도 타입으로도 안 잡히는 실패 방식이다.
 * 그래서 가정 자체를 테스트로 못 박는다.
 *
 * 여기가 빨개지면 FleetMap 의 silent 갱신을 다시 검토해야 한다는 신호다.
 */
describe('silent 좌표 갱신이 기대는 ol 내부 동작', () => {
  it('flatCoordinates 는 setCoordinates 후에도 같은 배열 인스턴스다', () => {
    // 이게 성립해야 배열 참조를 붙들고 인플레이스로 덮어쓸 수 있다.
    // WebGLPointsLayer 의 featureCache_ 도 이 참조를 그대로 들고 있다.
    const point = new Point([0, 0])
    const flat = point.getFlatCoordinates()

    point.setCoordinates([100, 200])

    expect(point.getFlatCoordinates()).toBe(flat)
    expect(flat).toEqual([100, 200])
  })

  it('flatCoordinates 인플레이스 변경은 revision 을 올리지 않는다', () => {
    // revision 이 안 오르는 것이 곧 change 이벤트가 안 나간다는 뜻이다.
    const point = new Point([0, 0])
    const before = point.getRevision()

    const flat = point.getFlatCoordinates()
    flat[0] = mercatorX(126.9012)
    flat[1] = mercatorY(37.241)

    expect(point.getRevision()).toBe(before)
    expect(point.getCoordinates()).toEqual([mercatorX(126.9012), mercatorY(37.241)])
  })

  it('인플레이스 변경은 피처의 change 이벤트를 흘리지 않는다', () => {
    const feature = new Feature({ geometry: new Point([0, 0]) })
    let dispatched = 0
    feature.on('change', () => dispatched++)

    feature.getGeometry()!.getFlatCoordinates()[0] = 12345
    expect(dispatched).toBe(0)

    // 대조군: setCoordinates 는 이벤트를 낸다. 이 차이가 최적화의 전부다.
    feature.getGeometry()!.setCoordinates([1, 2])
    expect(dispatched).toBe(1)
  })

  it('useSpatialIndex:false 소스는 extent 질의에 전체 피처를 돌려준다', () => {
    // silent 갱신 탓에 낡아버릴 공간 인덱스가 아예 없다는 확인.
    // Canvas 렌더러는 매 프레임 이 메서드로 그릴 대상을 고른다.
    const features = [new Feature({ geometry: new Point([0, 0]) })]
    const source = new VectorSource({ features, wrapX: false, useSpatialIndex: false })

    features[0].getGeometry()!.getFlatCoordinates()[0] = 5_000_000

    // 질의 extent 는 원점 주변인데, 피처는 이미 멀리 떠났다. 인덱스가 있었다면
    // 여기서 걸러졌을 것이고 = 화면에서 사라졌을 것이다.
    expect(source.getFeaturesInExtent([-1, -1, 1, 1])).toHaveLength(1)
  })
})
