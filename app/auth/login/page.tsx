'use client'

import { useState, useEffect, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '12px 14px',
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: '8px', color: 'var(--text)', fontSize: '14px', outline: 'none',
  boxSizing: 'border-box',
}

function LoginForm() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const [supabase] = useState(() => createClient())

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const extId = searchParams.get('ext_id')
  const activate = searchParams.get('activate') === '1' || searchParams.get('source') === 'activate'

  const buildConfirmEmailPath = useCallback((emailForPath?: string) => {
    const qs = new URLSearchParams()
    if (extId) qs.set('ext_id', extId)
    if (activate) qs.set('activate', '1')
    if (emailForPath) qs.set('email', emailForPath)
    qs.set('sent', '1') // tells the confirm page not to auto-send another code
    return `/auth/confirm-email?${qs.toString()}`
  }, [activate, extId])

  const finishSignedInRoute = useCallback(async () => {
    if (extId) {
      await fetch('/api/extension-auth', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ext_id: extId }),
      })
      router.push(`/extension?ext_id=${extId}`)
      return
    }
    if (activate) {
      router.push('/extension?activate=1')
      return
    }
    router.push('/dashboard')
  }, [activate, extId, router])

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) return
      // Only redirect away if email is confirmed
      if (!session.user.email_confirmed_at) return
      await finishSignedInRoute()
    })
  }, [finishSignedInRoute, supabase])

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (signInError) {
      if (signInError.message === 'Email not confirmed') {
        await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } })
        router.push(buildConfirmEmailPath(email))
        return
      }
      setLoading(false)
      setError(signInError.message ?? 'Sign in failed')
      return
    }

    // Check if email is confirmed
    if (!data.user?.email_confirmed_at) {
      setLoading(false)
      router.push(buildConfirmEmailPath(email))
      return
    }

    // Email is confirmed, complete the sign-in
    await finishSignedInRoute()
  }

  return (
    <div style={{ width: '100%', maxWidth: '400px' }}>
      <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <label htmlFor="login-email" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Email
          </label>
          <input
            id="login-email"
            type="email"
            placeholder="your@email.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            style={inputStyle}
            disabled={loading}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <label htmlFor="login-password" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Password
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              id="login-password"
              type={showPassword ? 'text' : 'password'}
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
              style={{ ...inputStyle, flex: 1 }}
              disabled={loading}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              style={{ padding: '8px 12px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--muted)', cursor: 'pointer', fontSize: '16px', lineHeight: 1 }}
              title={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? '👁️' : '👁️‍🗨️'}
            </button>
          </div>
        </div>

        {error && (
          <div style={{ padding: '10px 14px', background: 'rgba(255,68,102,0.1)', border: '1px solid rgba(255,68,102,0.2)', borderRadius: '8px', color: 'var(--danger)', fontSize: '12px' }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !email || !password}
          style={{
            padding: '13px', background: (loading || !email || !password) ? 'var(--muted)' : 'var(--accent)',
            color: '#000', border: 'none', borderRadius: '10px',
            fontFamily: 'var(--font-geist-mono)', fontSize: '12px', fontWeight: 700,
            letterSpacing: '0.5px', cursor: (loading || !email || !password) ? 'not-allowed' : 'pointer'
          }}
        >
          {loading ? 'SIGNING IN...' : 'SIGN IN'}
        </button>
      </form>

      <div style={{ marginTop: '20px', padding: '20px 0', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '12px', color: 'var(--muted)' }}>
        <Link href="/auth/forgot-password" style={{ color: 'var(--accent)', textDecoration: 'none', fontFamily: 'var(--font-geist-mono)' }}>
          Forgot password?
        </Link>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  )
}
