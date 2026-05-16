'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

const CODE_TTL = 5 * 60 // seconds

function ConfirmEmailPageClient() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const supabase = createClient()

  const [otp, setOtp] = useState('')
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [countdown, setCountdown] = useState(0)

  const extId = searchParams.get('ext_id')
  const activate = searchParams.get('activate') === '1'
  const email = searchParams.get('email') ?? ''
  const alreadySent = searchParams.get('sent') === '1'

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const didAutoSend = useRef(false)

  const startCountdown = useCallback(() => {
    setCountdown(CODE_TTL)
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) { clearInterval(timerRef.current!); return 0 }
        return prev - 1
      })
    }, 1000)
  }, [])

  useEffect(() => {
    if (didAutoSend.current) return
    didAutoSend.current = true
    if (alreadySent) {
      startCountdown()
    } else {
      sendCode()
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function sendCode() {
    if (!email) { setError('Email missing — go back and try again'); return }
    setSending(true)
    setError('')
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    })
    setSending(false)
    if (otpError) {
      setError(otpError.message ?? 'Could not send code — try again')
      return
    }
    startCountdown()
  }

  async function finishRoute() {
    if (extId) {
      await fetch('/api/extension-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ext_id: extId }),
      }).catch(() => {})
      router.push(`/extension?ext_id=${extId}`)
      return
    }
    if (activate) { router.push('/extension?activate=1'); return }
    router.push('/dashboard')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email) { setError('Email missing — go back and try again'); return }
    setError('')
    setLoading(true)
    const { error: verifyError } = await supabase.auth.verifyOtp({
      email,
      token: otp,
      type: 'email',
    })
    setLoading(false)
    if (verifyError) {
      setError(verifyError.message ?? 'Invalid or expired code')
      return
    }
    // Belt-and-suspenders: mark email_confirm via admin REST
    await fetch(`/api/auth/confirm-email?email=${encodeURIComponent(email)}`, { method: 'POST' }).catch(() => {})
    setDone(true)
    setTimeout(() => { void finishRoute() }, 800)
  }

  const mm = String(Math.floor(countdown / 60)).padStart(2, '0')
  const ss = String(countdown % 60).padStart(2, '0')
  const expired = countdown === 0 && !sending

  if (done) {
    return (
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '32px', marginBottom: '16px' }}>✅</div>
        <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>Email confirmed</div>
        <p style={{ color: 'var(--muted)', fontSize: '13px' }}>Opening your dashboard...</p>
      </div>
    )
  }

  return (
    <div style={{ width: '100%' }}>

        <div style={{ fontSize: '18px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>Confirm your email</div>

        {email && (
          <p style={{ color: 'var(--muted)', fontSize: '13px', marginBottom: '4px' }}>
            Code sent to <strong style={{ color: 'var(--text)' }}>{email}</strong>
          </p>
        )}

        <p style={{ color: 'var(--muted)', fontSize: '13px', lineHeight: 1.7, marginBottom: '24px' }}>
          {sending
            ? 'Sending code...'
            : expired
              ? 'Code expired — request a new one below.'
              : countdown > 0
                ? <>Enter the 6-digit code. Expires in{' '}
                    <span style={{ fontFamily: 'var(--font-geist-mono)', color: countdown < 60 ? '#ff6060' : 'var(--accent)' }}>
                      {mm}:{ss}
                    </span>
                  </>
                : 'Enter the 6-digit code from your email.'}
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <input
            style={{ width: '100%', padding: '16px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', fontFamily: 'var(--font-geist-mono)', fontSize: '28px', letterSpacing: '12px', textAlign: 'center', outline: 'none', boxSizing: 'border-box' }}
            type="text" inputMode="numeric" maxLength={6} placeholder="000000" autoFocus
            autoComplete="one-time-code"
            value={otp} onChange={e => { setOtp(e.target.value.replace(/\D/g, '').slice(0, 6)); setError('') }}
          />

          {error && (
            <p style={{ color: 'var(--danger)', fontSize: '12px', padding: '10px 14px', background: 'rgba(255,68,102,0.1)', borderRadius: '8px', border: '1px solid rgba(255,68,102,0.2)', margin: 0 }}>
              {error}
            </p>
          )}

          <button
            type="submit" disabled={loading || otp.length < 6 || expired}
            style={{ padding: '13px', background: (loading || otp.length < 6 || expired) ? 'var(--muted)' : 'var(--accent)', color: '#000', border: 'none', borderRadius: '10px', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', fontWeight: 700, letterSpacing: '0.5px', cursor: (loading || otp.length < 6 || expired) ? 'not-allowed' : 'pointer' }}
          >
            {loading ? 'VERIFYING...' : 'CONFIRM EMAIL'}
          </button>
        </form>

        <div style={{ marginTop: '16px', textAlign: 'center' }}>
          <button
            onClick={sendCode} disabled={sending || countdown > 0}
            style={{ background: 'none', border: 'none', color: (sending || countdown > 0) ? 'var(--muted)' : 'var(--accent)', fontSize: '12px', cursor: (sending || countdown > 0) ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-geist-mono)' }}
          >
            {sending ? 'Sending...' : countdown > 0 ? `Resend in ${mm}:${ss}` : 'Resend code'}
          </button>
        </div>
      </div>
    )
}

export default function ConfirmEmailPage() {
  return <ConfirmEmailPageClient />
}
