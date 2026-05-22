import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { resolveRequesterAuth } from '@/lib/requester-auth'
import { settleSessionUsage } from '@/lib/wallet'
import { nextProviderHealthScore } from '@/lib/provider-health'

const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

function logSession(level: 'info' | 'warn' | 'error', message: string, context: Record<string, unknown>) {
  const line = `[session/end] ${message} ${JSON.stringify(context)}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.info(line)
}

async function updateProviderHealth({
  providerUserId,
  providerDeviceId,
  disconnectReason,
  providerAvgMbps,
  providerLastMbps,
  connectionQuality,
}: {
  providerUserId: string | null
  providerDeviceId: string | null
  disconnectReason: string | null
  providerAvgMbps: number
  providerLastMbps: number
  connectionQuality: unknown
}) {
  if (!providerUserId || !providerDeviceId) return

  const { data: device } = await adminClient
    .from('provider_devices')
    .select('health_score, disconnect_count, reconnect_count')
    .eq('user_id', providerUserId)
    .eq('device_id', providerDeviceId)
    .maybeSingle()

  const reason = String(disconnectReason || '').toLowerCase()
  const disconnectIncrement = reason.includes('provider') || reason.includes('timeout') || reason.includes('unresponsive') ? 1 : 0
  const reconnectIncrement = reason === 'reconnected' ? 1 : 0
  const healthScore = nextProviderHealthScore({
    currentScore: device?.health_score,
    disconnectReason,
    avgMbps: providerAvgMbps,
    lastMbps: providerLastMbps,
  })

  await adminClient
    .from('provider_devices')
    .update({
      health_score: healthScore,
      provider_avg_mbps: providerAvgMbps,
      provider_last_mbps: providerLastMbps,
      connection_quality: connectionQuality && typeof connectionQuality === 'object' ? connectionQuality : {},
      disconnect_count: Number(device?.disconnect_count ?? 0) + disconnectIncrement,
      reconnect_count: Number(device?.reconnect_count ?? 0) + reconnectIncrement,
      last_disconnect_reason: disconnectReason,
      last_session_at: new Date().toISOString(),
    })
    .eq('user_id', providerUserId)
    .eq('device_id', providerDeviceId)
}

// PATCH: relay updates provider_id / provider_kind / relay_endpoint / target_host
// mid-session. Called by relay syncs as the requester is attached, the provider
// acknowledges, or new target hosts are observed.
export async function PATCH(req: Request) {
  const secret = req.headers.get('x-relay-secret') ?? ''
  if (RELAY_SECRET && secret !== RELAY_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const {
    sessionId,
    dbSessionId,
    status,
    providerUserId,
    providerKind,
    providerDeviceId,
    providerBaseDeviceId,
    relayEndpoint,
    targetHost,
    targetHosts,
    disconnectReason,
    providerAvgMbps,
    providerLastMbps,
    connectionQuality,
    reconnectAttempts,
    reconnectReason,
  } = await req.json().catch(() => ({}))

  const resolvedId = dbSessionId ?? sessionId ?? null
  const hasPatchField = !!providerUserId || !!providerKind || !!providerDeviceId || !!providerBaseDeviceId || !!relayEndpoint || !!targetHost
    || (Array.isArray(targetHosts) && targetHosts.length > 0)
    || !!disconnectReason
    || typeof providerAvgMbps === 'number'
    || typeof providerLastMbps === 'number'
    || !!connectionQuality
    || typeof reconnectAttempts === 'number'
    || typeof reconnectReason === 'string'
    || typeof status === 'string'

  if (!resolvedId || !hasPatchField) {
    return NextResponse.json(
      { error: 'dbSessionId/sessionId plus at least one session field is required' },
      { status: 400 },
    )
  }

  const patch: Record<string, unknown> = {}
  if (providerUserId) patch.provider_id = providerUserId
  if (providerKind) patch.provider_kind = providerKind
  if (providerDeviceId) patch.provider_device_id = providerDeviceId
  if (providerBaseDeviceId) patch.provider_base_device_id = providerBaseDeviceId
  if (relayEndpoint) patch.relay_endpoint = relayEndpoint
  if (targetHost) patch.target_host = targetHost
  if (Array.isArray(targetHosts) && targetHosts.length > 0) patch.target_hosts = targetHosts
  if (disconnectReason) patch.disconnect_reason = disconnectReason
  if (typeof providerAvgMbps === 'number') patch.provider_avg_mbps = providerAvgMbps
  if (typeof providerLastMbps === 'number') patch.provider_last_mbps = providerLastMbps
  if (connectionQuality && typeof connectionQuality === 'object') patch.connection_quality = connectionQuality
  if (typeof reconnectAttempts === 'number') patch.reconnect_attempts = Math.max(0, reconnectAttempts)
  if (typeof reconnectReason === 'string') patch.reconnect_reason = reconnectReason
  if (typeof reconnectAttempts === 'number' || typeof reconnectReason === 'string' || status === 'reconnecting') {
    patch.last_reconnect_at = new Date().toISOString()
  }
  if (typeof status === 'string') patch.status = status

  const { error, count } = await adminClient
    .from('sessions')
    .update(patch, { count: 'exact' })
    .eq('id', resolvedId)
    .in('status', ['pending', 'active', 'reconnecting', 'ended'])

  if (error) {
    logSession('error', 'PATCH failed', { resolvedId, providerUserId, relayEndpoint, targetHost, error: error.message })
    return NextResponse.json({ error: 'Could not update session' }, { status: 500 })
  }

  if (!count) {
    logSession('warn', 'PATCH session row missing', { resolvedId, providerUserId, relayEndpoint, targetHost })
  }

  return NextResponse.json({ ok: true, updated: count ?? 0 })
}

// POST: end a session - called by the relay or by the client.
// Writes all final values to sessions in one update.
export async function POST(req: Request) {
  const relaySecret = req.headers.get('x-relay-secret') ?? ''
  const isRelay = RELAY_SECRET !== '' && relaySecret === RELAY_SECRET

  let userId: string | null = null

  if (!isRelay) {
    const auth = await resolveRequesterAuth(req)
    userId = auth?.userId ?? null
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const {
    sessionId,
    bytesUsed = 0,
    providerUserId,
    requesterUserId,
    country,
    targetHost,
    targetHosts,
    providerKind,
    providerDeviceId,
    providerBaseDeviceId,
    relayEndpoint,
    disconnectReason,
    providerAvgMbps,
    providerLastMbps,
    connectionQuality,
  } = await req.json().catch(() => ({}))

  if (!sessionId) return NextResponse.json({ error: 'sessionId is required' }, { status: 400 })

  // Load current session to fill in any fields the caller did not provide.
  const { data: existing, error: lookupError } = await adminClient
    .from('sessions')
    .select('provider_id, provider_kind, provider_device_id, provider_base_device_id, relay_endpoint, target_country, target_host, target_hosts, user_id, status, bytes_used, disconnect_reason, provider_avg_mbps, provider_last_mbps, connection_quality, request_auth_kind, api_key_id, request_id, pricing_tier, requested_rpm, requested_period_hours, requested_session_mode, started_at')
    .eq('id', sessionId)
    .maybeSingle()

  if (lookupError) {
    logSession('error', 'POST lookup failed', { sessionId, error: lookupError.message })
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }
  if (!existing) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }
  if (!isRelay && existing.user_id !== userId) {
    logSession('warn', 'POST forbidden for non-owner', { sessionId, userId, ownerUserId: existing.user_id })
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const finalProviderId = providerUserId ?? existing?.provider_id ?? null
  const finalRequesterId = isRelay ? (requesterUserId ?? existing?.user_id ?? null) : userId
  const finalCountry = country ?? existing?.target_country ?? null
  const finalProviderKind = providerKind ?? existing?.provider_kind ?? null
  const finalProviderDeviceId = providerDeviceId ?? existing?.provider_device_id ?? null
  const finalProviderBaseDeviceId = providerBaseDeviceId ?? existing?.provider_base_device_id ?? null
  const finalRelayEndpoint = relayEndpoint ?? existing?.relay_endpoint ?? null
  const finalTargetHost = targetHost ?? existing?.target_host ?? null
  const finalDisconnectReason = disconnectReason ?? existing?.disconnect_reason ?? null
  const finalProviderAvgMbps = typeof providerAvgMbps === 'number' ? providerAvgMbps : existing?.provider_avg_mbps ?? 0
  const finalProviderLastMbps = typeof providerLastMbps === 'number' ? providerLastMbps : existing?.provider_last_mbps ?? 0
  const finalConnectionQuality = connectionQuality && typeof connectionQuality === 'object'
    ? connectionQuality
    : existing?.connection_quality ?? {}
  const relayObservedBytes = Math.max(0, Number(existing?.bytes_used) || 0)
  const clientReportedBytes = Math.max(0, Number(bytesUsed) || 0)
  const finalBytes = isRelay
    ? Math.max(clientReportedBytes, relayObservedBytes)
    : relayObservedBytes
  const finalDurationMinutes = existing?.started_at
    ? Math.max(0, Math.ceil((Date.now() - new Date(existing.started_at).getTime()) / 60_000))
    : Math.max(0, Math.floor(Number(existing?.requested_period_hours ?? 0) * 60))

  // Merge incoming target_hosts with any already stored on the row.
  const existingHosts: string[] = (existing as { target_hosts?: string[] | null } | null)?.target_hosts ?? []
  const incomingHosts: string[] = Array.isArray(targetHosts) ? targetHosts : []
  const mergedHosts = [...new Set([...existingHosts, ...incomingHosts, ...(finalTargetHost ? [finalTargetHost] : [])])]

  // Non-relay callers are not authoritative for byte usage or final session
  // closure. The relay meters traffic and submits the billable byte count.
  if (!isRelay) {
    const { error: advisoryError } = await adminClient
      .from('sessions')
      .update({
        provider_id: finalProviderId,
        provider_kind: finalProviderKind,
        provider_device_id: finalProviderDeviceId,
        provider_base_device_id: finalProviderBaseDeviceId,
        relay_endpoint: finalRelayEndpoint,
        target_host: finalTargetHost,
        target_hosts: mergedHosts,
        disconnect_reason: finalDisconnectReason,
        provider_avg_mbps: finalProviderAvgMbps,
        provider_last_mbps: finalProviderLastMbps,
        connection_quality: finalConnectionQuality,
      })
      .eq('id', sessionId)
      .in('status', ['pending', 'active', 'reconnecting', 'ended'])

    if (advisoryError) {
      logSession('error', 'POST advisory update failed', { sessionId, error: advisoryError.message })
      return NextResponse.json({ error: 'Could not update session metadata' }, { status: 500 })
    }

    if (clientReportedBytes > 0) {
      logSession('warn', 'Ignored client-reported bytesUsed; relay metering is authoritative', {
        sessionId,
        userId,
        clientReportedBytes,
        relayObservedBytes,
      })
    }

    return NextResponse.json({
      success: true,
      authoritativeMetering: 'relay',
      bytesUsedAccepted: false,
      bytesUsedObserved: relayObservedBytes,
      awaitingRelayFinalization: existing.status !== 'ended',
    }, { status: 202 })
  }

  // End the session - update all fields in one write.
  const { error: endError, count } = await adminClient
    .from('sessions')
    .update({
      status: 'ended',
      ended_at: new Date().toISOString(),
      bytes_used: finalBytes,
      provider_id: finalProviderId,
      provider_kind: finalProviderKind,
      provider_device_id: finalProviderDeviceId,
      provider_base_device_id: finalProviderBaseDeviceId,
      relay_endpoint: finalRelayEndpoint,
      target_host: finalTargetHost,
      target_hosts: mergedHosts,
      disconnect_reason: finalDisconnectReason,
      provider_avg_mbps: finalProviderAvgMbps,
      provider_last_mbps: finalProviderLastMbps,
      connection_quality: finalConnectionQuality,
    }, { count: 'exact' })
    .eq('id', sessionId)
    .in('status', ['pending', 'active', 'reconnecting'])

  if (endError) {
    logSession('error', 'POST end failed', { sessionId, error: endError.message })
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  // If already ended (count=0), still patch metadata so it stays complete.
  if (count === 0) {
    await adminClient
      .from('sessions')
      .update({
        provider_id: finalProviderId,
        provider_kind: finalProviderKind,
        provider_device_id: finalProviderDeviceId,
        provider_base_device_id: finalProviderBaseDeviceId,
        relay_endpoint: finalRelayEndpoint,
        target_host: finalTargetHost,
        target_hosts: mergedHosts,
        bytes_used: finalBytes,
        disconnect_reason: finalDisconnectReason,
        provider_avg_mbps: finalProviderAvgMbps,
        provider_last_mbps: finalProviderLastMbps,
        connection_quality: finalConnectionQuality,
      })
      .eq('id', sessionId)
  }

  const shouldApplyCounters = count !== 0
  let settlement:
    | {
        walletDebitUsd: number
        providerPayoutUsd: number
        platformRevenueUsd: number
        grossChargeUsd: number
        shortfallUsd: number
        contributionCreditsSpentBytes: number
        apiUsageRecorded: boolean
      }
    | null = null

  if (shouldApplyCounters && finalBytes > 0 && finalRequesterId) {
    settlement = await settleSessionUsage({
      requesterId: finalRequesterId,
      providerUserId: finalProviderId,
      sessionId,
      bytesUsed: finalBytes,
      source: existing?.request_auth_kind === 'api_key' ? 'api_key' : 'user',
      apiKeyId: existing?.api_key_id ?? null,
      apiRequestId: existing?.request_id ?? null,
      tier: existing?.pricing_tier ?? null,
      requestedRpm: existing?.requested_rpm ?? null,
      requestedPeriodHours: existing?.requested_period_hours ?? null,
      requestedSessionMode: existing?.requested_session_mode ?? null,
      durationMinutes: finalDurationMinutes,
    })
  }

  await updateProviderHealth({
    providerUserId: finalProviderId,
    providerDeviceId: finalProviderDeviceId,
    disconnectReason: finalDisconnectReason,
    providerAvgMbps: finalProviderAvgMbps,
    providerLastMbps: finalProviderLastMbps,
    connectionQuality: finalConnectionQuality,
  })

  await Promise.all([
    shouldApplyCounters && finalBytes > 0 && finalRequesterId
      ? adminClient.rpc('increment_bandwidth', { p_user_id: finalRequesterId, p_bytes: finalBytes })
      : Promise.resolve(),

    // Provider bytes shared - relay finalization is authoritative for extension
    // providers. Desktop and CLI providers report their own bytes separately.
    shouldApplyCounters && finalBytes > 0 && finalProviderId &&
    finalProviderKind !== 'desktop' && finalProviderKind !== 'cli'
      ? adminClient.rpc('increment_bytes_shared', { p_user_id: finalProviderId, p_bytes: finalBytes })
      : Promise.resolve(),

    shouldApplyCounters && finalRequesterId && finalProviderId && finalCountry
      ? adminClient.rpc('set_preferred_provider', {
          p_user_id: finalRequesterId,
          p_country: finalCountry,
          p_provider_user_id: finalProviderId,
        })
      : Promise.resolve(),
  ])

  logSession('info', 'POST session finalized', {
    sessionId,
    isRelay,
    finalProviderId,
    finalRequesterId,
    finalCountry,
    finalProviderKind,
    finalProviderDeviceId,
    finalRelayEndpoint,
    finalTargetHost,
    finalDisconnectReason,
    finalBytes,
    settlement,
    endedActiveRow: count ?? 0,
  })

  return NextResponse.json({ success: true })
}
