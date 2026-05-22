import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { isUserTrusted } from '@/lib/traffic-filter'
import { createHmac } from 'crypto'
import { isPrivateShareActive, normalizePrivateShareCode } from '@/lib/private-sharing'
import { queueOnDemandPrivateWake } from '@/lib/on-demand-wake-server'
import { getRelayFallbackList, relayHttpUrl, RELAY_ENDPOINTS } from '@/lib/relay-endpoints'
import {
  buildOccupiedProviderDeviceSet,
  buildProviderDeviceOccupancyLookupKeys,
  filterAvailableProviderDevices,
  type ProviderDeviceRow,
} from '@/lib/provider-capacity'
import { isProviderHealthy, sortProvidersByHealth } from '@/lib/provider-health'
import { getConnectionAccessRequirement, hasPaidAccess } from '@/lib/account-access'
import { getEffectiveBandwidthLimitBytes, quoteApiUsage } from '@/lib/billing'
import { touchApiKeyLastUsed } from '@/lib/api-keys'
import { buildSessionWebhookPayload, enqueueWebhookEvent } from '@/lib/developer-webhooks'
import { resolveRequesterAuth } from '@/lib/requester-auth'
import { checkServerRateLimit } from '@/lib/server-rate-limit'

function getReceiptSecret(): string {
  const secret = process.env.RECEIPT_SECRET ?? process.env.RELAY_SECRET ?? ''
  if (!secret) {
    throw new Error('RECEIPT_SECRET is not configured')
  }
  return secret
}

export function issueAccountabilityReceipt(payload: {
  sessionId: string
  requesterId: string
  country: string
  timestamp: number
}): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', getReceiptSecret()).update(data).digest('base64url')
  return `${data}.${sig}`
}

export function verifyAccountabilityReceipt(receipt: string): {
  valid: boolean
  payload?: { sessionId: string; requesterId: string; country: string; timestamp: number }
} {
  try {
    const [data, sig] = receipt.split('.')
    const expected = createHmac('sha256', getReceiptSecret()).update(data).digest('base64url')
    if (sig !== expected) return { valid: false }
    return { valid: true, payload: JSON.parse(Buffer.from(data, 'base64url').toString()) }
  } catch {
    return { valid: false }
  }
}

function toBaseDeviceId(deviceKey: string): string {
  const match = /^(.*)_slot_\d+$/.exec(deviceKey)
  return match?.[1] ?? deviceKey
}

function orderRelayCandidates(
  candidates: string[],
  orderedRelays: string[],
  preferredRelays: string[] = [],
): string[] {
  const dedupedCandidates = [...new Set(candidates.filter(Boolean))]
  if (dedupedCandidates.length === 0) return []

  const candidateSet = new Set(dedupedCandidates)
  const preferredSet = new Set(preferredRelays.filter(relay => candidateSet.has(relay)))

  return [
    ...orderedRelays.filter(relay => preferredSet.has(relay)),
    ...orderedRelays.filter(relay => candidateSet.has(relay) && !preferredSet.has(relay)),
    ...dedupedCandidates.filter(relay => !orderedRelays.includes(relay) && preferredSet.has(relay)),
    ...dedupedCandidates.filter(relay => !orderedRelays.includes(relay) && !preferredSet.has(relay)),
  ]
}

