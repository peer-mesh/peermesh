import { adminClient } from '@/lib/supabase/admin'
import {
  calculateProviderRevenueShareUsd,
  estimateApiUsageCost,
  settleUserUsage,
  type ApiKeyTier,
  type ApiSessionMode,
} from '@/lib/billing'
import {
  createFlutterwaveTransfer,
  getFlutterwaveTransfer,
  normalizeFlutterwaveTransferStatus,
  quoteFlutterwaveDestinationFromSourceAmount,
  resolveFlutterwaveAccount,
} from '@/lib/flutterwave'

export type WalletTopUpSettlementInput = {
  userId: string
  txRef: string
  transactionId?: string | number | null
  amountUsd: number
  localAmount?: number | null
  localCurrency?: string | null
  rawResponse?: Record<string, unknown> | null
}

export type SessionUsageSettlementInput = {
  requesterId: string
  providerUserId?: string | null
  sessionId: string
  bytesUsed: number
  source: 'user' | 'api_key'
  apiKeyId?: string | null
  apiRequestId?: string | null
  tier?: ApiKeyTier | null
  requestedRpm?: number | null
  requestedPeriodHours?: number | null
  requestedSessionMode?: ApiSessionMode | null
  durationMinutes?: number | null
}

type PayoutDestinationProfileRow = {
  payout_currency: string | null
  payout_country_code: string | null
  payout_bank_code: string | null
  payout_bank_name: string | null
  payout_account_number: string | null
  payout_account_name: string | null
  payout_beneficiary_name: string | null
  payout_branch_code: string | null
}

type ProviderPayoutRow = {
  id: string
  amount_usd: number | null
  destination_currency: string | null
  destination_amount: number | null
  fx_rate: number | null
  flutterwave_transfer_id: string | null
  status: string | null
  created_at: string
}

export const MIN_PAYOUT_USD = 1

