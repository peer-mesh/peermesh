import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getBrowseBytesCoveredByWalletUsd, getEffectiveBandwidthLimitBytes } from '@/lib/billing'
import { canRoleProvideNetwork, getProviderRoleError } from '@/lib/roles'
import { resolveAuthTokenUser } from '@/lib/requester-auth'

const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

type RequesterSessionRow = {
  id: string
  user_id: string
  status: string
  target_country: string | null
  provider_id: string | null
  provider_base_device_id: string | null
  api_key_id: string | null
}

export async function POST(req: Request) {
  const secret = req.headers.get('x-relay-secret') ?? ''
  if (!RELAY_SECRET || secret !== RELAY_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const token = typeof body.token === 'string' ? body.token.trim() : ''
  const expectedUserId = typeof body.userId === 'string' ? body.userId.trim() : ''
  const role = body.role === 'provider' ? 'provider' : body.role === 'requester' ? 'requester' : null

  if (!token || !role) {
    return NextResponse.json({ error: 'token and role are required' }, { status: 400 })
  }

  const auth = await resolveAuthTokenUser(token)
  if (!auth?.userId) {
    return NextResponse.json({ error: 'Invalid relay auth token' }, { status: 401 })
  }
  const userId = auth.userId
  const tokenKind = auth.kind

  if (expectedUserId && expectedUserId !== userId) {
    return NextResponse.json({ error: 'Relay auth token does not match the claimed user' }, { status: 403 })
  }

  try { await adminClient.rpc('ensure_current_bandwidth_month', { p_user_id: userId }) } catch {}

  const { data: profile, error: profileError } = await adminClient
    .from('profiles')
    .select('trust_score, role, is_verified, has_accepted_provider_terms, bandwidth_used_month, bandwidth_limit, is_premium, contribution_credits_bytes, wallet_balance_usd, outstanding_balance_usd, billing_hold_reason')
    .eq('id', userId)
    .maybeSingle()

  if (profileError || !profile) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
  }
  if (role === 'requester' && (Number(profile.outstanding_balance_usd ?? 0) > 0 || profile.billing_hold_reason)) {
    return NextResponse.json({
      error: 'Your account has an outstanding usage balance. Fund your wallet before continuing this session.',
      code: 'billing_hold',
      outstandingBalanceUsd: Number(profile.outstanding_balance_usd ?? 0),
    }, { status: 402 })
  }

  if (role === 'provider') {
    if (tokenKind === 'api_key') {
      return NextResponse.json({ error: 'API keys cannot register provider relays' }, { status: 403 })
    }
    if (!canRoleProvideNetwork(profile.role)) {
      return NextResponse.json({ error: getProviderRoleError(profile.role) }, { status: 403 })
    }
    if (profile.is_verified !== true) {
      return NextResponse.json({ error: 'Verify your phone before sharing bandwidth.' }, { status: 403 })
    }
    if (profile.has_accepted_provider_terms !== true) {
      return NextResponse.json({ error: 'Accept the provider disclosure before sharing bandwidth.' }, { status: 403 })
    }
    return NextResponse.json({
      ok: true,
      userId,
      tokenKind,
      trustScore: Number(profile.trust_score ?? 50),
    })
  }

  const dbSessionId = typeof body.dbSessionId === 'string' ? body.dbSessionId.trim() : ''
  if (!dbSessionId) {
    return NextResponse.json({ error: 'dbSessionId is required for requesters' }, { status: 400 })
  }

  const { data: session, error: sessionError } = await adminClient
    .from('sessions')
    .select('id, user_id, status, target_country, provider_id, provider_base_device_id, api_key_id')
    .eq('id', dbSessionId)
    .maybeSingle()

  if (sessionError || !session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  const sessionRow = session as RequesterSessionRow

  if (sessionRow.user_id !== userId) {
    return NextResponse.json({ error: 'Session does not belong to this user' }, { status: 403 })
  }
  if (tokenKind === 'api_key') {
    if (!auth.apiKey?.id || sessionRow.api_key_id !== auth.apiKey.id) {
      return NextResponse.json({ error: 'This API key was not used to authorize the session' }, { status: 403 })
    }
  }

  if (!['pending', 'active', 'reconnecting'].includes(sessionRow.status)) {
    return NextResponse.json({ error: 'Session is no longer active' }, { status: 409 })
  }

  const requestedCountry = typeof body.country === 'string' ? body.country.trim().toUpperCase() : ''
  if (requestedCountry && sessionRow.target_country && requestedCountry !== sessionRow.target_country) {
    return NextResponse.json({ error: 'Requested country does not match the authorized session' }, { status: 403 })
  }

  const requestedPrivateProviderUserId = typeof body.privateProviderUserId === 'string'
    ? body.privateProviderUserId.trim()
    : ''
  const requestedPrivateBaseDeviceId = typeof body.privateBaseDeviceId === 'string'
    ? body.privateBaseDeviceId.trim()
    : ''

  const authorizedPrivateProviderUserId = sessionRow.provider_id ?? ''
  const authorizedPrivateBaseDeviceId = sessionRow.provider_base_device_id ?? ''
  const sessionIsPrivate = !!authorizedPrivateProviderUserId || !!authorizedPrivateBaseDeviceId

  if (sessionIsPrivate) {
    if (
      (requestedPrivateProviderUserId && requestedPrivateProviderUserId !== authorizedPrivateProviderUserId)
      || (requestedPrivateBaseDeviceId && requestedPrivateBaseDeviceId !== authorizedPrivateBaseDeviceId)
    ) {
      return NextResponse.json({ error: 'Private routing claim does not match the authorized session' }, { status: 403 })
    }
  } else if (requestedPrivateProviderUserId || requestedPrivateBaseDeviceId) {
    return NextResponse.json({ error: 'Private routing was not authorized for this session' }, { status: 403 })
  }

  return NextResponse.json({
    ok: true,
    userId,
    tokenKind,
    trustScore: Number(profile.trust_score ?? 50),
    country: sessionRow.target_country ?? requestedCountry,
    privateProviderUserId: authorizedPrivateProviderUserId || null,
    privateBaseDeviceId: authorizedPrivateBaseDeviceId || null,
    billingCapBytes: Math.max(
      0,
      Math.floor(
        Math.max(0, getEffectiveBandwidthLimitBytes(Number(profile.bandwidth_limit ?? 0), profile.is_premium === true) - Number(profile.bandwidth_used_month ?? 0))
          + Math.max(0, Number(profile.contribution_credits_bytes ?? 0))
          + getBrowseBytesCoveredByWalletUsd(Number(profile.wallet_balance_usd ?? 0)),
      ),
    ),
  })
}
