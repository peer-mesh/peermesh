'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Suspense } from 'react'

function FundWalletInner() {
  const supabase = createClient()
  const searchParams = useSearchParams()
  const [amountUsd, setAmountUsd] = useState('10')
  const [tier, setTier] = useState('standard')
  const [bandwidthGb, setBandwidthGb] = useState(1)
  const [rpm, setRpm] = useState(60)
  const [periodHours, setPeriodHours] = useState(1)
  const [sessionMode, setSessionMode] = useState('rotating')
  const [quote, setQuote] = useState<{ estimatedUsd: number; constraints: Array<{ code: string; message: string }> } | null>(null)
  const [funding, setFunding] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const getToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ?? null
  }, [supabase])

  const loadQuote = useCallback(async () => {
    const token = await getToken()
    const res = await fetch('/api/billing/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ tier, bandwidthGb, rpm, periodHours, sessionMode }),
    })
    if (res.ok) { const d = await res.json(); setQuote(d.quote) }
  }, [getToken, tier, bandwidthGb, rpm, periodHours, sessionMode])

  useEffect(() => { void loadQuote() }, [loadQuote])

  useEffect(() => {
    const status = searchParams.get('status')
    const txId = searchParams.get('transaction_id')
    const txRef = searchParams.get('tx_ref')
    if (status === 'successful' && txId) {
      setVerifying(true)
      getToken().then(token =>
        fetch('/api/billing/flutterwave/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ transactionId: txId, txRef }),
        })
      ).then(r => r.json()).then(d => {
        setNotice(`Wallet funded. New balance: $${Number(d.walletBalanceUsd ?? 0).toFixed(2)}`)
      }).catch(() => setError('Payment verification failed')).finally(() => setVerifying(false))
    } else if (status === 'cancelled') {
      setNotice('Checkout was cancelled.')
    }
  }, [searchParams, getToken])

  async function handleFund() {
    setFunding(true); setError('')
    try {
      const token = await getToken()
      const res = await fetch('/api/billing/flutterwave/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ amountUsd: Math.round((Number(amountUsd) || 0) * 100) / 100 }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not start checkout')
      window.location.href = data.checkoutUrl
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start checkout')
      setFunding(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '9px 12px', borderRadius: '8px',
    border: '1px solid var(--border)', background: 'var(--bg)',
    color: 'var(--text)', fontSize: '13px', boxSizing: 'border-box',
  }

  return (
    <div style={{ padding: '32px 48px', maxWidth: '800px' }}>
      <h2 style={{ margin: '0 0 6px', fontSize: '22px', fontWeight: 700 }}>Fund Wallet</h2>
      <p style={{ margin: '0 0 28px', fontSize: '14px', color: 'var(--muted)' }}>
        Top up your USD wallet via Flutterwave. Funds are used for API session billing.
      </p>

      {notice && <div style={{ marginBottom: '16px', padding: '12px 16px', borderRadius: '8px', background: 'rgba(0,255,136,0.06)', border: '1px solid rgba(0,255,136,0.2)', color: 'var(--accent)', fontSize: '13px' }}>{verifying ? 'Verifying payment...' : notice}</div>}
      {error && <div style={{ marginBottom: '16px', padding: '12px 16px', borderRadius: '8px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171', fontSize: '13px' }}>{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
        {/* Fund form */}
        <div style={{ padding: '24px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', display: 'grid', gap: '16px' }}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '2px' }}>AMOUNT</div>
          <label style={{ fontSize: '12px', color: 'var(--muted)', display: 'grid', gap: '6px' }}>
            USD amount
            <input value={amountUsd} onChange={e => setAmountUsd(e.target.value.replace(/[^\d.]/g, ''))} style={inputStyle} placeholder="10.00" />
          </label>
          <button
            onClick={handleFund}
            disabled={funding}
            style={{ padding: '12px', borderRadius: '8px', border: 'none', background: 'var(--accent)', color: '#000', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', fontWeight: 700, cursor: funding ? 'not-allowed' : 'pointer', opacity: funding ? 0.7 : 1 }}
          >
            {funding ? 'OPENING FLUTTERWAVE...' : 'PAY WITH FLUTTERWAVE'}
          </button>
          <div style={{ fontSize: '12px', color: 'var(--muted)', lineHeight: 1.6 }}>
            Redirects to Flutterwave checkout. Wallet is credited automatically on success.
          </div>
        </div>

        {/* Quote estimator */}
        <div style={{ padding: '24px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', display: 'grid', gap: '12px' }}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '2px' }}>SESSION COST ESTIMATOR</div>
          {[
            { label: 'Tier', el: <select value={tier} onChange={e => setTier(e.target.value)} style={inputStyle}><option value="standard">Standard</option><option value="advanced">Advanced</option><option value="enterprise">Enterprise</option></select> },
            { label: 'Bandwidth (GB)', el: <input type="number" min={0.1} step={0.1} value={bandwidthGb} onChange={e => setBandwidthGb(Number(e.target.value))} style={inputStyle} /> },
            { label: 'RPM', el: <input type="number" min={1} max={2400} value={rpm} onChange={e => setRpm(Number(e.target.value))} style={inputStyle} /> },
            { label: 'Duration (hours)', el: <input type="number" min={1} max={720} value={periodHours} onChange={e => setPeriodHours(Number(e.target.value))} style={inputStyle} /> },
          ].map(({ label, el }) => (
            <label key={label} style={{ fontSize: '12px', color: 'var(--muted)', display: 'grid', gap: '4px' }}>
              {label}{el}
            </label>
          ))}
          <div style={{ paddingTop: '8px', borderTop: '1px solid var(--border)' }}>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '22px', color: 'var(--accent)' }}>
              {quote ? `$${quote.estimatedUsd.toFixed(4)}` : '...'}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '4px' }}>Estimated cost</div>
            {(quote?.constraints ?? []).map(c => (
              <div key={c.code} style={{ marginTop: '6px', fontSize: '12px', color: '#f59e0b' }}>{c.message}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function FundPage() {
  return <Suspense fallback={null}><FundWalletInner /></Suspense>
}
