import type { ReactNode } from 'react'
import { DevSidebar } from './DevSidebar'
import { BackNav } from '../BackNav'

export default function DevelopersLayout({ children }: { children: ReactNode }) {
  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      display: 'flex',
      background: 'var(--bg)',
      overflow: 'hidden',
    }}>
      <DevSidebar />
      <main style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '20px 48px 0', flexShrink: 0 }}>
          <BackNav />
        </div>
        {children}
      </main>
    </div>
  )
}
