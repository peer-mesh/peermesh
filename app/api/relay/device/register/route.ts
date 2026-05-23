import { randomUUID } from 'crypto'
import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { resolveRequesterAuth } from '@/lib/requester-auth'

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_.:-]{6,160}$/

function normalizeDeviceId(value: unknown): string {
  const deviceId = typeof value === 'string' ? value.trim() : ''
  return DEVICE_ID_PATTERN.test(deviceId) ? deviceId : randomUUID()
}

function normalizeRole(value: unknown): 'provider' | 'requester' | null {
  if (value === 'provider' || value === 'requester') return value
  return null
}

export async function POST(req: Request) {
  const auth = await resolveRequesterAuth(req)
  if (!auth?.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const role = normalizeRole(body.role)
  const publicKey = typeof body.publicKey === 'string' ? body.publicKey.trim() : ''
  const binaryHash = typeof body.binaryHash === 'string' && body.binaryHash.trim()
    ? body.binaryHash.trim()
    : null
  const binaryVersion = typeof body.binaryVersion === 'string' && body.binaryVersion.trim()
    ? body.binaryVersion.trim().slice(0, 80)
    : null

  if (!role) return NextResponse.json({ error: 'role must be provider or requester' }, { status: 400 })
  if (publicKey.length < 40 || publicKey.length > 4096) {
    return NextResponse.json({ error: 'A valid Ed25519 publicKey is required' }, { status: 400 })
  }

  const deviceId = normalizeDeviceId(body.deviceId)
  const now = new Date().toISOString()

  const { data: existing } = await adminClient
    .from('device_keys')
    .select('device_id, user_id, revoked')
    .eq('device_id', deviceId)
    .maybeSingle()

  if (existing && existing.user_id !== auth.userId) {
    return NextResponse.json({ error: 'Device ID is already registered' }, { status: 409 })
  }
  if (existing?.revoked === true) {
    return NextResponse.json({ error: 'Device key has been revoked' }, { status: 403 })
  }

  const { error } = await adminClient
    .from('device_keys')
    .upsert({
      device_id: deviceId,
      user_id: auth.userId,
      public_key: publicKey,
      role,
      registered_at: now,
      binary_hash: binaryHash,
      binary_version: binaryVersion,
      revoked: false,
      revoked_at: null,
      revocation_reason: null,
    }, { onConflict: 'device_id' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await adminClient
    .from('trust_scores')
    .upsert({
      device_id: deviceId,
      updated_at: now,
    }, { onConflict: 'device_id', ignoreDuplicates: true })

  return NextResponse.json({
    deviceId,
    role,
    binaryHash,
    binaryVersion,
    registeredAt: now,
    attestationEnforced: false,
  })
}