export type SavedPayoutDestination = {
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

export type ActivePayoutTransfer = {
  transferId: string
  sourceAmountUsd: number
  destinationCurrency: string
  destinationAmount: number
  fxRate: number
  status: 'new' | 'pending' | 'successful' | 'failed' | 'cancelled'
  createdAt: string
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100
}

function roundCurrency4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function normalizePayoutString(value: unknown, max = 120): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function maskAccountNumber(accountNumber: string | null | undefined): string | null {
  const normalized = normalizePayoutString(accountNumber, 64)
  if (!normalized) return null
  const visible = normalized.slice(-4)
  return `****${visible}`
}

function mapSavedPayoutDestination(profile: PayoutDestinationProfileRow | null | undefined): SavedPayoutDestination {
  const hasDestination = !!profile?.payout_bank_code && !!profile?.payout_account_number && !!profile?.payout_currency

  return {
    currency: profile?.payout_currency?.toUpperCase() ?? null,
    countryCode: profile?.payout_country_code?.toUpperCase() ?? null,
    bankCode: profile?.payout_bank_code ?? null,
    bankName: profile?.payout_bank_name ?? null,
    accountName: profile?.payout_account_name ?? null,
    beneficiaryName: profile?.payout_beneficiary_name ?? null,
    branchCode: profile?.payout_branch_code ?? null,
    maskedAccountNumber: maskAccountNumber(profile?.payout_account_number),
    hasDestination,
  }
}

function sumPayoutAmountUsd(rows: ProviderPayoutRow[]): number {
  return roundCurrency(
    rows.reduce((total, row) => total + Number(row.amount_usd ?? 0), 0),
  )
}

function getTransferDestinationAmount(rows: ProviderPayoutRow[], fallbackRate: number, sourceAmountUsd: number): number {
  const explicitTotal = rows.reduce((total, row) => total + Number(row.destination_amount ?? 0), 0)
  if (explicitTotal > 0) return roundCurrency(explicitTotal)
  return roundCurrency(sourceAmountUsd * fallbackRate)
}

export async function getWalletSummary(userId: string) {
  const [{ data: profile, error: profileError }, { data: ledger }, { data: payments }, { data: payouts }] = await Promise.all([
    adminClient
      .from('profiles')
      .select('role, contribution_credits_bytes, wallet_balance_usd, wallet_pending_payout_usd, payout_currency')
      .eq('id', userId)
      .single(),
    adminClient
      .from('wallet_ledger')
      .select('id, kind, amount_usd, currency, reference, metadata, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(10),
    adminClient
      .from('payment_transactions')
      .select('id, tx_ref, status, amount_usd, local_amount, local_currency, checkout_url, created_at, verified_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(10),
    adminClient
      .from('provider_payouts')
      .select('id, amount_usd, destination_currency, destination_amount, fx_rate, status, created_at, processed_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(10),
  ])

  if (profileError || !profile) {
    throw new Error(profileError?.message ?? 'Could not load wallet summary')
  }

  return {
    profile,
    ledger: ledger ?? [],
    payments: payments ?? [],
    payouts: payouts ?? [],
  }
}

export async function getSavedPayoutDestination(userId: string): Promise<SavedPayoutDestination> {
  const { data, error } = await adminClient
    .from('profiles')
    .select('payout_currency, payout_country_code, payout_bank_code, payout_bank_name, payout_account_number, payout_account_name, payout_beneficiary_name, payout_branch_code')
    .eq('id', userId)
    .single<PayoutDestinationProfileRow>()

  if (error || !data) {
    throw new Error(error?.message ?? 'Could not load payout destination')
  }

  return mapSavedPayoutDestination(data)
}

export async function savePayoutDestination(input: {
  userId: string
  countryCode: string
  currency: string
  bankCode: string
  bankName: string
  accountNumber: string
  accountName?: string | null
  beneficiaryName: string
  branchCode?: string | null
}): Promise<SavedPayoutDestination> {
  const { data: existingProfile, error: existingProfileError } = await adminClient
    .from('profiles')
    .select('payout_bank_code, payout_account_number')
    .eq('id', input.userId)
    .single<{
      payout_bank_code: string | null
      payout_account_number: string | null
    }>()

  if (existingProfileError || !existingProfile) {
    throw new Error(existingProfileError?.message ?? 'Could not load the existing payout destination')
  }

  const countryCode = normalizePayoutString(input.countryCode, 8).toUpperCase()
  const currency = normalizePayoutString(input.currency, 8).toUpperCase()
  const bankCode = normalizePayoutString(input.bankCode, 64)
  const bankName = normalizePayoutString(input.bankName, 160)
  const rawAccountNumber = normalizePayoutString(input.accountNumber, 64).replace(/\s+/g, '')
  const accountNumber = rawAccountNumber
    || (existingProfile.payout_bank_code === bankCode ? normalizePayoutString(existingProfile.payout_account_number, 64) : '')
  const branchCode = normalizePayoutString(input.branchCode, 64) || null
  const beneficiaryName = normalizePayoutString(input.beneficiaryName, 160)

  if (!countryCode || !currency || !bankCode || !bankName || !accountNumber || !beneficiaryName) {
    throw new Error('Country, currency, bank, beneficiary, and account number are required')
  }

  let accountName = normalizePayoutString(input.accountName, 160)
  if (countryCode === 'NG') {
    const resolved = await resolveFlutterwaveAccount(accountNumber, bankCode)
    const resolvedAccountName = normalizePayoutString(resolved.data?.account_name, 160)
    if (!resolvedAccountName) {
      throw new Error('Flutterwave could not resolve that account number for the selected bank')
    }
    accountName = resolvedAccountName
  }

  if (!accountName) {
    throw new Error('Account name is required for this payout destination')
  }

  const { error } = await adminClient
    .from('profiles')
    .update({
      payout_currency: currency,
      payout_country_code: countryCode,
      payout_bank_code: bankCode,
      payout_bank_name: bankName,
      payout_account_number: accountNumber,
      payout_account_name: accountName,
      payout_beneficiary_name: beneficiaryName,
      payout_branch_code: branchCode,
      payment_provider: 'flutterwave',
    })
    .eq('id', input.userId)

  if (error) {
    throw new Error(error.message)
  }

  return getSavedPayoutDestination(input.userId)
}

export async function getActivePayoutTransfer(userId: string): Promise<ActivePayoutTransfer | null> {
  const { data, error } = await adminClient
    .from('provider_payouts')
    .select('id, amount_usd, destination_currency, destination_amount, fx_rate, flutterwave_transfer_id, status, created_at')
    .eq('user_id', userId)
    .eq('status', 'processing')
    .not('flutterwave_transfer_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) {
    throw new Error(error.message)
  }

  const rows = (data ?? []) as ProviderPayoutRow[]
  const transferId = rows[0]?.flutterwave_transfer_id
  if (!transferId) return null

  const groupedRows = rows.filter((row) => row.flutterwave_transfer_id === transferId)
  const sourceAmountUsd = sumPayoutAmountUsd(groupedRows)
  const fxRate = Number(groupedRows[0]?.fx_rate ?? 0)
  const destinationCurrency = groupedRows[0]?.destination_currency?.toUpperCase() ?? 'USD'

  return {
    transferId,
    sourceAmountUsd,
    destinationCurrency,
    destinationAmount: getTransferDestinationAmount(groupedRows, fxRate, sourceAmountUsd),
    fxRate,
    status: 'pending',
    createdAt: groupedRows[groupedRows.length - 1]?.created_at ?? groupedRows[0]?.created_at ?? new Date().toISOString(),
  }
}

export async function requestProviderPayout(input: {
  userId: string
  callbackUrl?: string | null
}): Promise<ActivePayoutTransfer> {
  const activeTransfer = await getActivePayoutTransfer(input.userId)
  if (activeTransfer) {
    throw new Error('A payout is already being processed. Wait for it to complete before starting another.')
  }

  const { data: profile, error: profileError } = await adminClient
    .from('profiles')
    .select('wallet_pending_payout_usd, payout_currency, payout_country_code, payout_bank_code, payout_bank_name, payout_account_number, payout_account_name, payout_beneficiary_name, payout_branch_code')
    .eq('id', input.userId)
    .single<{
      wallet_pending_payout_usd: number | null
    } & PayoutDestinationProfileRow>()

  if (profileError || !profile) {
    throw new Error(profileError?.message ?? 'Could not load payout profile')
  }

  const { data: pendingRows, error: pendingRowsError } = await adminClient
    .from('provider_payouts')
    .select('id, amount_usd, destination_currency, destination_amount, fx_rate, flutterwave_transfer_id, status, created_at')
    .eq('user_id', input.userId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })

  if (pendingRowsError) {
    throw new Error(pendingRowsError.message)
  }

  const rows = (pendingRows ?? []) as ProviderPayoutRow[]
  const sourceAmountUsd = sumPayoutAmountUsd(rows)
  if (sourceAmountUsd <= 0 || Number(profile.wallet_pending_payout_usd ?? 0) <= 0) {
    throw new Error('There is no pending payout balance to withdraw')
  }
  if (sourceAmountUsd < MIN_PAYOUT_USD) {
    throw new Error(`Minimum payout is $${MIN_PAYOUT_USD.toFixed(2)}`)
  }

  if (!profile.payout_currency || !profile.payout_bank_code || !profile.payout_account_number || !profile.payout_beneficiary_name) {
    throw new Error('Save a payout destination before requesting a payout')
  }

  const quote = await quoteFlutterwaveDestinationFromSourceAmount(
    'USD',
    profile.payout_currency,
    sourceAmountUsd,
  )

  const reference = `pm_payout_${input.userId.slice(0, 8)}_${Date.now()}`
  const { data: reserved, error: reserveError } = await adminClient.rpc('reserve_provider_payout', {
    p_user_id: input.userId,
    p_amount_usd: sourceAmountUsd,
    p_reservation_id: reference,
  })
  if (reserveError) throw new Error(reserveError.message)
  if (reserved !== true) {
    throw new Error('A payout is already being processed or the pending balance changed. Refresh and try again.')
  }

  let transfer
  try {
    transfer = await createFlutterwaveTransfer({
      accountBank: profile.payout_bank_code,
      accountNumber: profile.payout_account_number,
      amount: quote.destinationAmount,
      currency: quote.destinationCurrency,
      debitCurrency: quote.sourceCurrency,
      beneficiaryName: profile.payout_beneficiary_name,
      destinationBranchCode: profile.payout_branch_code,
      reference,
      callbackUrl: input.callbackUrl ?? undefined,
      meta: {
        userId: input.userId,
        purpose: 'provider_payout',
        sourceAmountUsd,
      },
    })
  } catch (error) {
    await adminClient
      .from('provider_payouts')
      .update({ status: 'pending', flutterwave_transfer_id: null })
      .eq('user_id', input.userId)
      .eq('status', 'processing')
      .eq('flutterwave_transfer_id', reference)
    await adminClient.rpc('add_provider_pending_payout', {
      p_user_id: input.userId,
      p_amount_usd: sourceAmountUsd,
    })
    throw error
  }

  const transferId = String(transfer.data?.id ?? '').trim()
  if (!transferId) {
    await adminClient
      .from('provider_payouts')
      .update({ status: 'pending', flutterwave_transfer_id: null })
      .eq('user_id', input.userId)
      .eq('status', 'processing')
      .eq('flutterwave_transfer_id', reference)
    await adminClient.rpc('add_provider_pending_payout', {
      p_user_id: input.userId,
      p_amount_usd: sourceAmountUsd,
    })
    throw new Error('Flutterwave did not return a transfer id')
  }

  const fxRate = Number(quote.rate ?? 0)
  const { error: markProcessingError } = await adminClient
    .from('provider_payouts')
    .update({
      status: 'processing',
      flutterwave_transfer_id: transferId,
      destination_currency: quote.destinationCurrency,
      destination_amount: null,
      fx_rate: fxRate,
    })
    .eq('user_id', input.userId)
    .eq('status', 'processing')
    .eq('flutterwave_transfer_id', reference)

  if (markProcessingError) {
    throw new Error(markProcessingError.message)
  }

  await adminClient
    .from('wallet_ledger')
    .insert({
      user_id: input.userId,
      kind: 'payout_pending',
      amount_usd: sourceAmountUsd,
      currency: 'USD',
      reference: `payout_pending:${transferId}`,
      metadata: {
        destinationCurrency: quote.destinationCurrency,
        destinationAmount: quote.destinationAmount,
        reference,
      },
    })
    .select('id')
    .single()
    .then(({ error }) => {
      if (error && !/duplicate/i.test(error.message)) throw error
    })

  return {
    transferId,
    sourceAmountUsd,
    destinationCurrency: quote.destinationCurrency,
    destinationAmount: quote.destinationAmount,
    fxRate,
    status: normalizeFlutterwaveTransferStatus(transfer.data?.status),
    createdAt: new Date().toISOString(),
  }
}

export async function syncProviderPayoutTransfer(input: {
  userId: string
  transferId: string
}): Promise<ActivePayoutTransfer> {
  const transferId = normalizePayoutString(input.transferId, 128)
  if (!transferId) {
    throw new Error('transferId is required')
  }

  const { data, error } = await adminClient
    .from('provider_payouts')
    .select('id, amount_usd, destination_currency, destination_amount, fx_rate, flutterwave_transfer_id, status, created_at')
    .eq('user_id', input.userId)
    .eq('flutterwave_transfer_id', transferId)
    .order('created_at', { ascending: true })

  if (error) {
    throw new Error(error.message)
  }

  const rows = (data ?? []) as ProviderPayoutRow[]
  if (rows.length === 0) {
    throw new Error('Payout transfer not found')
  }

  const verified = await getFlutterwaveTransfer(transferId)
  const normalizedStatus = normalizeFlutterwaveTransferStatus(verified.data?.status)
  const sourceAmountUsd = sumPayoutAmountUsd(rows)
  const fxRate = Number(rows[0]?.fx_rate ?? 0)
  const destinationCurrency = rows[0]?.destination_currency?.toUpperCase() ?? 'USD'
  const destinationAmount = getTransferDestinationAmount(rows, fxRate, sourceAmountUsd)

  if (normalizedStatus === 'successful') {
    if (rows.some((row) => row.status !== 'successful')) {
      await adminClient
        .from('provider_payouts')
        .update({
          status: 'successful',
          processed_at: new Date().toISOString(),
        })
        .eq('user_id', input.userId)
        .eq('flutterwave_transfer_id', transferId)

      const { data: existingLedger } = await adminClient
        .from('wallet_ledger')
        .select('id')
        .eq('reference', `payout:${transferId}`)
        .maybeSingle()

      if (!existingLedger?.id) {
        await adminClient
          .from('wallet_ledger')
          .insert({
            user_id: input.userId,
            kind: 'payout',
            amount_usd: sourceAmountUsd,
            currency: 'USD',
            reference: `payout:${transferId}`,
            metadata: {
              destinationCurrency,
              destinationAmount,
            },
          })
      }
    }
  } else if (normalizedStatus === 'failed' || normalizedStatus === 'cancelled') {
    if (rows.some((row) => row.status === 'processing')) {
      await adminClient
        .from('provider_payouts')
        .update({
          status: 'pending',
          flutterwave_transfer_id: null,
          destination_amount: null,
          fx_rate: null,
        })
        .eq('user_id', input.userId)
        .eq('flutterwave_transfer_id', transferId)

      const { data: profile } = await adminClient
        .from('profiles')
        .select('wallet_pending_payout_usd')
        .eq('id', input.userId)
        .single<{ wallet_pending_payout_usd: number | null }>()

      const restoredPendingBalance = roundCurrency(
        Number(profile?.wallet_pending_payout_usd ?? 0) + sourceAmountUsd,
      )

      await adminClient
        .from('profiles')
        .update({ wallet_pending_payout_usd: restoredPendingBalance })
        .eq('id', input.userId)
    }
  }

  return {
    transferId,
    sourceAmountUsd,
    destinationCurrency,
    destinationAmount,
    fxRate,
    status: normalizedStatus,
    createdAt: rows[0]?.created_at ?? new Date().toISOString(),
  }
}

export async function settleWalletTopUp(input: WalletTopUpSettlementInput) {
  const txRef = input.txRef.trim()
  const amountUsd = roundCurrency(Number(input.amountUsd) || 0)
  if (!txRef || amountUsd <= 0) {
    throw new Error('Invalid wallet settlement payload')
  }

  const reference = `payment:${txRef}`
  const { data: transaction } = await adminClient
    .from('payment_transactions')
    .select('id, status')
    .eq('tx_ref', txRef)
    .maybeSingle()

  if (!transaction?.id) {
    throw new Error(`Unknown payment transaction: ${txRef}`)
  }

  await adminClient
    .from('payment_transactions')
    .update({
      status: 'successful',
      flutterwave_transaction_id: input.transactionId != null ? String(input.transactionId) : null,
      local_amount: input.localAmount ?? null,
      local_currency: input.localCurrency ?? null,
      raw_response: input.rawResponse ?? {},
      verified_at: new Date().toISOString(),
    })
    .eq('id', transaction.id)

  const { data: existingLedger } = await adminClient
    .from('wallet_ledger')
    .select('id')
    .eq('reference', reference)
    .maybeSingle()

  if (existingLedger?.id) {
    const { data: profile } = await adminClient
      .from('profiles')
      .select('wallet_balance_usd')
      .eq('id', input.userId)
      .single()
    return {
      alreadyApplied: true,
      walletBalanceUsd: Number(profile?.wallet_balance_usd ?? 0),
    }
  }

  const { data: profile, error: profileError } = await adminClient
    .from('profiles')
    .select('wallet_balance_usd, outstanding_balance_usd')
    .eq('id', input.userId)
    .single<{
      wallet_balance_usd: number | null
      outstanding_balance_usd: number | null
    }>()

  if (profileError || !profile) {
    throw new Error(profileError?.message ?? 'Could not load wallet balance')
  }

  const outstandingBeforeUsd = roundCurrency(Number(profile.outstanding_balance_usd ?? 0))
  const amountAppliedToOutstandingUsd = roundCurrency(Math.min(amountUsd, outstandingBeforeUsd))
  const amountAddedToWalletUsd = roundCurrency(Math.max(0, amountUsd - amountAppliedToOutstandingUsd))
  const nextOutstandingUsd = roundCurrency(Math.max(0, outstandingBeforeUsd - amountAppliedToOutstandingUsd))
  const nextBalanceUsd = roundCurrency(Number(profile.wallet_balance_usd ?? 0) + amountAddedToWalletUsd)
  const { error: ledgerError } = await adminClient
    .from('wallet_ledger')
    .insert({
      user_id: input.userId,
      kind: 'payment',
      amount_usd: amountUsd,
      currency: 'USD',
      reference,
      metadata: {
        ...(input.rawResponse ?? {}),
        appliedToOutstandingUsd: amountAppliedToOutstandingUsd,
        addedToWalletUsd: amountAddedToWalletUsd,
      },
    })

  if (ledgerError) {
    if (ledgerError.message.toLowerCase().includes('duplicate')) {
      return {
        alreadyApplied: true,
        walletBalanceUsd: Number(profile.wallet_balance_usd ?? 0),
      }
    }
    throw ledgerError
  }

  await adminClient
    .from('profiles')
    .update({
      wallet_balance_usd: nextBalanceUsd,
      outstanding_balance_usd: nextOutstandingUsd,
      billing_hold_reason: nextOutstandingUsd > 0 ? 'usage_shortfall' : null,
      billing_hold_at: nextOutstandingUsd > 0 ? new Date().toISOString() : null,
    })
    .eq('id', input.userId)

  return {
    alreadyApplied: false,
    walletBalanceUsd: nextBalanceUsd,
  }
}

export async function settleSessionUsage(input: SessionUsageSettlementInput) {
  const bytesUsed = Math.max(0, Math.floor(Number(input.bytesUsed) || 0))
  if (!input.requesterId || !input.sessionId || bytesUsed <= 0) {
    return {
      walletDebitUsd: 0,
      providerPayoutUsd: 0,
      platformRevenueUsd: 0,
      grossChargeUsd: 0,
      shortfallUsd: 0,
      contributionCreditsSpentBytes: 0,
      apiUsageRecorded: false,
    }
  }

  const { data: requesterProfile, error: requesterError } = await adminClient
    .from('profiles')
    .select('bandwidth_used_month, bandwidth_limit, is_premium, contribution_credits_bytes, wallet_balance_usd')
    .eq('id', input.requesterId)
    .single<{
      bandwidth_used_month: number | null
      bandwidth_limit: number | null
      is_premium: boolean | null
      contribution_credits_bytes: number | null
      wallet_balance_usd: number | null
    }>()

  if (requesterError || !requesterProfile) {
    throw new Error(requesterError?.message ?? 'Could not load requester billing state')
  }

  let grossChargeUsd = 0
  let walletDebitUsd = 0
  let shortfallUsd = 0
  let providerPayoutUsd = 0
  let platformRevenueUsd = 0
  let contributionCreditsSpentBytes = 0

  if (input.source === 'api_key') {
    const tier = input.tier ?? 'standard'
    const requestedRpm = Math.max(1, Math.floor(Number(input.requestedRpm) || 60))
    const requestedPeriodHours = Math.max(1, Math.floor(Number(input.requestedPeriodHours) || 1))
    const requestedSessionMode = input.requestedSessionMode === 'sticky' ? 'sticky' : 'rotating'
    grossChargeUsd = roundCurrency4(estimateApiUsageCost({
      tier,
      bandwidthGb: bytesUsed / (1024 ** 3),
      rpm: requestedRpm,
      periodHours: requestedPeriodHours,
      sessionMode: requestedSessionMode,
    }))
    walletDebitUsd = roundCurrency(Math.min(Number(requesterProfile.wallet_balance_usd ?? 0), grossChargeUsd))
    shortfallUsd = roundCurrency(Math.max(0, grossChargeUsd - walletDebitUsd))
    providerPayoutUsd = calculateProviderRevenueShareUsd(walletDebitUsd)
    platformRevenueUsd = roundCurrency(Math.max(0, walletDebitUsd - providerPayoutUsd))
  } else {
    const usage = settleUserUsage({
      bytesUsed,
      bandwidthUsedMonth: Number(requesterProfile.bandwidth_used_month ?? 0),
      bandwidthLimit: Number(requesterProfile.bandwidth_limit ?? 0),
      isPremium: requesterProfile.is_premium === true,
      contributionCreditsBytes: Number(requesterProfile.contribution_credits_bytes ?? 0),
      walletBalanceUsd: Number(requesterProfile.wallet_balance_usd ?? 0),
    })
    grossChargeUsd = usage.grossChargeUsd
    walletDebitUsd = usage.walletDebitUsd
    shortfallUsd = usage.shortfallUsd
    providerPayoutUsd = usage.providerPayoutUsd
    platformRevenueUsd = usage.platformRevenueUsd
    contributionCreditsSpentBytes = usage.creditBytes
  }

  if (walletDebitUsd > 0 || contributionCreditsSpentBytes > 0 || shortfallUsd > 0) {
    const { error: updateRequesterError } = await adminClient.rpc('apply_requester_usage_charges', {
      p_user_id: input.requesterId,
      p_wallet_debit_usd: walletDebitUsd,
      p_credit_bytes: contributionCreditsSpentBytes,
      p_shortfall_usd: shortfallUsd,
    })

    if (updateRequesterError) {
      throw new Error(updateRequesterError.message)
    }
  }

  if (walletDebitUsd > 0) {
    await adminClient
      .from('wallet_ledger')
      .insert({
        user_id: input.requesterId,
        kind: 'debit',
        amount_usd: walletDebitUsd,
        currency: 'USD',
        reference: `session:${input.sessionId}`,
        metadata: {
          source: input.source,
          sessionId: input.sessionId,
          bytesUsed,
          grossChargeUsd,
          shortfallUsd,
        },
      })
  }

  if (input.providerUserId && providerPayoutUsd > 0) {
    const { data: providerProfile, error: providerError } = await adminClient
      .from('profiles')
      .select('wallet_pending_payout_usd, payout_currency')
      .eq('id', input.providerUserId)
      .single<{
        wallet_pending_payout_usd: number | null
        payout_currency: string | null
      }>()

    if (providerError || !providerProfile) {
      throw new Error(providerError?.message ?? 'Could not load provider payout state')
    }

    await adminClient.rpc('add_provider_pending_payout', {
      p_user_id: input.providerUserId,
      p_amount_usd: providerPayoutUsd,
    })

    await adminClient
      .from('provider_payouts')
      .insert({
        user_id: input.providerUserId,
        amount_usd: providerPayoutUsd,
        destination_currency: providerProfile.payout_currency ?? 'USD',
        status: 'pending',
        metadata: {
          sessionId: input.sessionId,
          requesterId: input.requesterId,
          source: input.source,
          bytesUsed,
          grossChargeUsd,
          platformRevenueUsd,
        },
      })
  }

  let apiUsageRecorded = false
  if (input.source === 'api_key' && input.apiKeyId) {
    await adminClient
      .from('api_usage')
      .insert({
        api_key_id: input.apiKeyId,
        user_id: input.requesterId,
        session_id: input.sessionId,
        request_id: input.apiRequestId ?? null,
        bandwidth_bytes: bytesUsed,
        rpm_requested: Math.max(0, Math.floor(Number(input.requestedRpm) || 0)),
        session_mode: input.requestedSessionMode === 'sticky' ? 'sticky' : 'rotating',
        duration_minutes: Math.max(0, Math.floor(Number(input.durationMinutes) || 0)),
        estimated_cost_usd: grossChargeUsd,
        collected_cost_usd: walletDebitUsd,
        shortfall_cost_usd: shortfallUsd,
      })
    apiUsageRecorded = true
  }

  return {
    walletDebitUsd,
    providerPayoutUsd,
    platformRevenueUsd,
    grossChargeUsd,
    shortfallUsd,
    contributionCreditsSpentBytes,
    apiUsageRecorded,
  }
}
