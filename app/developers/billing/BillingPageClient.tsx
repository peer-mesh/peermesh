'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { formatBytes } from '@/lib/utils'
import { developerCardStyle } from '../ui'

type WalletSummary = {
  profile: {
    role: string
    contribution_credits_bytes: number
    wallet_balance_usd: number
    wallet_pending_payout_usd: number
    payout_currency: string | null
  }
  ledger: Array<{
    id: string
    kind: string
    amount_usd: number
    currency: string
    reference: string | null
    created_at: string
  }>
  payments: Array<{
    id: string
    tx_ref: string
    status: string
    amount_usd: number
    local_amount: number | null
    local_currency: string | null
    created_at: string
    verified_at: string | null
  }>
  payouts: Array<{
    id: string
    amount_usd: number
    destination_currency: string
    destination_amount: number | null
    fx_rate: number | null
    status: string
    created_at: string
    processed_at: string | null
  }>
  activePayout?: {
    transferId: string
    sourceAmountUsd: number
    destinationCurrency: string
    destinationAmount: number
    fxRate: number
    status: string
    createdAt: string
  } | null
  payoutPreview?: {
    destination_currency: string
    rate?: number
    source_amount?: number
    destination_amount?: number
    error?: string
  } | null
}

type QuoteResponse = {
  quote: {
    estimatedUsd: number
    constraints: Array<{ code: string; message: string }>
    tier: string
    bandwidthGb: number
    rpm: number
    periodHours: number
    sessionMode: string
  }
}

type SavedPayoutDestination = {
  currency: string | null
  countryCode: string | null
  bankCode: string | null
  bankName: string | null
  accountName: string | null
  beneficiaryName: string | null
  branchCode: string | null
  maskedAccountNumber: string | null
  hasDestination: boolean
}

type BankOption = {
  id: string | number | null
  code: string
  name: string
  country: string
  currency: string | null
  type: string | null
}

const sectionStyle: React.CSSProperties = {
  ...developerCardStyle,
  display: 'grid',
  gap: '12px',
}

