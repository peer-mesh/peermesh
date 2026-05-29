import test from 'node:test'
import assert from 'node:assert/strict'
import { getBrowseBytesCoveredByWalletUsd, quoteApiUsage, settleUserUsage, sharedBytesToCreditBytes } from '../lib/billing.ts'

test('quoteApiUsage returns a positive estimate for standard rotating usage', () => {
  const quote = quoteApiUsage({
    tier: 'standard',
    bandwidthGb: 2,
    rpm: 60,
    periodHours: 1,
    sessionMode: 'rotating',
  })

  assert.equal(quote.ok, true)
  assert.equal(quote.tier, 'standard')
  assert.ok(quote.estimatedUsd > 0)
  assert.equal(quote.constraints.length, 0)
})

test('quoteApiUsage blocks sticky standard keys', () => {
  const quote = quoteApiUsage({
    tier: 'standard',
    bandwidthGb: 1,
    rpm: 120,
    periodHours: 6,
    sessionMode: 'sticky',
  })

  assert.equal(quote.ok, false)
  assert.ok(quote.constraints.some((constraint) => constraint.code === 'sticky_rpm_cap'))
})

test('quoteApiUsage marks advanced sticky usage as requiring verification', () => {
  const quote = quoteApiUsage({
    tier: 'advanced',
    bandwidthGb: 3,
    rpm: 180,
    periodHours: 12,
    sessionMode: 'sticky',
  })

  assert.ok(quote.constraints.some((constraint) => constraint.code === 'tier_sticky_required_verification'))
  assert.ok(quote.estimatedUsd > 0)
})

test('sharedBytesToCreditBytes grants a 1:1 credit floor', () => {
  assert.equal(sharedBytesToCreditBytes(2048.9), 2048)
  assert.equal(sharedBytesToCreditBytes(-1), 0)
})

test('settleUserUsage consumes free bytes, then credits, then wallet balance', () => {
  const gib = 1024 ** 3
  const settlement = settleUserUsage({
    bytesUsed: 8 * gib,
    bandwidthUsedMonth: 2 * gib,
    bandwidthLimit: 5 * gib,
    contributionCreditsBytes: 4 * gib,
    walletBalanceUsd: 10,
  })

  assert.equal(settlement.freeBytes, 3 * gib)
  assert.equal(settlement.creditBytes, 4 * gib)
  assert.equal(settlement.paidBytes, 1 * gib)
  assert.equal(settlement.grossChargeUsd, 3)
  assert.equal(settlement.walletDebitUsd, 3)
  assert.equal(settlement.shortfallUsd, 0)
  assert.equal(settlement.providerPayoutUsd, 1.8)
  assert.equal(settlement.platformRevenueUsd, 1.2)
})

test('wallet balance converts to live browsing byte cap', () => {
  assert.equal(getBrowseBytesCoveredByWalletUsd(3), 1024 ** 3)
  assert.equal(getBrowseBytesCoveredByWalletUsd(0), 0)
})
