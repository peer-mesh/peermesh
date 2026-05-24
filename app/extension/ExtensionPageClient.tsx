'use client'

import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import InstallPageClient from './install/InstallPageClient'

const mono = "'Courier New', monospace"

// ── Device Activation Screen ──────────────────────────────────────────────────
function ActivateScreen() {
  const searchParams = useSearchParams()
  const rawCode = (searchParams.get('code') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const [code, setCode] = useState(() =>
    rawCode.length >= 4 ? `${rawCode.slice(0, 4)}-${rawCode.slice(4, 8)}` : rawCode
  )
  const [status, setStatus] = useState<'checking' | 'redirect' | 'idle' | 'loading' | 'approved' | 'denied' | 'error'>('checking')
  const [error, setError] = useState('')

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getSession().then(({ data: { session } }) => {
      setStatus(session ? 'idle' : 'redirect')
    }).catch(() => setStatus('redirect'))
  }, [])

  useEffect(() => {
    if ((status as string) === 'redirect') {
      const qs = new URLSearchParams({ mode: 'login', source: 'activate', activate: '1' })
      if (rawCode) qs.set('code', rawCode)
      window.location.href = `/auth?${qs.toString()}`
    }
  }, [status, rawCode])

  function handleCodeChange(val: string) {
    const clean = val.toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (clean.length <= 4) setCode(clean)
    else setCode(`${clean.slice(0, 4)}-${clean.slice(4, 8)}`)
  }

  const codeReady = code.replace(/[^A-Z0-9]/g, '').length === 8

  async function handleAction(action: 'approve' | 'deny') {
    setStatus('loading')
    setError('')
    try {
      const res = await fetch('/api/extension-auth', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_code: code.toUpperCase().trim(), action }),
      })
      const data = await res.json()
      if (res.status === 401) {
        const qs = new URLSearchParams({ mode: 'login', source: 'activate', activate: '1' })
        if (rawCode) qs.set('code', rawCode)
        window.location.href = `/auth?${qs.toString()}`
        return
      }
      if (!res.ok) { setError(data.error ?? 'Something went wrong'); setStatus('error'); return }
      setStatus(action === 'approve' ? 'approved' : 'denied')
    } catch {
      setError('Network error — please try again')
      setStatus('error')
    }
  }

  const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '24px', width: '100%', maxWidth: '400px' }

  if (status === 'checking' || (status as string) === 'redirect') return (
    <div style={{ ...card, textAlign: 'center' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <span style={{ display: 'inline-block', width: '20px', height: '20px', border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
    </div>
  )

  if (status === 'approved') return (
    <div style={{ ...card, textAlign: 'center' }}>
      <div style={{ fontSize: '40px', marginBottom: '12px' }}>✅</div>
      <div style={{ fontFamily: mono, color: 'var(--accent)', fontSize: '13px', marginBottom: '8px', letterSpacing: '1px' }}>AUTHORIZED</div>
      <div style={{ fontSize: '13px', color: 'var(--muted)' }}>You can close this tab. The app is now signed in.</div>
    </div>
  )

  if (status === 'denied') return (
    <div style={{ ...card, textAlign: 'center' }}>
      <div style={{ fontSize: '40px', marginBottom: '12px' }}>🚫</div>
      <div style={{ fontFamily: mono, color: '#ff6060', fontSize: '13px', marginBottom: '8px', letterSpacing: '1px' }}>REQUEST DENIED</div>
      <div style={{ fontSize: '13px', color: 'var(--muted)' }}>The sign-in request was rejected.</div>
    </div>
  )

  return (
    <div style={card}>
      <div style={{ fontFamily: mono, color: 'var(--accent)', fontSize: '12px', letterSpacing: '4px', marginBottom: '20px', textAlign: 'center' }}>PEERMESH</div>
      <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '6px', textAlign: 'center' }}>Authorize App</div>
      <div style={{ fontSize: '13px', color: 'var(--muted)', marginBottom: '24px', textAlign: 'center' }}>Enter the code shown in your PeerMesh app or CLI</div>
      <input
        value={code}
        onChange={e => handleCodeChange(e.target.value)}
        placeholder="XXXX-XXXX"
        maxLength={9}
        autoFocus
        style={{ width: '100%', padding: '12px 16px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', fontFamily: mono, fontSize: '20px', letterSpacing: '4px', textAlign: 'center', marginBottom: '16px', boxSizing: 'border-box' }}
      />
      {error && <div style={{ color: '#ff6060', fontSize: '12px', marginBottom: '12px', textAlign: 'center' }}>{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <button onClick={() => handleAction('deny')} disabled={!codeReady || status === 'loading'}
          style={{ padding: '12px', background: 'none', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--muted)', cursor: !codeReady || status === 'loading' ? 'not-allowed' : 'pointer', fontFamily: mono, fontSize: '11px' }}>
          DENY
        </button>
        <button onClick={() => handleAction('approve')} disabled={!codeReady || status === 'loading'}
          style={{ padding: '12px', background: codeReady ? 'var(--accent)' : 'var(--surface)', border: `1px solid ${codeReady ? 'transparent' : 'var(--border)'}`, borderRadius: '8px', color: codeReady ? '#000' : 'var(--muted)', cursor: !codeReady || status === 'loading' ? 'not-allowed' : 'pointer', fontFamily: mono, fontSize: '11px', fontWeight: 700, transition: 'all 0.15s' }}>
          {status === 'loading' ? 'AUTHORIZING...' : 'AUTHORIZE'}
        </button>
      </div>
    </div>
  )
}

// ── ext_id auto sign-in screen ────────────────────────────────────────────────
function ExtIdScreen({ extId }: { extId: string }) {
  const [toast, setToast] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    async function run() {
      // Check auth first
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession().catch(() => ({ data: { session: null } }))
      if (!session) {
        window.location.href = `/auth?mode=login&source=extension&ext_id=${extId}`
        return
      }
      try {
        const res = await fetch('/api/extension-auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ext_id: extId }),
        })
        if (res.status === 401) {
          window.location.href = `/auth?mode=login&source=extension&ext_id=${extId}`
          return
        }
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Something went wrong')
        setDone(true)
        setToast('✓ Signed in to extension!')
        setTimeout(() => { window.location.href = '/dashboard' }, 1500)
      } catch (err) {
        setToast(err instanceof Error ? err.message : 'Failed — make sure you are signed in')
      }
    }
    run()
  }, [extId])

  return (
    <main className="flex flex-1 items-center justify-center">
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes slideup { from { opacity: 0; transform: translateX(-50%) translateY(10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
      `}</style>
      {!done && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
          <span style={{ display: 'inline-block', width: '20px', height: '20px', border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
          <div style={{ fontFamily: mono, color: 'var(--muted)', fontSize: '11px', letterSpacing: '2px' }}>SIGNING IN...</div>
        </div>
      )}
      {toast && (
        <div className="pm-toast">
          {toast}
        </div>
      )}
    </main>
  )
}

export default function ExtensionPageClient() {
  const searchParams = useSearchParams()

  const isActivate = searchParams.get('activate') === '1' || !!searchParams.get('code')
  const urlExtId = searchParams.get('ext_id') ?? ''

  // Install page needs no auth — render immediately, no spinner
  if (!isActivate && !urlExtId) return <InstallPageClient />

  // Activate flow — ActivateScreen handles its own auth check
  if (isActivate) {
    return (
      <main className="flex flex-1 items-center justify-center" style={{ padding: '24px' }}>
        <ActivateScreen />
      </main>
    )
  }

  // ext_id flow — needs auth check before proceeding
  return <ExtIdScreen extId={urlExtId} />
}
