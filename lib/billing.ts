export type PeerMeshRole = 'peer' | 'host' | 'client'
export type ApiSessionMode = 'rotating' | 'sticky'
export type ApiKeyTier = 'standard' | 'advanced' | 'enterprise' | 'contributor'

export type PricingQuoteInput = {
  bandwidthGb: number
  rpm: number
  periodHours: number
  sessionMode: ApiSessionMode
  tier?: ApiKeyTier
}

export type PricingConstraint = {
  code:
    | 'rpm_out_of_range'
    | 'period_out_of_range'
    | 'sticky_rpm_cap'
    | 'tier_rpm_cap'
    | 'tier_sticky_required_verification'
  message: string
}

export type PricingQuote = {
  ok: boolean
  tier: ApiKeyTier
  bandwidthGb: number
  rpm: number
  periodHours: number
  sessionMode: ApiSessionMode
  basePerGbUsd: number
  factors: {
    rpm: number
    session: number
    period: number
    tier: number
    pressure: number
  }
  estimatedUsd: number
  constraints: PricingConstraint[]
}

export type ApiKeyTierConfig = {
  tier: ApiKeyTier
  label: string
  maxRpm: number
  maxStickyRpm: number
  supportsSticky: boolean
  requiresVerification: boolean
  tierFactor: number
}

const BASE_PER_GB_USD = 1
const BROWSE_PER_GB_USD = 3
const PROVIDER_REVENUE_SHARE = 0.6
const PREMIUM_BANDWIDTH_BONUS_BYTES = 5 * 1024 ** 3

const TIER_CONFIG: Record<ApiKeyTier, ApiKeyTierConfig> = {
  standard: {
    tier: 'standard',
    label: 'Standard',
    maxRpm: 120,
    maxStickyRpm: 0,
    supportsSticky: false,
    requiresVerification: false,
    tierFactor: 1,
  },
  advanced: {
    tier: 'advanced',
    label: 'Advanced',
    maxRpm: 600,
    maxStickyRpm: 240,
    supportsSticky: true,
    requiresVerification: true,
    tierFactor: 1.18,
  },
  enterprise: {
    tier: 'enterprise',
    label: 'Enterprise',
    maxRpm: 2400,
    maxStickyRpm: 1200,
    supportsSticky: true,
    requiresVerification: true,
    tierFactor: 1.45,
  },
  contributor: {
    tier: 'contributor',
    label: 'Contributor',
    maxRpm: 900,
    maxStickyRpm: 300,
    supportsSticky: true,
    requiresVerification: false,
    tierFactor: 0.9,
  },
}

function clampNumber(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100
}

function roundCurrency4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function getPositiveNumberEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? '')
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

function rpmFactor(rpm: number): number {
  if (rpm <= 60) return 1
  if (rpm <= 120) return 1.22
  if (rpm <= 240) return 1.58
  if (rpm <= 600) return 2.35
  if (rpm <= 1200) return 3.6
  return 5
}

function sessionFactor(mode: ApiSessionMode): number {
  return mode === 'sticky' ? 1.32 : 1
}

function periodFactor(periodHours: number): number {
  if (periodHours <= 1) return 1
  if (periodHours <= 6) return 1.06
  if (periodHours <= 24) return 1.18
  if (periodHours <= 72) return 1.32
  if (periodHours <= 168) return 1.48
  return 1.72
}

function pressureFactor(rpm: number, periodHours: number, sessionMode: ApiSessionMode): number {
  let factor = 1
  if (rpm >= 600 && periodHours > 24) factor += 0.18
  if (rpm >= 1200 && periodHours > 6) factor += 0.2
  if (sessionMode === 'sticky' && periodHours > 24) factor += 0.12
  return factor
}

export function getApiKeyTierConfig(tier: ApiKeyTier = 'standard'): ApiKeyTierConfig {
  return TIER_CONFIG[tier]
}

export function sharedBytesToCreditBytes(bytesShared: number): number {
  return Math.max(0, Math.floor(Number.isFinite(bytesShared) ? bytesShared : 0))
}

export function bytesToGb(bytes: number): number {
  return bytes / (1024 ** 3)
}

export function getPremiumBandwidthBonusBytes(isPremium?: boolean | null): number {
  if (!isPremium) return 0
  return Math.floor(getPositiveNumberEnv('PEERMESH_PREMIUM_BONUS_BYTES', PREMIUM_BANDWIDTH_BONUS_BYTES))
}

export function getEffectiveBandwidthLimitBytes(baseLimit: number, isPremium?: boolean | null): number {
  const normalizedBaseLimit = Math.max(0, Math.floor(Number(baseLimit) || 0))
  return normalizedBaseLimit + getPremiumBandwidthBonusBytes(isPremium)
}

export function calculateBrowseUsageCostUsd(bytesUsed: number): number {
  const pricePerGb = getPositiveNumberEnv('PEERMESH_BROWSE_USD_PER_GB', BROWSE_PER_GB_USD)
  return roundCurrency4(Math.max(0, bytesToGb(Math.max(0, bytesUsed))) * pricePerGb)
}

export function getBrowseBytesCoveredByWalletUsd(walletUsd: number): number {
  const pricePerGb = getPositiveNumberEnv('PEERMESH_BROWSE_USD_PER_GB', BROWSE_PER_GB_USD)
  const normalizedWallet = Math.max(0, Number(walletUsd) || 0)
  return Math.floor((normalizedWallet / pricePerGb) * 1024 ** 3)
}

