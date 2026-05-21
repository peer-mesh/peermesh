import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { issueDesktopToken, verifyDesktopToken } from '@/lib/desktop-token'
import { adminClient } from '@/lib/supabase/admin'

const DEVICE_SESSION_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000

type DeviceSessionRow = {
  id: string
  user_id: string
  refresh_token_hash: string
  refresh_expires_at: string
  revoked_at: string | null
}

type DeviceSessionActor = 'device_flow' | 'dashboard' | 'extension'

export type ActiveDesktopSession = {
  userId: string
  deviceSessionId: string
}

export type DesktopSessionVerification =
  | ({ ok: true } & ActiveDesktopSession)
  | {
      ok: false
      reason: 'invalid_token' | 'revoked' | 'expired' | 'not_found' | 'mismatch'
    }

export type DeviceSessionIssueResult = {
  userId: string
  deviceSessionId: string
  token: string
  refreshToken: string
  refreshExpiresAt: string
}

export type DeviceSessionRefreshResult =
  | ({ ok: true } & DeviceSessionIssueResult)
  | {
      ok: false
      reason: 'invalid' | 'revoked' | 'expired' | 'not_found'
    }

function issueRefreshToken(): string {
  return randomBytes(32).toString('base64url')
}

function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function safeHashEquals(actual: string, expected: string): boolean {
  try {
    const actualBuffer = Buffer.from(actual, 'hex')
    const expectedBuffer = Buffer.from(expected, 'hex')
    if (actualBuffer.length !== expectedBuffer.length) return false
    return timingSafeEqual(actualBuffer, expectedBuffer)
  } catch {
    return false
  }
}

async function getDeviceSession(deviceSessionId: string): Promise<DeviceSessionRow | null> {
  const { data, error } = await adminClient
    .from('device_sessions')
    .select('id, user_id, refresh_token_hash, refresh_expires_at, revoked_at')
    .eq('id', deviceSessionId)
    .maybeSingle<DeviceSessionRow>()

  if (error || !data) return null
  return data
}

function isRefreshExpired(refreshExpiresAt: string): boolean {
  return new Date(refreshExpiresAt).getTime() <= Date.now()
}

export async function createDeviceSession(input: {
  userId: string
  deviceCodeId?: string | null
  actor?: DeviceSessionActor
}): Promise<DeviceSessionIssueResult> {
  const refreshToken = issueRefreshToken()
  const refreshExpiresAt = new Date(Date.now() + DEVICE_SESSION_TTL_MS).toISOString()

  const { data, error } = await adminClient
    .from('device_sessions')
    .insert({
      user_id: input.userId,
      device_code_id: input.deviceCodeId ?? null,
      actor: input.actor ?? 'device_flow',
      refresh_token_hash: hashRefreshToken(refreshToken),
      refresh_expires_at: refreshExpiresAt,
      last_used_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('id')
    .single<{ id: string }>()

  if (error || !data?.id) {
    throw new Error(error?.message ?? 'Could not create device session')
  }

  return {
    userId: input.userId,
    deviceSessionId: data.id,
    token: issueDesktopToken(input.userId, data.id),
    refreshToken,
    refreshExpiresAt,
  }
}

export async function verifyDesktopSessionToken(token: string): Promise<DesktopSessionVerification> {
  const payload = verifyDesktopToken(token)
  if (!payload) return { ok: false, reason: 'invalid_token' }

  const session = await getDeviceSession(payload.sid)
  if (!session) return { ok: false, reason: 'not_found' }
  if (session.user_id !== payload.sub) return { ok: false, reason: 'mismatch' }
  if (session.revoked_at) return { ok: false, reason: 'revoked' }
  if (isRefreshExpired(session.refresh_expires_at)) return { ok: false, reason: 'expired' }

  return {
    ok: true,
    userId: session.user_id,
    deviceSessionId: session.id,
  }
}

export async function refreshDeviceSession(input: {
  deviceSessionId: string
  refreshToken: string
}): Promise<DeviceSessionRefreshResult> {
  const session = await getDeviceSession(input.deviceSessionId)
  if (!session) return { ok: false, reason: 'not_found' }
  if (session.revoked_at) return { ok: false, reason: 'revoked' }
  if (isRefreshExpired(session.refresh_expires_at)) return { ok: false, reason: 'expired' }

  const expectedHash = hashRefreshToken(input.refreshToken)
  if (!safeHashEquals(expectedHash, session.refresh_token_hash)) {
    return { ok: false, reason: 'invalid' }
  }

  const nextRefreshExpiresAt = new Date(Date.now() + DEVICE_SESSION_TTL_MS).toISOString()
  const { error } = await adminClient
    .from('device_sessions')
    .update({
      refresh_expires_at: nextRefreshExpiresAt,
      last_used_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', session.id)

  if (error) {
    throw new Error(error.message)
  }

  return {
    ok: true,
    userId: session.user_id,
    deviceSessionId: session.id,
    token: issueDesktopToken(session.user_id, session.id),
    refreshToken: input.refreshToken,
    refreshExpiresAt: nextRefreshExpiresAt,
  }
}

export async function revokeUserDeviceSessions(userId: string): Promise<void> {
  await adminClient
    .from('device_sessions')
    .update({
      revoked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .is('revoked_at', null)
}

export async function revokeDeviceSession(deviceSessionId: string): Promise<void> {
  await adminClient
    .from('device_sessions')
    .update({
      revoked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', deviceSessionId)
    .is('revoked_at', null)
}

export async function resolveBearerUser(token: string): Promise<{
  userId: string | null
  authKind: 'desktop' | 'supabase' | null
  deviceSessionId?: string | null
}> {
  const desktop = await verifyDesktopSessionToken(token)
  if (desktop.ok) {
    return {
      userId: desktop.userId,
      authKind: 'desktop',
      deviceSessionId: desktop.deviceSessionId,
    }
  }

  try {
    const { data } = await adminClient.auth.getUser(token)
    if (data.user?.id) {
      return { userId: data.user.id, authKind: 'supabase', deviceSessionId: null }
    }
  } catch {}

  return { userId: null, authKind: null, deviceSessionId: null }
}
