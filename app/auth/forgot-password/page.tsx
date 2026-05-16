'use client'

import { useState } from 'react'
import Link from 'next/link'

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '12px 14px',
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: '8px', color: 'var(--text)', fontSize: '14px', outline: 'none',
  boxSizing: 'border-box',
}

export default function ForgotPasswordPage() {
  const [email, setEmail]     = useState('')
  const [sent, setSent]       = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      setSent(true)
    } catch {
      setError('Could not send reset email — check your connection and try again')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-20">
      <div style={{ width: '100%', maxWidth: '400px' }}>
        <div style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--accent)', fontSize: '13px', letterSpacing: '4px', marginBottom: '32px', textAlign: 'center' }}>
          PEERMESH
        </div>

        {sent ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '32px', marginBottom: '16px' }}>📬</div>
            <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)', marginBottom: '10px' }}>Check your inbox</div>
            <p style={{ color: 'var(--muted)', fontSize: '13px', lineHeight: 1.7, marginBottom: '24px' }}>
              If an account exists for <strong style={{ color: 'var(--text)' }}>{email}</strong>, we sent a 6-digit reset code. It expires in 15 minutes.
            </p>
            <Link href="/auth/reset-password" style={{ display: 'block', padding: '13px', background: 'var(--accent)', color: '#000', borderRadius: '10px', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', fontWeight: 700, textDecoration: 'none', textAlign: 'center', letterSpacing: '0.5px' }}>
              ENTER CODE
            </Link>
            <button onClick={() => setSent(false)} style={{ marginTop: '12px', background: 'none', border: 'none', color: 'var(--muted)', fontSize: '12px', cursor: 'pointer', fontFamily: 'var(--font-geist-mono)' }}>
              Use a different email
            </button>
          </div>
        ) : (
          <>
            <div style={{ fontSize: '18px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>Reset password</div>
            <p style={{ color: 'var(--muted)', fontSize: '13px', lineHeight: 1.7, marginBottom: '24px' }}>
              Enter your email and we&apos;ll send a 6-digit code to reset your password.
            </p>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <input
                style={inputStyle} type="email" placeholder="Email address"
                value={email} onChange={e => setEmail(e.target.value)} required autoFocus
              />

              {error && (
                <p style={{ color: 'var(--danger)', fontSize: '12px', padding: '10px 14px', background: 'rgba(255,68,102,0.1)', borderRadius: '8px', border: '1px solid rgba(255,68,102,0.2)', margin: 0 }}>
                  {error}
                </p>
              )}

              <button
                type="submit" disabled={loading}
                style={{ padding: '13px', background: loading ? 'var(--muted)' : 'var(--accent)', color: '#000', border: 'none', borderRadius: '10px', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', fontWeight: 700, letterSpacing: '0.5px', cursor: loading ? 'not-allowed' : 'pointer' }}
              >
                {loading ? 'SENDING...' : 'SEND RESET CODE'}
              </button>
            </form>

            <div style={{ marginTop: '20px', textAlign: 'center' }}>
              <Link href="/auth/login" style={{ color: 'var(--muted)', fontSize: '12px', fontFamily: 'var(--font-geist-mono)', textDecoration: 'none' }}>
                ← Back to sign in
              </Link>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
