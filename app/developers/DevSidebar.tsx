'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const NAV: Array<{ href: string; label: string; icon: string; exact?: boolean }> = [
  { href: '/developers', label: 'Overview', icon: '⬡', exact: true },
  { href: '/developers/api-docs', label: 'API Reference', icon: '⟨/⟩' },
  { href: '/developers/keys', label: 'API Keys', icon: '⚿' },
  { href: '/developers/billing', label: 'Billing', icon: '◈' },
]

export function DevSidebar() {
  const pathname = usePathname()

  return (
    <aside style={{
      width: '220px',
      flexShrink: 0,
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      padding: '0',
      position: 'sticky',
      top: 0,
      height: '100vh',
      overflowY: 'auto',
    }}>
      {/* Logo / brand */}
      <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid var(--border)' }}>
        <Link href="/dashboard" style={{ textDecoration: 'none' }}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--muted)', letterSpacing: '2px', marginBottom: '4px' }}>
            ← DASHBOARD
          </div>
        </Link>
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '13px', color: 'var(--accent)', letterSpacing: '1px', fontWeight: 700 }}>
          PEERMESH
        </div>
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', marginTop: '2px' }}>
          Developers
        </div>
      </div>

      {/* Nav items */}
      <nav style={{ padding: '12px 10px', flex: 1 }}>
        {NAV.map(({ href, label, icon, exact }) => {
          const active = exact ? pathname === href : pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '9px 12px',
                borderRadius: '8px',
                textDecoration: 'none',
                fontSize: '13px',
                fontWeight: active ? 600 : 400,
                color: active ? 'var(--text)' : 'var(--muted)',
                background: active ? 'rgba(255,255,255,0.06)' : 'transparent',
                marginBottom: '2px',
                transition: 'background 0.15s',
              }}
            >
              <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: active ? 'var(--accent)' : 'var(--muted)', width: '16px', textAlign: 'center' }}>
                {icon}
              </span>
              {label}
            </Link>
          )
        })}
      </nav>

      {/* Footer */}
      <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', fontSize: '11px', color: 'var(--muted)', lineHeight: 1.6 }}>
        <div style={{ fontFamily: 'var(--font-geist-mono)', marginBottom: '4px' }}>v1 API</div>
        <div>Bearer key auth only</div>
      </div>
    </aside>
  )
}
