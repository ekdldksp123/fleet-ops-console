import type { Metadata } from 'next'
import './globals.css'

// 루트 레이아웃은 Server Component 다. 'use client' 가 없다는 점이 중요하다 —
// 여기에 붙이는 순간 앱 전체가 클라이언트 번들로 딸려 들어간다.
export const metadata: Metadata = {
  title: 'Fleet Ops Console',
  description: '로봇 플릿 실시간 관제 콘솔 — Next.js App Router + OpenLayers',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="h-full">{children}</body>
    </html>
  )
}
