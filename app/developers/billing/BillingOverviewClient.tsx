'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { formatBytes } from '@/lib/utils'

type Profile = {
  wallet_balance_usd: number
  outstanding_balance_usd: number | null
  contribution_credits_bytes: number
  wallet_pending_payout_usd: number
  role: string
}

type BillingStat = {
  label: string
  value: string
  sub: string
  subColor?: string
  href: string | null
  action: string | null
}

export default function BillingOverviewClient() {
  const supabase = createClient()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    const token = session?.access_token
    if (!token) { setLoading(false); return }
    const res = await fetch('/api/billing/wallet', { headers: { Authorization: `Bearer ${token}` } })
    if (res.ok) {
      const data = await res.json()
      setProfile(data.profile ?? null)
    }
    setLoading(false)
  }, [supabase])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  const outstandingBalanceUsd = Number(profile?.outstanding_balance_usd ?? 0)

  const stats: BillingStat[] = [
    {
      label: 'USD Wallet',
      value: loading ? '...' : `$${Number(profile?.wallet_balance_usd ?? 0).toFixed(2)}`,
      sub: outstandingBalanceUsd > 0 ? `Owed: $${outstandingBalanceUsd.toFixed(2)}` : 'Available for API sessions',
      subColor: outstandingBalanceUsd > 0 ? '#ffb0b0' : 'var(--muted)',
      href: '/developers/billing/fund',
      action: 'Fund wallet →',
    },
    {
      label: 'Contribution Credits',
      value: loading ? '...' : formatBytes(Number(profile?.contribution_credits_bytes ?? 0)),
      sub: 'Earned by sharing bandwidth',
      href: null,
      action: null,
    },
    {
      label: 'Pending Payout',
      value: loading ? '...' : `$${Number(profile?.wallet_pending_payout_usd ?? 0).toFixed(2)}`,
      sub: 'Provider earnings awaiting withdrawal',
      href: '/developers/billing/payouts',
      action: 'Withdraw →',
    },
  ]

  const quickLinks = [
    { href: '/developers/billing/fund', label: 'Fund Wallet', desc: 'Top up your USD wallet via Flutterwave to pay for API sessions.' },
    { href: '/developers/billing/payouts', label: 'Payouts', desc: 'Withdraw provider earnings to your local bank account.' },
    { href: '/developers/billing/history', label: 'History', desc: 'View payment receipts and payout activity.' },
  ]

  return (
    <div style={{ padding: '12px 48px 36px', maxWidth: '900px' }}>
      <h1 style={{ margin: '0 0 6px', fontSize: '26px', fontWeight: 700 }}>Billing</h1>
      <p style={{ margin: '0 0 32px', fontSize: '14px', color: 'var(--muted)' }}>
        Wallet balance, contribution credits, and provider payout status.
      </p>

      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginBottom: '36px' }}>
        {stats.map(s => (
          <div key={s.label} style={{ padding: '20px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px' }}>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '2px', marginBottom: '10px' }}>
              {s.label.toUpperCase()}
            </div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '26px', color: 'var(--accent)', marginBottom: '6px', textAlign: 'left', margin: 0 }}>
              {s.value}
            </div>
            <div style={{ fontSize: '12px', color: s.subColor || 'var(--muted)', marginBottom: s.href ? '12px' : '0' }}>{s.sub}</div>
            {s.href && (
              <Link href={s.href} style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', textDecoration: 'none' }}>
                {s.action}
              </Link>
            )}
          </div>
        ))}
      </div>

      {/* Quick links */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px' }}>
        {quickLinks.map(l => (
          <Link key={l.href} href={l.href} style={{ textDecoration: 'none' }}>
            <div style={{ padding: '18px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', cursor: 'pointer' }}>
              <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginBottom: '6px' }}>{l.label}</div>
              <div style={{ fontSize: '12px', color: 'var(--muted)', lineHeight: 1.6 }}>{l.desc}</div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
