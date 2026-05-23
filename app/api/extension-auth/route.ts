import { NextResponse } from 'next/server'
import { createDeviceSession, verifyDesktopSessionToken } from '@/lib/device-sessions'
import { adminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://peermesh-0unl.onrender.com'
const AUTH_HANDOFF_TTL_MS = 10 * 60 * 1000

function generateDeviceCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

function generateUserCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const part = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  return `${part()}-${part()}`
}

async function requireWebSession() {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  return session ?? null
}

type ExtensionApprovalProfile = {
  username: string | null
  country_code: string | null
  trust_score: number | null
  role: string | null
  is_verified: boolean | null
  phone_number: string | null
  has_accepted_provider_terms: boolean | null
  contribution_credits_bytes: number | null
  wallet_balance_usd: number | null
  wallet_pending_payout_usd: number | null
}

type ExtensionLinkedProfile = ExtensionApprovalProfile & {
  is_premium: boolean | null
  total_bytes_shared: number | null
  total_bytes_used: number | null
  is_sharing: boolean | null
  daily_share_limit_mb: number | null
}

async function loadProfile<T>(userId: string, select: string): Promise<T | null> {
  const { data } = await adminClient
    .from('profiles')
    .select(select)
    .eq('id', userId)
    .maybeSingle<T>()

  return data
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))

  if (body.device === true) {
    const device_code = generateDeviceCode()
    const user_code = generateUserCode()

    await adminClient.from('device_codes').insert({
      device_code,
      user_code,
      status: 'pending',
      expires_at: new Date(Date.now() + AUTH_HANDOFF_TTL_MS).toISOString(),
    })

    return NextResponse.json({
      device_code,
      user_code,
      verification_uri: `${APP_URL}/extension`,
      expires_in: Math.floor(AUTH_HANDOFF_TTL_MS / 1000),
      interval: 3,
    }, { headers: CORS })
  }

  const session = await requireWebSession()
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers: CORS })
  if (!session.user.email_confirmed_at) {
    return NextResponse.json({ error: 'Confirm your email before linking an extension.' }, { status: 403, headers: CORS })
  }

  const ext_id = typeof body.ext_id === 'string' ? body.ext_id.trim() : ''
  if (!ext_id || ext_id.length < 10) {
    return NextResponse.json({ error: 'Invalid ext_id' }, { status: 400, headers: CORS })
  }

  const issued = await createDeviceSession({
    userId: session.user.id,
    actor: 'extension',
  })

  await adminClient.from('extension_auth_tokens').upsert({
    ext_id,
    user_id: session.user.id,
    token: issued.token,
    refresh_token: issued.refreshToken,
    device_session_id: issued.deviceSessionId,
    supabase_token: session.access_token,
    used: false,
    expires_at: new Date(Date.now() + AUTH_HANDOFF_TTL_MS).toISOString(),
  }, { onConflict: 'ext_id' })

  return NextResponse.json({ ok: true }, { headers: CORS })
}

