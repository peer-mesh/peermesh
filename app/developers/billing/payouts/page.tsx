'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type Destination = {
  currency: string | null; countryCode: string | null; bankCode: string | null
  bankName: string | null; accountName: string | null; beneficiaryName: string | null
  branchCode: string | null; maskedAccountNumber: string | null; hasDestination: boolean
}
type Bank = { id: string | number | null; code: string; name: string }

export default function PayoutsPage() {
  const supabase = createClient()
  const [destination, setDestination] = useState<Destination | null>(null)
  const [banks, setBanks] = useState<Bank[]>([])
  const [pendingUsd, setPendingUsd] = useState(0)
  const [activePayout, setActivePayout] = useState<{ transferId: string; status: string; destinationAmount: number; destinationCurrency: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const [country, setCountry] = useState('NG')
  const [currency, setCurrency] = useState('NGN')
  const [bankCode, setBankCode] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [accountName, setAccountName] = useState('')
  const [beneficiaryName, setBeneficiaryName] = useState('')

  const getToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ?? null
  }, [supabase])

  const load = useCallback(async () => {
    const token = await getToken()
    const [walletRes, destRes] = await Promise.all([
      fetch('/api/billing/wallet', { headers: token ? { Authorization: `Bearer ${token}` } : {} }),
      fetch('/api/billing/payout-destination', { headers: token ? { Authorization: `Bearer ${token}` } : {} }),
    ])
    if (walletRes.ok) { const d = await walletRes.json(); setPendingUsd(Number(d.profile?.wallet_pending_payout_usd ?? 0)); setActivePayout(d.activePayout ?? null) }
    if (destRes.ok) {
      const d = await destRes.json()
      const dest = d.destination as Destination | null
      setDestination(dest)
      if (dest) { setCountry(dest.countryCode ?? 'NG'); setCurrency(dest.currency ?? 'NGN'); setBankCode(dest.bankCode ?? ''); setAccountName(dest.accountName ?? ''); setBeneficiaryName(dest.beneficiaryName ?? '') }
    }
  }, [getToken])

  const loadBanks = useCallback(async (c: string) => {
    const token = await getToken()
    const res = await fetch(`/api/billing/flutterwave/banks?country=${encodeURIComponent(c)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    if (res.ok) { const d = await res.json(); setBanks(d.banks ?? []) }
  }, [getToken])

  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadBanks(country) }, [loadBanks, country])

  async function handleSave() {
    setSaving(true); setError(''); setNotice('')
    try {
      const token = await getToken()
      const res = await fetch('/api/billing/payout-destination', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ countryCode: country, currency, bankCode, bankName: banks.find(b => b.code === bankCode)?.name ?? '', accountNumber, accountName, beneficiaryName }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not save destination')
      setDestination(data.destination); setAccountNumber(''); setNotice('Destination saved.')
    } catch (err) { setError(err instanceof Error ? err.message : 'Error') } finally { setSaving(false) }
  }

  async function handlePayout() {
    setRequesting(true); setError(''); setNotice('')
    try {
      const token = await getToken()
      const res = await fetch('/api/billing/payouts', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not request payout')
      setNotice(`Payout submitted. Transfer: ${data.payout?.transferId}`)
      await load()
    } catch (err) { setError(err instanceof Error ? err.message : 'Error') } finally { setRequesting(false) }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '9px 12px', borderRadius: '8px',
    border: '1px solid var(--border)', background: 'var(--bg)',
    color: 'var(--text)', fontSize: '13px', boxSizing: 'border-box',
  }

  return (
    <div style={{ padding: '32px 48px', maxWidth: '800px' }}>
      <h2 style={{ margin: '0 0 6px', fontSize: '22px', fontWeight: 700 }}>Payouts</h2>
      <p style={{ margin: '0 0 28px', fontSize: '14px', color: 'var(--muted)' }}>
        Withdraw provider earnings to your local bank account via Flutterwave.
      </p>

      {notice && <div style={{ marginBottom: '16px', padding: '12px 16px', borderRadius: '8px', background: 'rgba(0,255,136,0.06)', border: '1px solid rgba(0,255,136,0.2)', color: 'var(--accent)', fontSize: '13px' }}>{notice}</div>}
      {error && <div style={{ marginBottom: '16px', padding: '12px 16px', borderRadius: '8px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171', fontSize: '13px' }}>{error}</div>}

      {activePayout && (
        <div style={{ marginBottom: '20px', padding: '16px 20px', background: 'rgba(0,255,136,0.04)', border: '1px solid rgba(0,255,136,0.15)', borderRadius: '10px' }}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '2px', marginBottom: '6px' }}>ACTIVE PAYOUT</div>
          <div style={{ fontSize: '13px', color: 'var(--muted)' }}>
            Transfer <code style={{ fontFamily: 'var(--font-geist-mono)' }}>{activePayout.transferId}</code> — {activePayout.status.toUpperCase()} — {activePayout.destinationAmount} {activePayout.destinationCurrency}
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
        {/* Destination form */}
        <div style={{ padding: '24px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', display: 'grid', gap: '12px' }}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '2px' }}>PAYOUT DESTINATION</div>
          {destination?.hasDestination && (
            <div style={{ fontSize: '12px', color: 'var(--muted)', padding: '10px', background: 'var(--bg)', borderRadius: '8px', border: '1px solid var(--border)' }}>
              Saved: {destination.bankName} · {destination.maskedAccountNumber} · {destination.beneficiaryName}
            </div>
          )}
          {[
            { label: 'Country code', el: <input value={country} onChange={e => setCountry(e.target.value.toUpperCase())} style={inputStyle} /> },
            { label: 'Currency', el: <input value={currency} onChange={e => setCurrency(e.target.value.toUpperCase())} style={inputStyle} /> },
            { label: 'Bank', el: <select value={bankCode} onChange={e => setBankCode(e.target.value)} style={inputStyle}><option value="">Select bank</option>{banks.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}</select> },
            { label: 'Account number', el: <input value={accountNumber} onChange={e => setAccountNumber(e.target.value)} placeholder={destination?.maskedAccountNumber ?? ''} style={inputStyle} /> },
            { label: 'Account name', el: <input value={accountName} onChange={e => setAccountName(e.target.value)} style={inputStyle} /> },
            { label: 'Beneficiary name', el: <input value={beneficiaryName} onChange={e => setBeneficiaryName(e.target.value)} style={inputStyle} /> },
          ].map(({ label, el }) => (
            <label key={label} style={{ fontSize: '12px', color: 'var(--muted)', display: 'grid', gap: '4px' }}>{label}{el}</label>
          ))}
          <button onClick={handleSave} disabled={saving} style={{ padding: '11px', borderRadius: '8px', border: 'none', background: 'var(--accent)', color: '#000', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'SAVING...' : 'SAVE DESTINATION'}
          </button>
        </div>

        {/* Request payout */}
        <div style={{ padding: '24px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', display: 'grid', gap: '16px', alignContent: 'start' }}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '2px' }}>REQUEST PAYOUT</div>
          <div style={{ padding: '16px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '10px', display: 'grid', gap: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '12px', color: 'var(--muted)' }}>Available USD</span>
              <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px' }}>${pendingUsd.toFixed(2)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '12px', color: 'var(--muted)' }}>Destination</span>
              <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px' }}>{destination?.currency ?? 'Not set'}</span>
            </div>
          </div>
          <button
            onClick={handlePayout}
            disabled={requesting || !destination?.hasDestination || pendingUsd <= 0 || !!activePayout}
            style={{ padding: '12px', borderRadius: '8px', border: 'none', background: 'var(--accent)', color: '#000', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', fontWeight: 700, cursor: 'pointer', opacity: (requesting || !destination?.hasDestination || pendingUsd <= 0 || !!activePayout) ? 0.5 : 1 }}
          >
            {requesting ? 'REQUESTING...' : 'SEND PAYOUT'}
          </button>
          <div style={{ fontSize: '12px', color: 'var(--muted)', lineHeight: 1.6 }}>
            One active payout at a time. If Flutterwave fails, the balance is restored automatically.
          </div>
        </div>
      </div>
    </div>
  )
}