export default function BillingPageClient() {
  const supabase = createClient()
  const searchParams = useSearchParams()

  const [summary, setSummary] = useState<WalletSummary | null>(null)
  const [quote, setQuote] = useState<QuoteResponse['quote'] | null>(null)
  const [destination, setDestination] = useState<SavedPayoutDestination | null>(null)
  const [banks, setBanks] = useState<BankOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [funding, setFunding] = useState(false)
  const [verifyingPayment, setVerifyingPayment] = useState(false)
  const [savingDestination, setSavingDestination] = useState(false)
  const [loadingBanks, setLoadingBanks] = useState(false)
  const [requestingPayout, setRequestingPayout] = useState(false)
  const [refreshingPayout, setRefreshingPayout] = useState(false)

  const [amountUsd, setAmountUsd] = useState('10')
  const [tier, setTier] = useState('standard')
  const [bandwidthGb, setBandwidthGb] = useState(1)
  const [rpm, setRpm] = useState(60)
  const [periodHours, setPeriodHours] = useState(1)
  const [sessionMode, setSessionMode] = useState<'rotating' | 'sticky'>('rotating')

  const [payoutCountryCode, setPayoutCountryCode] = useState('NG')
  const [payoutCurrency, setPayoutCurrency] = useState('NGN')
  const [payoutBankCode, setPayoutBankCode] = useState('')
  const [payoutBankName, setPayoutBankName] = useState('')
  const [payoutAccountNumber, setPayoutAccountNumber] = useState('')
  const [payoutAccountName, setPayoutAccountName] = useState('')
  const [payoutBeneficiaryName, setPayoutBeneficiaryName] = useState('')
  const [payoutBranchCode, setPayoutBranchCode] = useState('')

  const callbackStatus = searchParams.get('status')
  const callbackTransactionId = searchParams.get('transaction_id') ?? searchParams.get('transactionId')
  const callbackTxRef = searchParams.get('tx_ref') ?? searchParams.get('txRef')

  const contributionLabel = formatBytes(Number(summary?.profile.contribution_credits_bytes ?? 0))

  const getAccessToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ?? null
  }, [supabase])

  const loadSummary = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const token = await getAccessToken()
      const res = await fetch('/api/billing/wallet', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not load billing')
      setSummary(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load billing')
    } finally {
      setLoading(false)
    }
  }, [getAccessToken])

  const loadDestination = useCallback(async () => {
    try {
      const token = await getAccessToken()
      const res = await fetch('/api/billing/payout-destination', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not load payout destination')

      const nextDestination = (data.destination ?? null) as SavedPayoutDestination | null
      setDestination(nextDestination)
      if (nextDestination) {
        setPayoutCountryCode(nextDestination.countryCode ?? 'NG')
        setPayoutCurrency(nextDestination.currency ?? 'NGN')
        setPayoutBankCode(nextDestination.bankCode ?? '')
        setPayoutBankName(nextDestination.bankName ?? '')
        setPayoutAccountName(nextDestination.accountName ?? '')
        setPayoutBeneficiaryName(nextDestination.beneficiaryName ?? '')
        setPayoutBranchCode(nextDestination.branchCode ?? '')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load payout destination')
    }
  }, [getAccessToken])

  const loadBanks = useCallback(async (countryCode: string) => {
    const normalizedCountryCode = countryCode.trim().toUpperCase()
    if (!normalizedCountryCode) {
      setBanks([])
      return
    }

    setLoadingBanks(true)
    try {
      const token = await getAccessToken()
      const res = await fetch(`/api/billing/flutterwave/banks?country=${encodeURIComponent(normalizedCountryCode)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not load banks')
      setBanks(data.banks ?? [])
    } catch (err) {
      setBanks([])
      setError(err instanceof Error ? err.message : 'Could not load banks')
    } finally {
      setLoadingBanks(false)
    }
  }, [getAccessToken])

  const loadQuote = useCallback(async () => {
    try {
      const token = await getAccessToken()
      const res = await fetch('/api/billing/quote', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ tier, bandwidthGb, rpm, periodHours, sessionMode }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not calculate quote')
      setQuote(data.quote)
    } catch (err) {
      setQuote(null)
      setError(err instanceof Error ? err.message : 'Could not calculate quote')
    }
  }, [bandwidthGb, getAccessToken, periodHours, rpm, sessionMode, tier])

  const verifyReturnedPayment = useCallback(async () => {
    if (!callbackTransactionId || verifyingPayment) return
    setVerifyingPayment(true)
    setError('')
    setNotice('Verifying wallet top-up...')
    try {
      const token = await getAccessToken()
      const res = await fetch('/api/billing/flutterwave/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          transactionId: callbackTransactionId,
          txRef: callbackTxRef,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Payment verification failed')
      setNotice(`Wallet funded successfully. New balance: $${Number(data.walletBalanceUsd ?? 0).toFixed(2)}`)
      await loadSummary()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment verification failed')
      setNotice('')
    } finally {
      setVerifyingPayment(false)
    }
  }, [callbackTransactionId, callbackTxRef, getAccessToken, loadSummary, verifyingPayment])

  const verifyActivePayout = useCallback(async (transferId: string) => {
    if (!transferId) return
    setRefreshingPayout(true)
    try {
      const token = await getAccessToken()
      const res = await fetch('/api/billing/payouts/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ transferId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not refresh payout')

      if (data.payout?.status === 'successful') {
        setNotice('Provider payout completed successfully.')
      } else if (data.payout?.status === 'failed' || data.payout?.status === 'cancelled') {
        setNotice('Provider payout did not complete and the pending payout balance was restored.')
      }

      await loadSummary()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not refresh payout')
    } finally {
      setRefreshingPayout(false)
    }
  }, [getAccessToken, loadSummary])

  async function handleFundWallet() {
    setFunding(true)
    setError('')
    setNotice('')
    try {
      const numericAmount = Math.round((Number(amountUsd) || 0) * 100) / 100
      const token = await getAccessToken()
      const res = await fetch('/api/billing/flutterwave/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ amountUsd: numericAmount }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not start checkout')
      if (!data.checkoutUrl) throw new Error('Flutterwave did not return a checkout URL')
      window.location.href = data.checkoutUrl
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start checkout')
      setFunding(false)
    }
  }

  async function handleSaveDestination() {
    setSavingDestination(true)
    setError('')
    setNotice('')
    try {
      const token = await getAccessToken()
      const res = await fetch('/api/billing/payout-destination', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          countryCode: payoutCountryCode,
          currency: payoutCurrency,
          bankCode: payoutBankCode,
          bankName: payoutBankName,
          accountNumber: payoutAccountNumber,
          accountName: payoutAccountName,
          beneficiaryName: payoutBeneficiaryName,
          branchCode: payoutBranchCode,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not save payout destination')

      setDestination(data.destination)
      setPayoutAccountNumber('')
      setPayoutAccountName(data.destination?.accountName ?? payoutAccountName)
      setNotice('Payout destination saved.')
      await loadSummary()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save payout destination')
    } finally {
      setSavingDestination(false)
    }
  }

  async function handleClearDestination() {
    setSavingDestination(true)
    setError('')
    setNotice('')
    try {
      const token = await getAccessToken()
      const res = await fetch('/api/billing/payout-destination', {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not clear payout destination')

      setDestination(data.destination)
      setPayoutBankCode('')
      setPayoutBankName('')
      setPayoutAccountNumber('')
      setPayoutAccountName('')
      setPayoutBeneficiaryName('')
      setPayoutBranchCode('')
      setNotice('Payout destination cleared.')
      await loadSummary()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not clear payout destination')
    } finally {
      setSavingDestination(false)
    }
  }

  async function handleRequestPayout() {
    setRequestingPayout(true)
    setError('')
    setNotice('')
    try {
      const token = await getAccessToken()
      const res = await fetch('/api/billing/payouts', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not request payout')

      setNotice(`Payout submitted to Flutterwave. Transfer id: ${data.payout?.transferId}`)
      await loadSummary()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not request payout')
    } finally {
      setRequestingPayout(false)
    }
  }

  useEffect(() => {
    void loadSummary()
    void loadDestination()
  }, [loadDestination, loadSummary])

  useEffect(() => {
    void loadQuote()
  }, [loadQuote])

  useEffect(() => {
    void loadBanks(payoutCountryCode)
  }, [loadBanks, payoutCountryCode])

  useEffect(() => {
    if (callbackStatus === 'successful' && callbackTransactionId) {
      void verifyReturnedPayment()
      return
    }
    if (callbackStatus === 'cancelled') {
      setNotice('Flutterwave checkout was cancelled before payment completed.')
    }
  }, [callbackStatus, callbackTransactionId, verifyReturnedPayment])

  useEffect(() => {
    const transferId = summary?.activePayout?.transferId ?? ''
    if (!transferId) return

    const timer = window.setInterval(() => {
      void verifyActivePayout(transferId)
    }, 15000)

    return () => window.clearInterval(timer)
  }, [summary?.activePayout?.transferId, verifyActivePayout])

  useEffect(() => {
    if (!payoutBankCode) return
    const selectedBank = banks.find((bank) => bank.code === payoutBankCode)
    if (!selectedBank) return
    setPayoutBankName(selectedBank.name)
    if (!payoutCurrency && selectedBank.currency) {
      setPayoutCurrency(selectedBank.currency)
    }
  }, [banks, payoutBankCode, payoutCurrency])

  return (
    <div style={{ padding: '36px 48px', maxWidth: '960px' }}>
      <div style={{ marginBottom: '28px' }}>
        <h1 style={{ margin: '0 0 6px', fontSize: '28px', fontWeight: 700 }}>Billing</h1>
        <p style={{ margin: 0, fontSize: '14px', color: 'var(--muted)' }}>
          Fund your USD wallet, estimate session cost, and withdraw provider earnings via Flutterwave.
        </p>
      </div>

      {error ? (
        <div style={{ ...sectionStyle, borderColor: 'rgba(255,96,96,0.35)', background: 'rgba(255,96,96,0.08)', color: '#ff8080', fontSize: '13px' }}>
          {error}
        </div>
      ) : null}

      {notice ? (
        <div style={{ ...sectionStyle, borderColor: 'rgba(0,255,136,0.35)', background: 'rgba(0,255,136,0.08)', color: 'var(--accent)', fontSize: '13px' }}>
          {notice}
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
        <div style={sectionStyle}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '1px' }}>USD WALLET</div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '28px', color: 'var(--accent)' }}>
            {loading ? '...' : `$${Number(summary?.profile.wallet_balance_usd ?? 0).toFixed(2)}`}
          </div>
        </div>
        <div style={sectionStyle}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '1px' }}>CONTRIBUTION CREDITS</div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '20px', color: 'var(--accent)' }}>
            {loading ? '...' : contributionLabel}
          </div>
        </div>
        <div style={sectionStyle}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '1px' }}>PENDING PAYOUT</div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '20px', color: 'var(--accent)' }}>
            {loading ? '...' : `$${Number(summary?.profile.wallet_pending_payout_usd ?? 0).toFixed(2)}`}
          </div>
          {summary?.payoutPreview?.destination_amount != null ? (
            <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
              Approx. {summary.payoutPreview.destination_amount.toFixed(2)} {summary.payoutPreview.destination_currency}
            </div>
          ) : null}
        </div>
      </div>

      {summary?.activePayout ? (
        <div style={{ ...sectionStyle, borderColor: 'rgba(0,255,136,0.22)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px', marginBottom: '6px' }}>ACTIVE PAYOUT</div>
              <div style={{ fontSize: '13px', color: 'var(--muted)', lineHeight: 1.8 }}>
                Transfer <code>{summary.activePayout.transferId}</code> is currently {summary.activePayout.status.toUpperCase()} for
                {' '} {summary.activePayout.destinationAmount.toFixed(2)} {summary.activePayout.destinationCurrency}.
              </div>
            </div>
            <button
              onClick={() => void verifyActivePayout(summary.activePayout?.transferId ?? '')}
              disabled={refreshingPayout}
              style={{ padding: '11px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-geist-mono)', fontSize: '11px', cursor: refreshingPayout ? 'not-allowed' : 'pointer' }}
            >
              {refreshingPayout ? 'REFRESHING...' : 'REFRESH STATUS'}
            </button>
          </div>
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '16px' }}>
        <div style={sectionStyle}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px' }}>FUND WALLET</div>
          <div style={{ display: 'grid', gap: '10px' }}>
            <label style={{ fontSize: '12px', color: 'var(--muted)' }}>
              Amount in USD
              <input
                value={amountUsd}
                onChange={(event) => setAmountUsd(event.target.value.replace(/[^\d.]/g, ''))}
                style={{ width: '100%', marginTop: '6px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-geist-mono)', boxSizing: 'border-box' }}
              />
            </label>
            <button
              onClick={handleFundWallet}
              disabled={funding || verifyingPayment}
              style={{ padding: '12px 14px', borderRadius: '8px', border: 'none', background: 'var(--accent)', color: '#000', fontFamily: 'var(--font-geist-mono)', fontWeight: 700, cursor: funding || verifyingPayment ? 'not-allowed' : 'pointer', opacity: funding || verifyingPayment ? 0.7 : 1 }}
            >
              {funding ? 'OPENING FLUTTERWAVE...' : 'PAY WITH FLUTTERWAVE'}
            </button>
            <div style={{ fontSize: '12px', color: 'var(--muted)', lineHeight: 1.7 }}>
              API sessions spend the USD wallet after free allocation and contribution credits are exhausted.
            </div>
          </div>
        </div>

        <div style={sectionStyle}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px' }}>API USAGE ESTIMATE</div>
          <div style={{ display: 'grid', gap: '10px' }}>
            <label style={{ fontSize: '12px', color: 'var(--muted)' }}>
              Tier
              <select value={tier} onChange={(event) => setTier(event.target.value)} style={{ width: '100%', marginTop: '6px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}>
                <option value="standard">Standard</option>
                <option value="advanced">Advanced</option>
                <option value="enterprise">Enterprise</option>
                <option value="contributor">Contributor</option>
              </select>
            </label>
            <label style={{ fontSize: '12px', color: 'var(--muted)' }}>
              Bandwidth (GB)
              <input type="number" min={0.05} max={1000} step={0.05} value={bandwidthGb} onChange={(event) => setBandwidthGb(Number(event.target.value) || 1)} style={{ width: '100%', marginTop: '6px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
            </label>
            <label style={{ fontSize: '12px', color: 'var(--muted)' }}>
              RPM
              <input type="number" min={1} max={2400} step={1} value={rpm} onChange={(event) => setRpm(Number(event.target.value) || 60)} style={{ width: '100%', marginTop: '6px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
            </label>
            <label style={{ fontSize: '12px', color: 'var(--muted)' }}>
              Duration (hours)
              <input type="number" min={1} max={720} step={1} value={periodHours} onChange={(event) => setPeriodHours(Number(event.target.value) || 1)} style={{ width: '100%', marginTop: '6px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
            </label>
            <label style={{ fontSize: '12px', color: 'var(--muted)' }}>
              Session mode
              <select value={sessionMode} onChange={(event) => setSessionMode(event.target.value === 'sticky' ? 'sticky' : 'rotating')} style={{ width: '100%', marginTop: '6px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}>
                <option value="rotating">Rotating</option>
                <option value="sticky">Sticky</option>
              </select>
            </label>
            <div style={{ paddingTop: '6px', borderTop: '1px solid var(--border)' }}>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '24px', color: 'var(--accent)' }}>
                {quote ? `$${quote.estimatedUsd.toFixed(2)}` : '...'}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '4px' }}>
                Estimated cost for {quote?.tier ?? tier} API usage.
              </div>
              {(quote?.constraints ?? []).length > 0 ? (
                <div style={{ marginTop: '8px', display: 'grid', gap: '6px' }}>
                  {(quote?.constraints ?? []).map((constraint) => (
                    <div key={constraint.code} style={{ fontSize: '12px', color: constraint.code.includes('verification') ? '#ffcc66' : '#ff8080' }}>
                      {constraint.message}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 1fr)', gap: '16px' }}>
        <div style={sectionStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px' }}>LOCAL PAYOUT DESTINATION</div>
            <button
              onClick={() => void loadBanks(payoutCountryCode)}
              disabled={loadingBanks}
              style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-geist-mono)', fontSize: '11px', cursor: loadingBanks ? 'not-allowed' : 'pointer' }}
            >
              {loadingBanks ? 'LOADING BANKS...' : 'REFRESH BANKS'}
            </button>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--muted)', lineHeight: 1.7 }}>
            Save the destination PeerMesh should pay out to when provider earnings are withdrawn. Nigerian accounts are resolved automatically by Flutterwave on save.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' }}>
            <label style={{ fontSize: '12px', color: 'var(--muted)' }}>
              Country code
              <input value={payoutCountryCode} onChange={(event) => setPayoutCountryCode(event.target.value.toUpperCase())} style={{ width: '100%', marginTop: '6px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
            </label>
            <label style={{ fontSize: '12px', color: 'var(--muted)' }}>
              Payout currency
              <input value={payoutCurrency} onChange={(event) => setPayoutCurrency(event.target.value.toUpperCase())} style={{ width: '100%', marginTop: '6px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
            </label>
            <label style={{ fontSize: '12px', color: 'var(--muted)', gridColumn: '1 / -1' }}>
              Bank
              <select value={payoutBankCode} onChange={(event) => setPayoutBankCode(event.target.value)} style={{ width: '100%', marginTop: '6px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}>
                <option value="">Select bank</option>
                {banks.map((bank) => (
                  <option key={`${bank.code}-${bank.name}`} value={bank.code}>
                    {bank.name} ({bank.code})
                  </option>
                ))}
              </select>
            </label>
            <label style={{ fontSize: '12px', color: 'var(--muted)' }}>
              Account number
              <input value={payoutAccountNumber} onChange={(event) => setPayoutAccountNumber(event.target.value.replace(/\s+/g, ''))} placeholder={destination?.maskedAccountNumber ?? ''} style={{ width: '100%', marginTop: '6px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
            </label>
            <label style={{ fontSize: '12px', color: 'var(--muted)' }}>
              Account name
              <input value={payoutAccountName} onChange={(event) => setPayoutAccountName(event.target.value)} style={{ width: '100%', marginTop: '6px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
            </label>
            <label style={{ fontSize: '12px', color: 'var(--muted)' }}>
              Beneficiary name
              <input value={payoutBeneficiaryName} onChange={(event) => setPayoutBeneficiaryName(event.target.value)} style={{ width: '100%', marginTop: '6px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
            </label>
            <label style={{ fontSize: '12px', color: 'var(--muted)' }}>
              Branch code (optional)
              <input value={payoutBranchCode} onChange={(event) => setPayoutBranchCode(event.target.value)} style={{ width: '100%', marginTop: '6px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
            </label>
          </div>
          {destination?.hasDestination ? (
            <div style={{ fontSize: '12px', color: 'var(--muted)', lineHeight: 1.7 }}>
              Saved destination: {destination.bankName} {destination.maskedAccountNumber} for {destination.beneficiaryName}.
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button
              onClick={handleSaveDestination}
              disabled={savingDestination}
              style={{ padding: '11px 14px', borderRadius: '8px', border: 'none', background: 'var(--accent)', color: '#000', fontFamily: 'var(--font-geist-mono)', fontWeight: 700, cursor: savingDestination ? 'not-allowed' : 'pointer', opacity: savingDestination ? 0.7 : 1 }}
            >
              {savingDestination ? 'SAVING...' : 'SAVE DESTINATION'}
            </button>
            <button
              onClick={handleClearDestination}
              disabled={savingDestination}
              style={{ padding: '11px 14px', borderRadius: '8px', border: '1px solid rgba(255,96,96,0.3)', background: 'rgba(255,96,96,0.08)', color: '#ff8080', fontFamily: 'var(--font-geist-mono)', cursor: savingDestination ? 'not-allowed' : 'pointer' }}
            >
              CLEAR
            </button>
          </div>
        </div>

        <div style={sectionStyle}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px' }}>REQUEST PROVIDER PAYOUT</div>
          <div style={{ fontSize: '13px', color: 'var(--muted)', lineHeight: 1.8 }}>
            Payouts are user-driven. PeerMesh keeps provider earnings in USD until you trigger a Flutterwave transfer to the saved local destination.
          </div>
          <div style={{ display: 'grid', gap: '8px', padding: '12px', borderRadius: '10px', background: 'var(--bg)', border: '1px solid rgba(255,255,255,0.05)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
              <span style={{ fontSize: '12px', color: 'var(--muted)' }}>Available USD</span>
              <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--text)' }}>${Number(summary?.profile.wallet_pending_payout_usd ?? 0).toFixed(2)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
              <span style={{ fontSize: '12px', color: 'var(--muted)' }}>Saved local currency</span>
              <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--text)' }}>{destination?.currency ?? 'Not saved'}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
              <span style={{ fontSize: '12px', color: 'var(--muted)' }}>Estimated local payout</span>
              <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--text)' }}>
                {summary?.payoutPreview?.destination_amount != null
                  ? `${summary.payoutPreview.destination_amount.toFixed(2)} ${summary.payoutPreview.destination_currency}`
                  : 'Unavailable'}
              </span>
            </div>
          </div>
          <button
            onClick={handleRequestPayout}
            disabled={requestingPayout || !destination?.hasDestination || Number(summary?.profile.wallet_pending_payout_usd ?? 0) <= 0 || !!summary?.activePayout}
            style={{ padding: '12px 14px', borderRadius: '8px', border: 'none', background: 'var(--accent)', color: '#000', fontFamily: 'var(--font-geist-mono)', fontWeight: 700, cursor: requestingPayout ? 'not-allowed' : 'pointer', opacity: requestingPayout || !destination?.hasDestination || Number(summary?.profile.wallet_pending_payout_usd ?? 0) <= 0 || !!summary?.activePayout ? 0.65 : 1 }}
          >
            {requestingPayout ? 'REQUESTING...' : 'SEND PAYOUT VIA FLUTTERWAVE'}
          </button>
          <div style={{ fontSize: '12px', color: 'var(--muted)', lineHeight: 1.7 }}>
            One payout transfer can be active at a time for each account. If Flutterwave fails the disbursement, the pending payout balance is restored automatically.
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '16px' }}>
        <div style={sectionStyle}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px' }}>RECENT PAYMENTS</div>
          <div style={{ display: 'grid', gap: '8px' }}>
            {(summary?.payments ?? []).length === 0 ? (
              <div style={{ fontSize: '12px', color: 'var(--muted)' }}>No wallet top-ups yet.</div>
            ) : null}
            {(summary?.payments ?? []).map((payment) => (
              <div key={payment.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '10px', alignItems: 'center', padding: '10px 0', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <div>
                  <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--text)' }}>{payment.tx_ref}</div>
                  <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>{new Date(payment.created_at).toLocaleString()}</div>
                </div>
                <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: payment.status === 'successful' ? 'var(--accent)' : '#ffcc66' }}>
                  {payment.status.toUpperCase()}
                </div>
                <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--text)' }}>${Number(payment.amount_usd ?? 0).toFixed(2)}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={sectionStyle}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px' }}>RECENT PAYOUT ACTIVITY</div>
          <div style={{ display: 'grid', gap: '8px' }}>
            {(summary?.payouts ?? []).length === 0 ? (
              <div style={{ fontSize: '12px', color: 'var(--muted)' }}>No provider payout rows yet.</div>
            ) : null}
            {(summary?.payouts ?? []).map((payout) => (
              <div key={payout.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '10px', padding: '10px 0', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <div>
                  <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--text)' }}>${Number(payout.amount_usd ?? 0).toFixed(2)} USD</div>
                  <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '4px' }}>
                    {payout.destination_amount != null
                      ? `${Number(payout.destination_amount).toFixed(2)} ${payout.destination_currency}`
                      : payout.destination_currency}
                    {' '} · {new Date(payout.created_at).toLocaleString()}
                  </div>
                </div>
                <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: payout.status === 'successful' ? 'var(--accent)' : payout.status === 'processing' ? '#ffcc66' : 'var(--text)' }}>
                  {payout.status.toUpperCase()}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
