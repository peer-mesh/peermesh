'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type Payment = { id: string; tx_ref: string; status: string; amount_usd: number; created_at: string }
type Payout = { id: string; amount_usd: number; destination_currency: string; destination_amount: number | null; status: string; created_at: string }

export default function HistoryPage() {
  const supabase = createClient()
  const [payments, setPayments] = useState<Payment[]>([])
  const [payouts, setPayouts] = useState<Payout[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    const token = session?.access_token
    const res = await fetch('/api/billing/wallet', { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    if (res.ok) { const d = await res.json(); setPayments(d.payments ?? []); setPayouts(d.payouts ?? []) }
    setLoading(false)
  }, [supabase])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  const statusColor = (s: string) => s === 'successful' ? 'var(--accent)' : s === 'processing' ? '#f59e0b' : s === 'failed' ? '#f87171' : 'var(--muted)'

  const rowStyle: React.CSSProperties = { display: 'grid', padding: '12px 16px', borderTop: '1px solid var(--border)', alignItems: 'center' }
  const headStyle: React.CSSProperties = { display: 'grid', padding: '10px 16px', background: 'var(--surface)', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '1px' }

  return (
    <div style={{ padding: '32px 48px', maxWidth: '900px' }}>
      <h2 style={{ margin: '0 0 6px', fontSize: '22px', fontWeight: 700 }}>History</h2>
      <p style={{ margin: '0 0 28px', fontSize: '14px', color: 'var(--muted)' }}>Payment receipts and provider payout activity.</p>

      {loading && <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--muted)' }}>LOADING...</div>}

      {/* Payments */}
      <div style={{ marginBottom: '32px' }}>
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', letterSpacing: '2px', marginBottom: '12px' }}>WALLET TOP-UPS</div>
        <div style={{ border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
          <div style={{ ...headStyle, gridTemplateColumns: '2fr 1fr 1fr' }}>
            <span>REFERENCE</span><span>STATUS</span><span style={{ textAlign: 'right' }}>AMOUNT</span>
          </div>
          {payments.length === 0 && !loading && (
            <div style={{ padding: '24px 16px', fontSize: '13px', color: 'var(--muted)' }}>No payments yet.</div>
          )}
          {payments.map(p => (
            <div key={p.id} style={{ ...rowStyle, gridTemplateColumns: '2fr 1fr 1fr' }}>
              <div>
                <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--text)' }}>{p.tx_ref}</div>
                <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '2px' }}>{new Date(p.created_at).toLocaleString()}</div>
              </div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: statusColor(p.status) }}>{p.status.toUpperCase()}</div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--text)', textAlign: 'right' }}>${Number(p.amount_usd).toFixed(2)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Payouts */}
      <div>
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', letterSpacing: '2px', marginBottom: '12px' }}>PROVIDER PAYOUTS</div>
        <div style={{ border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
          <div style={{ ...headStyle, gridTemplateColumns: '1fr 1fr 1fr 1fr' }}>
            <span>DATE</span><span>USD AMOUNT</span><span>LOCAL</span><span>STATUS</span>
          </div>
          {payouts.length === 0 && !loading && (
            <div style={{ padding: '24px 16px', fontSize: '13px', color: 'var(--muted)' }}>No payouts yet.</div>
          )}
          {payouts.map(p => (
            <div key={p.id} style={{ ...rowStyle, gridTemplateColumns: '1fr 1fr 1fr 1fr' }}>
              <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{new Date(p.created_at).toLocaleDateString()}</div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--text)' }}>${Number(p.amount_usd).toFixed(2)}</div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--muted)' }}>
                {p.destination_amount != null ? `${Number(p.destination_amount).toFixed(2)} ${p.destination_currency}` : p.destination_currency}
              </div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: statusColor(p.status) }}>{p.status.toUpperCase()}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
