import { Suspense } from 'react'
import BillingOverviewClient from './BillingOverviewClient'

export default function BillingPage() {
  return (
    <Suspense fallback={
      <div style={{ padding: '12px 48px 40px', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--muted)' }}>
        LOADING...
      </div>
    }>
      <BillingOverviewClient />
    </Suspense>
  )
}