export async function PATCH(req: Request) {
  const session = await requireWebSession()
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers: CORS })
  if (!session.user.email_confirmed_at) {
    return NextResponse.json({ error: 'Confirm your email before approving a device.' }, { status: 403, headers: CORS })
  }

  const { user_code, action } = await req.json().catch(() => ({}))
  if (!user_code || !['approve', 'deny'].includes(action)) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400, headers: CORS })
  }

  const normalized = String(user_code).toUpperCase().trim().replace(/[^A-Z0-9]/g, '')
  const formatted = normalized.length === 8 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized

  const { data: row, error } = await adminClient
    .from('device_codes')
    .select('id, status')
    .eq('user_code', formatted)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .maybeSingle<{ id: string; status: string }>()

  if (error) return NextResponse.json({ error: 'Database error' }, { status: 500, headers: CORS })
  if (!row) return NextResponse.json({ error: 'Invalid or expired code' }, { status: 404, headers: CORS })

  if (action === 'deny') {
    await adminClient
      .from('device_codes')
      .update({ status: 'denied', refresh_token: null })
      .eq('id', row.id)
    return NextResponse.json({ ok: true }, { headers: CORS })
  }

  const issued = await createDeviceSession({
    userId: session.user.id,
    deviceCodeId: row.id,
    actor: 'device_flow',
  })

  await adminClient.from('device_codes').update({
    status: 'approved',
    user_id: session.user.id,
    token: issued.token,
    refresh_token: issued.refreshToken,
    device_session_id: issued.deviceSessionId,
  }).eq('id', row.id)

  return NextResponse.json({ ok: true }, { headers: CORS })
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)

  if (searchParams.get('refresh') === '1') {
    return NextResponse.json({
      error: 'Deprecated refresh flow. Use POST /api/extension-auth/refresh.',
    }, { status: 410, headers: CORS })
  }

  if (searchParams.get('verify') === '1') {
    const auth = req.headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    const userId = searchParams.get('userId') ?? ''

    if (!token) return NextResponse.json({ error: 'Missing token' }, { status: 401, headers: CORS })

    const verification = await verifyDesktopSessionToken(token)
    if (!verification.ok) {
      if (verification.reason === 'revoked' || verification.reason === 'expired' || verification.reason === 'not_found') {
        return NextResponse.json({ revoked: true }, { status: 403, headers: CORS })
      }
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401, headers: CORS })
    }

    if (userId && verification.userId !== userId) {
      return NextResponse.json({ error: 'Token mismatch' }, { status: 403, headers: CORS })
    }

    return NextResponse.json({
      ok: true,
      userId: verification.userId,
      deviceSessionId: verification.deviceSessionId,
    }, { headers: CORS })
  }

  const device_code = searchParams.get('device_code')
  if (device_code) {
    const { data: row } = await adminClient
      .from('device_codes')
      .select('status, expires_at, user_id, token, refresh_token, device_session_id')
      .eq('device_code', device_code)
      .maybeSingle<{
        status: string
        expires_at: string
        user_id: string | null
        token: string | null
        refresh_token: string | null
        device_session_id: string | null
      }>()

    if (!row) return NextResponse.json({ error: 'Invalid device_code' }, { status: 404, headers: CORS })

    if (new Date(row.expires_at).getTime() < Date.now()) {
      await adminClient.from('device_codes').update({ status: 'expired', refresh_token: null }).eq('device_code', device_code)
      return NextResponse.json({ status: 'expired' }, { headers: CORS })
    }

    if (row.status === 'pending' || row.status === 'denied' || row.status === 'expired') {
      return NextResponse.json({ status: row.status }, { headers: CORS })
    }

    if (row.status === 'approved' && row.token && row.user_id && row.refresh_token && row.device_session_id) {
      const profile = await loadProfile<ExtensionApprovalProfile>(
        row.user_id,
        'username, country_code, trust_score, role, is_verified, phone_number, has_accepted_provider_terms, contribution_credits_bytes, wallet_balance_usd, wallet_pending_payout_usd',
      )
      if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404, headers: CORS })

      return NextResponse.json({
        status: 'approved',
        user: {
          id: row.user_id,
          token: row.token,
          refreshToken: row.refresh_token,
          deviceSessionId: row.device_session_id,
          username: profile.username,
          country: profile.country_code,
          trustScore: profile.trust_score,
          role: profile.role,
          isVerified: profile.is_verified ?? false,
          walletBalanceUsd: profile.wallet_balance_usd,
          contributionCreditsBytes: profile.contribution_credits_bytes,
          walletPendingPayoutUsd: profile.wallet_pending_payout_usd,
          hasAcceptedProviderTerms: profile.has_accepted_provider_terms ?? false,
        },
      }, { headers: CORS })
    }

    return NextResponse.json({ status: row.status }, { headers: CORS })
  }

  const ext_id = searchParams.get('ext_id')
  if (!ext_id) return NextResponse.json({ error: 'Missing parameter' }, { status: 400, headers: CORS })

  const { data: row } = await adminClient
    .from('extension_auth_tokens')
    .select('id, user_id, token, refresh_token, device_session_id, supabase_token')
    .eq('ext_id', ext_id)
    .eq('used', false)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle<{
      id: string
      user_id: string
      token: string
      refresh_token: string | null
      device_session_id: string | null
      supabase_token: string | null
    }>()

  if (!row) return NextResponse.json({ pending: true }, { headers: CORS })

  const verification = await verifyDesktopSessionToken(row.token)
  if (!verification.ok || verification.userId !== row.user_id) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401, headers: CORS })
  }

  const profile = await loadProfile<ExtensionLinkedProfile>(
    row.user_id,
    'username, country_code, trust_score, role, is_verified, phone_number, is_premium, total_bytes_shared, total_bytes_used, is_sharing, has_accepted_provider_terms, daily_share_limit_mb, contribution_credits_bytes, wallet_balance_usd, wallet_pending_payout_usd',
  )
  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404, headers: CORS })

  await adminClient
    .from('extension_auth_tokens')
    .update({ used: true, refresh_token: null })
    .eq('id', row.id)

  return NextResponse.json({
    user: {
      id: row.user_id,
      token: row.token,
      refreshToken: row.refresh_token,
      deviceSessionId: row.device_session_id,
      supabaseToken: row.supabase_token,
      username: profile.username,
      country: profile.country_code,
      trustScore: profile.trust_score,
      role: profile.role,
      isVerified: profile.is_verified ?? false,
      isPremium: profile.is_premium,
      totalShared: profile.total_bytes_shared,
      totalUsed: profile.total_bytes_used,
      isSharing: profile.is_sharing,
      contributionCreditsBytes: profile.contribution_credits_bytes,
      walletBalanceUsd: profile.wallet_balance_usd,
      walletPendingPayoutUsd: profile.wallet_pending_payout_usd,
      hasAcceptedProviderTerms: profile.has_accepted_provider_terms ?? false,
      dailyLimitMb: profile.daily_share_limit_mb,
    },
  }, { headers: CORS })
}
