import { NextResponse } from 'next/server'
import { createApiKey } from '@/lib/api-keys'
import { getApiKeyTierConfig } from '@/lib/billing'
import { canRoleProvideNetwork } from '@/lib/roles'
import { getRequestUser } from '@/lib/request-auth'
import { adminClient } from '@/lib/supabase/admin'

const MAX_API_KEYS_PER_ACCOUNT = 20

function normalizeSessionMode(value: unknown): 'rotating' | 'sticky' {
  return value === 'sticky' ? 'sticky' : 'rotating'
}

export async function GET(req: Request) {
  const user = await getRequestUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [{ data: keys, error: keysError }, { data: usage, error: usageError }] = await Promise.all([
    adminClient
      .from('api_keys')
      .select('id, name, key_prefix, tier, rpm_limit, session_mode, requires_verification, is_active, last_used_at, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false }),
    adminClient
      .from('api_usage')
      .select('id, api_key_id, session_id, request_id, bandwidth_bytes, rpm_requested, session_mode, duration_minutes, estimated_cost_usd, collected_cost_usd, shortfall_cost_usd, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(10),
  ])

  if (keysError) return NextResponse.json({ error: keysError.message }, { status: 500 })
  if (usageError) return NextResponse.json({ error: usageError.message }, { status: 500 })

  return NextResponse.json({
    keys: keys ?? [],
    usage: usage ?? [],
  })
}

export async function POST(req: Request) {
  const user = await getRequestUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!user.email_confirmed_at) {
    return NextResponse.json({ error: 'Confirm your email before creating API keys.' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 64) : ''
  const tier = body.tier === 'advanced' || body.tier === 'enterprise' || body.tier === 'contributor'
    ? body.tier
    : 'standard'
  const sessionMode = normalizeSessionMode(body.sessionMode)
  const requestedRpm = Math.max(1, Math.floor(Number(body.rpmLimit ?? 60) || 60))

  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  const { count: keyCount, error: keyCountError } = await adminClient
    .from('api_keys')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
  if (keyCountError) return NextResponse.json({ error: keyCountError.message }, { status: 500 })
  if ((keyCount ?? 0) >= MAX_API_KEYS_PER_ACCOUNT) {
    return NextResponse.json({
      error: `API key limit reached. Each account can have up to ${MAX_API_KEYS_PER_ACCOUNT} keys.`,
      code: 'api_key_limit',
      maxKeys: MAX_API_KEYS_PER_ACCOUNT,
    }, { status: 429 })
  }

  const { data: profile, error: profileError } = await adminClient
    .from('profiles')
    .select('role, is_verified, has_accepted_provider_terms')
    .eq('id', user.id)
    .single<{
      role: string | null
      is_verified: boolean | null
      has_accepted_provider_terms: boolean | null
    }>()

  if (profileError || !profile) {
    return NextResponse.json({ error: profileError?.message ?? 'Profile not found' }, { status: 404 })
  }

  const config = getApiKeyTierConfig(tier)
  if (sessionMode === 'sticky' && !config.supportsSticky) {
    return NextResponse.json({ error: `${config.label} keys only support rotating sessions.` }, { status: 400 })
  }
  if (requestedRpm > config.maxRpm) {
    return NextResponse.json({ error: `${config.label} keys are capped at ${config.maxRpm} RPM.` }, { status: 400 })
  }
  if (sessionMode === 'sticky' && config.maxStickyRpm > 0 && requestedRpm > config.maxStickyRpm) {
    return NextResponse.json({ error: `Sticky sessions are capped at ${config.maxStickyRpm} RPM for ${config.label} keys.` }, { status: 400 })
  }
  if (config.requiresVerification && profile.is_verified !== true) {
    return NextResponse.json({ error: 'Verify your phone before creating this API key tier.' }, { status: 403 })
  }
  if (tier === 'contributor') {
    if (!canRoleProvideNetwork(profile.role)) {
      return NextResponse.json({ error: 'Contributor keys are only available to Peer or Host accounts.' }, { status: 403 })
    }
    if (profile.has_accepted_provider_terms !== true) {
      return NextResponse.json({ error: 'Accept the provider disclosure before creating a Contributor key.' }, { status: 403 })
    }
  }

  const created = await createApiKey({
    userId: user.id,
    name,
    tier,
    rpmLimit: requestedRpm,
    sessionMode,
    requiresVerification: config.requiresVerification,
  })

  return NextResponse.json({
    key: created.key,
    record: {
      id: created.record.id,
      name: created.record.name,
      key_prefix: created.record.keyPrefix,
      tier: created.record.tier,
      rpm_limit: created.record.rpmLimit,
      session_mode: created.record.sessionMode,
      requires_verification: created.record.requiresVerification,
      is_active: created.record.isActive,
      last_used_at: created.record.lastUsedAt,
      created_at: created.record.createdAt,
    },
  })
}

export async function PATCH(req: Request) {
  const user = await getRequestUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const id = typeof body.id === 'string' ? body.id.trim() : ''
  const isActive = body.isActive === true

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const { error } = await adminClient
    .from('api_keys')
    .update({ is_active: isActive })
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, id, is_active: isActive })
}