export async function POST(req: Request) {
  const auth = await resolveRequesterAuth(req)
  if (!auth?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const userId = auth.userId
  const rateLimit = checkServerRateLimit(`session:create:${userId}`, 30, 60_000)
  if (!rateLimit.ok) {
    return NextResponse.json(
      { error: 'Too many session requests. Please retry shortly.', retryAfterSeconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) } },
    )
  }
  const emailConfirmed = auth.emailConfirmed
  if (!emailConfirmed) {
    return NextResponse.json({
      error: 'Confirm your email before connecting.',
      code: 'email_confirmation_required',
      nextStep: '/auth/confirm-email',
    }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const hasPrivateCode = body.privateCode !== undefined
  const privateCode = normalizePrivateShareCode(body.privateCode)
  let country = typeof body.country === 'string' ? body.country.trim().toUpperCase() : ''
  const apiRequestId = typeof body.requestId === 'string' ? body.requestId.trim().slice(0, 120) : null
  if (!country && !hasPrivateCode) {
    return NextResponse.json({ error: 'country or privateCode is required' }, { status: 400 })
  }
  if (hasPrivateCode && !privateCode) {
    return NextResponse.json({ error: 'Private code must be exactly 9 digits' }, { status: 400 })
  }

  try { await adminClient.rpc('ensure_current_bandwidth_month', { p_user_id: userId }) } catch {}

  const { data: profile } = await adminClient
    .from('profiles')
    .select('role, trust_score, is_verified, is_sharing, is_premium, bandwidth_used_month, bandwidth_limit, preferred_providers, wallet_balance_usd, contribution_credits_bytes, outstanding_balance_usd, billing_hold_reason')
    .eq('id', userId)
    .single()

  const activeProfile = profile
  if (!activeProfile) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
  }
  if (!isUserTrusted(activeProfile.trust_score)) {
    return NextResponse.json({ error: 'Account suspended due to low trust score' }, { status: 403 })
  }
  if (Number(activeProfile.outstanding_balance_usd ?? 0) > 0 || activeProfile.billing_hold_reason) {
    return NextResponse.json({
      error: 'Your account has an outstanding usage balance. Fund your wallet before creating another session.',
      code: 'billing_hold',
      outstandingBalanceUsd: Number(activeProfile.outstanding_balance_usd ?? 0),
    }, { status: 402 })
  }
  const trustScore = Number(activeProfile.trust_score ?? 50)
  const maxConcurrentSessions = trustScore >= 80 ? 8 : trustScore >= 50 ? 3 : 1
  const { count: activeSessionCount, error: activeSessionCountError } = await adminClient
    .from('sessions')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('status', ['pending', 'active', 'reconnecting'])
  if (activeSessionCountError) {
    return NextResponse.json({ error: 'Could not verify active session limits' }, { status: 500 })
  }
  if ((activeSessionCount ?? 0) >= maxConcurrentSessions) {
    return NextResponse.json({
      error: 'Too many active PeerMesh sessions for this account.',
      code: 'active_session_limit',
      activeSessions: activeSessionCount ?? 0,
      maxConcurrentSessions,
    }, { status: 429 })
  }

  const requestAuthKind = auth.kind === 'desktop'
    ? 'desktop'
    : auth.kind === 'api_key'
      ? 'api_key'
      : 'user'
  let pricingTier: string | null = null
  let requestedBandwidthGb: number | null = null
  let requestedRpm: number | null = null
  let requestedPeriodHours: number | null = null
  let requestedSessionMode: 'rotating' | 'sticky' | null = null
  let estimatedCostUsd = 0

  if (auth.kind === 'api_key') {
    const apiKey = auth.apiKey
    if (!apiKey) {
      return NextResponse.json({ error: 'API key metadata is missing' }, { status: 401 })
    }

    const requestedMode = body.sessionMode === 'sticky' ? 'sticky' : 'rotating'
    const requestedRpmValue = Math.max(1, Math.floor(Number(body.rpm ?? 60) || 60))
    const requestedPeriodHoursValue = Math.max(1, Math.floor(Number(body.periodHours ?? 1) || 1))
    const requestedBandwidthGbValue = Math.max(0.05, Number(body.bandwidthGb ?? 1) || 1)

    if (requestedRpmValue > apiKey.rpmLimit) {
      return NextResponse.json({ error: `${apiKey.name} is capped at ${apiKey.rpmLimit} RPM.` }, { status: 403 })
    }
    if (requestedMode === 'sticky' && apiKey.sessionMode !== 'sticky') {
      return NextResponse.json({ error: `${apiKey.name} only supports rotating sessions.` }, { status: 403 })
    }
    if (apiKey.requiresVerification && activeProfile.is_verified !== true) {
      return NextResponse.json({ error: 'This API key requires a phone-verified account before sticky usage can be activated.' }, { status: 403 })
    }

    const quote = quoteApiUsage({
      tier: apiKey.tier,
      bandwidthGb: requestedBandwidthGbValue,
      rpm: requestedRpmValue,
      periodHours: requestedPeriodHoursValue,
      sessionMode: requestedMode,
    })
    if (!quote.ok) {
      return NextResponse.json({
        error: quote.constraints[0]?.message ?? 'Requested API usage exceeds the key limits.',
        constraints: quote.constraints,
      }, { status: 403 })
    }

    estimatedCostUsd = Number(quote.estimatedUsd ?? 0)
    if (Number(activeProfile.wallet_balance_usd ?? 0) < estimatedCostUsd) {
      return NextResponse.json({
        error: `Insufficient wallet balance. Fund at least $${estimatedCostUsd.toFixed(2)} for this API session.`,
      }, { status: 403 })
    }

    pricingTier = apiKey.tier
    requestedBandwidthGb = requestedBandwidthGbValue
    requestedRpm = requestedRpmValue
    requestedPeriodHours = requestedPeriodHoursValue
    requestedSessionMode = requestedMode
  } else {
    const accessRequirement = getConnectionAccessRequirement(activeProfile, {
      mode: hasPrivateCode ? 'private' : 'public',
    })
    if (!accessRequirement.ok) {
      return NextResponse.json({
        error: accessRequirement.error,
        code: accessRequirement.code,
        nextStep: accessRequirement.nextStep,
      }, { status: 403 })
    }

    const effectiveLimit = getEffectiveBandwidthLimitBytes(
      Number(activeProfile.bandwidth_limit ?? 0),
      activeProfile.is_premium === true,
    )
    const monthlyUsage = Number(activeProfile.bandwidth_used_month ?? 0)
    if (monthlyUsage >= effectiveLimit && !hasPaidAccess(activeProfile)) {
      return NextResponse.json({
        error: 'Monthly public browsing allocation exhausted. Use contribution credits, fund your USD wallet, or connect with a private share code.',
        code: 'usage_access_required',
        nextStep: '/developers/billing',
      }, { status: 403 })
    }
  }

  // Query live provider devices for this country to build a targeted relay list.
  // provider_devices.relay_url tells us exactly which relay each slot is on.
  // We exclude the requester's own devices. Private share paths skip this DB lookup.
  const cutoff = new Date(Date.now() - 45_000).toISOString()
  const orderedRelays = await getRelayFallbackList()

  let providerRelayUrls: string[] = []
  let preferredProviderUserId = (activeProfile.preferred_providers as Record<string, string>)?.[country] ?? null
  let privateProviderUserId: string | null = null
  let privateBaseDeviceId: string | null = null

  if (!hasPrivateCode) {
    const { data: liveProviders } = await adminClient
      .from('provider_devices')
      .select('user_id, relay_url, device_id, country_code, health_score, provider_avg_mbps, provider_last_mbps, disconnect_count, reconnect_count, last_heartbeat')
      .eq('country_code', country)
      .neq('user_id', userId)
      .gt('last_heartbeat', cutoff)
      .not('relay_url', 'is', null)

    const providerUserIds = [...new Set((liveProviders ?? []).map(row => row.user_id).filter(Boolean) as string[])]
    let publicProviders: ProviderDeviceRow[] = liveProviders ?? []

    if (providerUserIds.length > 0) {
      const { data: privateRows } = await adminClient
        .from('private_share_devices')
        .select('user_id, base_device_id, enabled, expires_at')
        .in('user_id', providerUserIds)

      const activePrivateRows = (privateRows ?? []).filter(row =>
        isPrivateShareActive(row.enabled, row.expires_at),
      )

      publicProviders = (liveProviders ?? []).filter((row) => {
        return !activePrivateRows.some((privateRow) => {
          if (privateRow.user_id !== row.user_id) return false
          if (privateRow.base_device_id === row.device_id) return true
          return !privateRow.base_device_id.includes('_slot_')
            && row.device_id?.startsWith(`${privateRow.base_device_id}_slot_`)
        })
      })
    }

    const publicDeviceIds = buildProviderDeviceOccupancyLookupKeys(publicProviders)
    if (publicDeviceIds.length > 0) {
      const { data: activeSessions } = await adminClient
        .from('sessions')
        .select('provider_id, provider_device_id')
        .eq('status', 'active')
        .in('provider_device_id', publicDeviceIds)
      const occupiedDevices = buildOccupiedProviderDeviceSet(activeSessions)
      publicProviders = sortProvidersByHealth(filterAvailableProviderDevices(publicProviders, occupiedDevices).filter(isProviderHealthy))
    }

    publicProviders = sortProvidersByHealth(publicProviders.filter(isProviderHealthy))

    const rawRelayUrls = [...new Set(publicProviders.map(row => row.relay_url).filter(Boolean) as string[])]
    const hasAnyProvider = publicProviders.length > 0

    if (!hasAnyProvider) {
      return NextResponse.json({ error: `No peers available in ${country}` }, { status: 409 })
    }

    if (rawRelayUrls.length > 0) {
      const preferredRelayUrls = publicProviders
        .filter(row => row.user_id === preferredProviderUserId && !!row.relay_url)
        .map(row => row.relay_url as string)
      providerRelayUrls = orderRelayCandidates(rawRelayUrls, orderedRelays, preferredRelayUrls)
    } else {
      // Providers exist but some older rows may not have relay_url yet.
      providerRelayUrls = orderedRelays
    }
  }

  if (hasPrivateCode) {
    const { data: privateShare, error: privateShareError } = await adminClient
      .from('private_share_devices')
      .select('user_id, base_device_id, enabled, expires_at')
      .eq('share_code', privateCode)
      .maybeSingle()

    if (privateShareError) {
      return NextResponse.json({ error: 'Could not validate private share code' }, { status: 500 })
    }
    if (!privateShare || !isPrivateShareActive(privateShare.enabled, privateShare.expires_at)) {
      return NextResponse.json({ error: 'Private share code is invalid or expired' }, { status: 404 })
    }
    if (privateShare.user_id === userId) {
      return NextResponse.json({ error: 'You cannot connect to your own private share code' }, { status: 400 })
    }

    // Check all relays in parallel for the private provider - the relay is authoritative.
    const privateDeviceKey = privateShare.base_device_id
    const privateBaseKey = toBaseDeviceId(privateDeviceKey)
    const onlineRelays: string[] = []
    let relayCountry: string | null = null
    const secret = process.env.RELAY_SECRET ?? ''

    await Promise.all(RELAY_ENDPOINTS.map(async (wsUrl) => {
      try {
        const qs = new URLSearchParams({
          providerUserId: privateShare.user_id,
          deviceId: privateDeviceKey,
          baseDeviceId: privateBaseKey,
        })
        const r = await fetch(`${relayHttpUrl(wsUrl)}/check-private?${qs}`, {
          headers: { 'x-relay-secret': secret },
          signal: AbortSignal.timeout(3000),
        })
        if (!r.ok) return
        const d = await r.json()
        if (d.online) {
          onlineRelays.push(wsUrl)
          relayCountry = d.country ?? relayCountry ?? null
        }
      } catch {}
    }))

    if (onlineRelays.length === 0) {
      const wakeResult = await queueOnDemandPrivateWake({
        privateCode,
        requesterUserId: userId,
        source: `session_create:${auth.kind}`,
      })
      const retryAfterSeconds = wakeResult.ok ? (wakeResult.providerReachable ? 8 : 30) : undefined
      return NextResponse.json({
        error: wakeResult.ok
          ? (wakeResult.providerReachable
              ? 'Private share is starting on the provider. Try again in a few seconds.'
              : 'Private share is currently offline. A private on-demand start request was queued for this provider.')
          : 'Private share is currently offline',
        onDemandStartQueued: wakeResult.ok,
        wakeQueued: wakeResult.ok && wakeResult.wakeIncluded,
        providerReachable: wakeResult.ok ? wakeResult.providerReachable : false,
        retryAfterSeconds,
      }, { status: 409 })
    }

    if (relayCountry) country = relayCountry
    preferredProviderUserId = privateShare.user_id
    privateProviderUserId = privateShare.user_id
    // Use the base device ID (without _slot_N) so any online slot from this
    // device can serve the requester — not just the specific slot the code
    // was issued for. The relay matches on peer.baseDeviceId which is always
    // the stripped base ID (e.g. pm_xxx, not pm_xxx_slot_0).
    privateBaseDeviceId = privateBaseKey
    providerRelayUrls = orderRelayCandidates(RELAY_ENDPOINTS, orderedRelays, onlineRelays)
  }

  if (!country) return NextResponse.json({ error: 'country is required' }, { status: 400 })

  const fallbackList = providerRelayUrls.length > 0 ? providerRelayUrls : orderedRelays
  const relay = fallbackList[0]

  try { await adminClient.rpc('cleanup_stale_sessions') } catch {}

  const { data: session, error: sessionError } = await adminClient
    .from('sessions')
    .insert({
      user_id: userId,
      request_access_mode: hasPrivateCode ? 'private' : 'public',
      request_auth_kind: requestAuthKind,
      api_key_id: auth.apiKey?.id ?? null,
      request_id: apiRequestId,
      pricing_tier: pricingTier,
      requested_bandwidth_gb: requestedBandwidthGb,
      requested_rpm: requestedRpm,
      requested_period_hours: requestedPeriodHours,
      requested_session_mode: requestedSessionMode,
      estimated_cost_usd: estimatedCostUsd,
      provider_id: privateProviderUserId,
      provider_base_device_id: privateBaseDeviceId,
      target_country: country,
      relay_endpoint: relay,
      status: 'pending',
    })
    .select('id')
    .single()

  if (sessionError || !session) {
    return NextResponse.json({ error: 'Failed to create session' }, { status: 500 })
  }

  const receipt = issueAccountabilityReceipt({
    sessionId: session.id,
    requesterId: userId,
    country,
    timestamp: Date.now(),
  })

  // Store the signed receipt on the session row itself - sessions is the single source of truth.
  await adminClient
    .from('sessions')
    .update({ signed_receipt: receipt })
    .eq('id', session.id)

  if (auth.apiKey?.id) {
    await touchApiKeyLastUsed(auth.apiKey.id)
  }

  enqueueWebhookEvent({
    userId,
    event: 'session.created',
    sessionId: session.id,
    payload: buildSessionWebhookPayload({
      event: 'session.created',
      session: {
        id: session.id,
        status: 'pending',
        country,
        accessMode: hasPrivateCode ? 'private' : 'public',
        authKind: requestAuthKind,
        requestId: apiRequestId,
        relayEndpoint: relay,
        createdAt: new Date().toISOString(),
      },
    }),
  }).catch(error => console.error('[webhooks] enqueue session.created failed', error))

  return NextResponse.json({
    sessionId: session.id,
    relayEndpoint: relay,
    relayFallbackList: fallbackList,
    receipt,
    country,
    preferredProviderUserId,
    privateProviderUserId,
    privateBaseDeviceId,
  })
}
