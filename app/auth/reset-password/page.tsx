'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '12px 14px',
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: '8px', color: 'var(--text)', fontSize: '14px', outline: 'none',
  boxSizing: 'border-box',
}

export default function ResetPasswordPage() {
  const router = useRouter()
  const [email,    setEmail]    = useState('')
  const [token,    setToken]    = useState('')
  const [password, setPassword] = useState('')
  const [confirm,  setConfirm]  = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [done,     setDone]     = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (password !== confirm) { setError('Passwords do not match'); return }
    if (password.length < 8)  { setError('Password must be at least 8 characters'); return }

    setLoading(true)
    try {
      const res = await fetch('/api/auth/verify-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, token, password }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Could not reset password'); return }
      setDone(true)
      setTimeout(() => router.push('/auth'), 2500)
    } catch {
      setError('Network error — please try again')
    } finally {
      setLoading(false)
    }
  }

  if (done) {
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-20">
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '32px', marginBottom: '16px' }}>✅</div>
          <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>Password updated</div>
          <p style={{ color: 'var(--muted)', fontSize: '13px' }}>Redirecting to sign in...</p>
        </div>
      </main>
    )
  }

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-20">
      <div style={{ width: '100%', maxWidth: '400px' }}>
        <div style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--accent)', fontSize: '13px', letterSpacing: '4px', marginBottom: '32px', textAlign: 'center' }}>
          PEERMESH
        </div>

        <div style={{ fontSize: '18px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>Set new password</div>
        <p style={{ color: 'var(--muted)', fontSize: '13px', lineHeight: 1.7, marginBottom: '24px' }}>
          Enter the 6-digit code from your email and choose a new password.
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <input
            style={inputStyle} type="email" placeholder="Email address"
            value={email} onChange={e => setEmail(e.target.value)} required autoFocus
          />
          <input
            style={{ ...inputStyle, fontFamily: 'var(--font-geist-mono)', fontSize: '20px', letterSpacing: '8px', textAlign: 'center' }}
            type="text" inputMode="numeric" maxLength={6} placeholder="000000"
            value={token} onChange={e => setToken(e.target.value.replace(/\D/g, '').slice(0, 6))} required
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              style={{ ...inputStyle, flex: 1 }}
              type={showPassword ? 'text' : 'password'}
              placeholder="New password (min 8 chars)"
              value={password} onChange={e => setPassword(e.target.value)} required minLength={8}
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              style={{ ...inputStyle, flex: 1 }}
              type={showConfirm ? 'text' : 'password'}
              placeholder="Confirm new password"
              value={confirm} onChange={e => setConfirm(e.target.value)} required minLength={8}
            />
            <button
              type="button"
              onClick={() => setShowConfirm(!showConfirm)}
              style={{ padding: '8px 12px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--muted)', cursor: 'pointer', fontSize: '16px', lineHeight: 1 }}
              title={showConfirm ? 'Hide password' : 'Show password'}
            >
              {showConfirm ? '👁️' : '👁️‍🗨️'}
            </button>
          </div>

          {error && (
            <p style={{ color: 'var(--danger)', fontSize: '12px', padding: '10px 14px', background: 'rgba(255,68,102,0.1)', borderRadius: '8px', border: '1px solid rgba(255,68,102,0.2)', margin: 0 }}>
              {error}
            </p>
          )}

          <button
            type="submit" disabled={loading}
            style={{ padding: '13px', background: loading ? 'var(--muted)' : 'var(--accent)', color: '#000', border: 'none', borderRadius: '10px', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', fontWeight: 700, letterSpacing: '0.5px', cursor: loading ? 'not-allowed' : 'pointer' }}
          >
            {loading ? 'UPDATING...' : 'SET NEW PASSWORD'}
          </button>
        </form>

        <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'space-between' }}>
          <Link href="/auth/forgot-password" style={{ color: 'var(--muted)', fontSize: '12px', fontFamily: 'var(--font-geist-mono)', textDecoration: 'none' }}>
            Resend code
          </Link>
          <Link href="/auth/login" style={{ color: 'var(--muted)', fontSize: '12px', fontFamily: 'var(--font-geist-mono)', textDecoration: 'none' }}>
            Back to sign in
          </Link>
        </div>
      </div>
    </main>
  )
}
