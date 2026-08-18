import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // OpenLayers 는 ESM-only 패키지다. Next 15 는 그대로 처리하지만,
  // 번들 분석 시 지도 청크를 따로 보고 싶다면 여기서 만지면 된다.
  experimental: {
    optimizePackageImports: ['ol'],
  },
}

export default nextConfig
