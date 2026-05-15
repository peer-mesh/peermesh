'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

const TABS = [
  { href: '/developers/billing', label: 'Overview', exact: true },
  { href: '/developers/billing/fund', label: 'Fund Wallet' },
  { href: '/developers/billing/payouts', label: 'Payouts' },
  { href: '/developers/billing/history', label: 'History' },
]

export default function BillingLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname()

  return (
    <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      {/* Sub-nav */}
      <div style={{ borderBottom: '1px solid var(--border)', padding: '0 48px', display: 'flex', gap: '0', flexShrink: 0 }}>
        {TABS.map(tab => {
          const active = tab.exact ? pathname === tab.href : pathname.startsWith(tab.href)
          return (
            <Link
              key={tab.href}
              href={tab.href}
              style={{
                padding: '14px 18px',
                fontSize: '13px',
                fontWeight: active ? 600 : 400,
                color: active ? 'var(--text)' : 'var(--muted)',
                textDecoration: 'none',
                borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: '-1px',
                transition: 'color 0.15s',
              }}
            >
              {tab.label}
            </Link>
          )
        })}
      </div>
      <div style={{ flex: 1 }}>
        {children}
      </div>
    </div>
  )
}
