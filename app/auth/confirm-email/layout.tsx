import { Suspense } from 'react'

export default function ConfirmEmailLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={
      <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--muted)', textAlign: 'center' }}>
        LOADING...
      </div>
    }>
      {children}
    </Suspense>
  )
}