export function calculateProviderRevenueShareUsd(grossUsd: number): number {
  const share = Math.min(1, getPositiveNumberEnv('PEERMESH_PROVIDER_REVENUE_SHARE', PROVIDER_REVENUE_SHARE))
  return roundCurrency(Math.max(0, grossUsd) * share)
}

export function estimateApiUsageCost(input: PricingQuoteInput): number {
  const quote = quoteApiUsage(input)
  return roundCurrency4(quote.estimatedUsd)
}

export type UserUsageSettlement = {
  effectiveBandwidthLimitBytes: number
  freeBytes: number
  creditBytes: number
  paidBytes: number
  grossChargeUsd: number
  walletDebitUsd: number
  shortfallUsd: number
  providerPayoutUsd: number
  platformRevenueUsd: number
}

export function settleUserUsage(input: {
  bytesUsed: number
  bandwidthUsedMonth: number
  bandwidthLimit: number
  isPremium?: boolean | null
  contributionCreditsBytes: number
  walletBalanceUsd: number
}): UserUsageSettlement {
  const bytesUsed = Math.max(0, Math.floor(Number(input.bytesUsed) || 0))
  const effectiveBandwidthLimitBytes = getEffectiveBandwidthLimitBytes(input.bandwidthLimit, input.isPremium)
  const bandwidthUsedMonth = Math.max(0, Math.floor(Number(input.bandwidthUsedMonth) || 0))
  const contributionCreditsBytes = Math.max(0, Math.floor(Number(input.contributionCreditsBytes) || 0))
  const walletBalanceUsd = Math.max(0, roundCurrency(Number(input.walletBalanceUsd) || 0))

  const freeRemainingBytes = Math.max(0, effectiveBandwidthLimitBytes - bandwidthUsedMonth)
  const freeBytes = Math.min(bytesUsed, freeRemainingBytes)
  const remainingAfterFree = Math.max(0, bytesUsed - freeBytes)
  const creditBytes = Math.min(remainingAfterFree, contributionCreditsBytes)
  const paidBytes = Math.max(0, remainingAfterFree - creditBytes)
  const grossChargeUsd = calculateBrowseUsageCostUsd(paidBytes)
  const walletDebitUsd = roundCurrency(Math.min(walletBalanceUsd, grossChargeUsd))
  const shortfallUsd = roundCurrency(Math.max(0, grossChargeUsd - walletDebitUsd))
  const providerPayoutUsd = calculateProviderRevenueShareUsd(walletDebitUsd)
  const platformRevenueUsd = roundCurrency(Math.max(0, walletDebitUsd - providerPayoutUsd))

  return {
    effectiveBandwidthLimitBytes,
    freeBytes,
    creditBytes,
    paidBytes,
    grossChargeUsd,
    walletDebitUsd,
    shortfallUsd,
    providerPayoutUsd,
    platformRevenueUsd,
  }
}

export function quoteApiUsage(input: PricingQuoteInput): PricingQuote {
  const tier = input.tier ?? 'standard'
  const config = getApiKeyTierConfig(tier)
  const bandwidthGb = clampNumber(input.bandwidthGb, 1, 0.05, 1000)
  const rpm = clampNumber(input.rpm, 60, 1, 10000)
  const periodHours = clampNumber(input.periodHours, 1, 1, 24 * 30)
  const sessionMode = input.sessionMode === 'sticky' ? 'sticky' : 'rotating'
  const constraints: PricingConstraint[] = []

  if (rpm > config.maxRpm) {
    constraints.push({
      code: 'tier_rpm_cap',
      message: `${config.label} keys are capped at ${config.maxRpm} RPM.`,
    })
  }

  if (sessionMode === 'sticky' && !config.supportsSticky) {
    constraints.push({
      code: 'sticky_rpm_cap',
      message: `${config.label} keys only support rotating sessions.`,
    })
  }

  if (sessionMode === 'sticky' && rpm > config.maxStickyRpm && config.maxStickyRpm > 0) {
    constraints.push({
      code: 'sticky_rpm_cap',
      message: `Sticky sessions are capped at ${config.maxStickyRpm} RPM for ${config.label} keys.`,
    })
  }

  if (sessionMode === 'sticky' && config.requiresVerification) {
    constraints.push({
      code: 'tier_sticky_required_verification',
      message: `${config.label} sticky sessions require account verification before activation.`,
    })
  }

  const quoteOk = constraints.every((constraint) => constraint.code === 'tier_sticky_required_verification')
  const factors = {
    rpm: rpmFactor(rpm),
    session: sessionFactor(sessionMode),
    period: periodFactor(periodHours),
    tier: config.tierFactor,
    pressure: pressureFactor(rpm, periodHours, sessionMode),
  }
  const estimatedUsd = roundCurrency(
    BASE_PER_GB_USD *
      bandwidthGb *
      factors.rpm *
      factors.session *
      factors.period *
      factors.tier *
      factors.pressure,
  )

  return {
    ok: quoteOk,
    tier,
    bandwidthGb,
    rpm,
    periodHours,
    sessionMode,
    basePerGbUsd: BASE_PER_GB_USD,
    factors,
    estimatedUsd,
    constraints,
  }
}
