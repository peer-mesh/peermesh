'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { publicDeveloperLinks, useSignedIn } from './PublicDevLinks'

export function DevSidebar() {
  const pathname = usePathname()
  const signedIn = useSignedIn()
  const links = publicDeveloperLinks(pathname, signedIn)

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
      background: 'var(--bg)',
    }}>
      <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid var(--border)' }}>
        <Link href="/" style={{ textDecoration: 'none' }}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--muted)', letterSpacing: '2px', marginBottom: '4px' }}>
            PEERMESH
          </div>
        </Link>
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '13px', color: 'var(--accent)', letterSpacing: '1px', fontWeight: 700 }}>
          DEVELOPERS
        </div>
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', marginTop: '2px' }}>
          Public docs
        </div>
      </div>

      <nav style={{ padding: '12px 10px', flex: 1 }}>
        {links.map(({ href, label, icon, active }) => {
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
                background: active ? 'var(--accent-dim)' : 'transparent',
                marginBottom: '2px',
              }}
            >
              <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: active ? 'var(--accent)' : 'var(--muted)', width: '22px', textAlign: 'center' }}>
                {icon}
              </span>
              {label}
            </Link>
          )
        })}
      </nav>

      <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', fontSize: '11px', color: 'var(--muted)', lineHeight: 1.6 }}>
        <div style={{ fontFamily: 'var(--font-geist-mono)', marginBottom: '4px' }}>v1 API</div>
        {!signedIn && (
          <div>Sign in only for keys, wallet, and payouts.</div>
        )}
      </div>
    </aside>
  )
}
