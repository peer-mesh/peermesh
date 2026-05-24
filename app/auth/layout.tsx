'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

function AuthTabs() {
  const pathname = usePathname()
  const searchParams = useSearchParams()

  function tabHref(tab: 'login' | 'signup') {
    const qs = searchParams.toString()
    return `/auth/${tab}${qs ? `?${qs}` : ''}`
  }

  const isSignup = pathname === '/auth/signup'
  const isConfirm = pathname.startsWith('/auth/confirm')
  const isForgot = pathname.startsWith('/auth/forgot-password')
  const isReset = pathname.startsWith('/auth/reset-password')

  if (isConfirm || isForgot || isReset) return null

  return (
    <div style={{ display: 'flex', background: 'var(--surface)', borderRadius: '10px', padding: '4px', marginBottom: '28px', border: '1px solid var(--border)' }}>
      {(['login', 'signup'] as const).map(tab => {
        const active = tab === 'signup' ? isSignup : !isSignup
        return (
          <Link
            key={tab}
            href={tabHref(tab)}
            style={{
              flex: 1, padding: '10px', borderRadius: '7px', textAlign: 'center',
              textDecoration: 'none', fontFamily: 'var(--font-geist-mono)', fontSize: '12px',
              letterSpacing: '0.5px', background: active ? 'var(--accent)' : 'transparent',
              color: active ? '#000' : 'var(--muted)', fontWeight: active ? 700 : 400,
              transition: 'all 0.2s',
            }}
          >
            {tab === 'login' ? 'SIGN IN' : 'SIGN UP'}
          </Link>
        )
      })}
    </div>
  )
}

function AuthLayoutContent() {
  const pathname = usePathname()
  const isForgot = pathname.startsWith('/auth/forgot-password')
  const isReset = pathname.startsWith('/auth/reset-password')
  const hideHeader = isForgot || isReset

  return (
    <>
      {!hideHeader && (
        <div style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--accent)', fontSize: '13px', letterSpacing: '4px', marginBottom: '32px', textAlign: 'center' }}>
          PEERMESH
        </div>
      )}

      <Suspense fallback={
        <div style={{ display: 'flex', background: 'var(--surface)', borderRadius: '10px', padding: '4px', marginBottom: '28px', border: '1px solid var(--border)', height: '44px' }} />
      }>
        <AuthTabs />
      </Suspense>
    </>
  )
}

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-20">
      <div style={{ width: '100%', maxWidth: '400px' }}>
        <AuthLayoutContent />
        {children}
      </div>
    </main>
  )
}
