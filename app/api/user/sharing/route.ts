import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { adminClient } from '@/lib/supabase/admin'
import { resolveBearerUser } from '@/lib/device-sessions'
import {
  buildPrivateShareExpiry,
  generatePrivateShareCode,
  isPrivateShareActive,
  parsePrivateShareExpiryHours,
} from '@/lib/private-sharing'
import { getEffectiveBandwidthLimitBytes } from '@/lib/billing'
import { canRoleProvideNetwork, getProviderRoleError } from '@/lib/roles'

const RELAY_SECRET = process.env.RELAY_SECRET ?? ''
const SURFACE_ACTORS = new Set(['dashboard', 'desktop', 'cli', 'extension'])

function isRelayRequest(req: Request): boolean {
  const relaySecret = req.headers.get('x-relay-secret') ?? ''
  return !!RELAY_SECRET && relaySecret === RELAY_SECRET
}

function normalizeStateActor(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? ''
  return SURFACE_ACTORS.has(normalized) ? normalized : null
}

function getRequestStateActor(req: Request, fallback = 'system'): string {
  if (isRelayRequest(req)) return 'relay'

  const explicit = normalizeStateActor(req.headers.get('x-peermesh-actor'))
  if (explicit) return explicit

  const origin = req.headers.get('origin') ?? ''
  if (origin.startsWith('chrome-extension://')) return 'extension'

  return fallback
}

function getStateChangedAt(value: string | null | undefined): number {
  if (!value) return 0
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

function serializeSyncState(row: { state_actor?: string | null; state_changed_at?: string | null } | null) {
  return {
    state_actor: row?.state_actor ?? null,
    state_changed_at: row?.state_changed_at ?? null,
  }
}

function getTodaySharedBytes(profile: {
  share_bytes_today?: number | null
  share_bytes_today_date?: string | null
}): number {
  const today = new Date().toISOString().slice(0, 10)
  return profile.share_bytes_today_date === today ? (profile.share_bytes_today ?? 0) : 0
}

function getProviderShareStatus(profile: {
  daily_share_limit_mb?: number | null
  share_bytes_today?: number | null
  share_bytes_today_date?: string | null
}, slotLimitRow?: SlotLimitRow | null) {
  const totalBytesToday = getTodaySharedBytes(profile)
  const limitBytes = profile.daily_share_limit_mb == null ? null : profile.daily_share_limit_mb * 1024 * 1024
  const slotStatus = getSlotLimitStatus(slotLimitRow ?? null)
  const profileCanAccept = limitBytes == null ? true : totalBytesToday < limitBytes
  const canAccept = profileCanAccept && slotStatus.slot_can_accept_sessions
  return {
    total_bytes_today: totalBytesToday,
    daily_limit_bytes: limitBytes,
    slot_total_bytes_today: slotStatus.slot_total_bytes_today,
    slot_daily_limit_bytes: slotStatus.slot_daily_limit_bytes,
    slot_can_accept_sessions: slotStatus.slot_can_accept_sessions,
    can_accept_sessions: canAccept,
  }
}

function parseDailyShareLimitMb(value: unknown): number | null | undefined {
  if (value === null) return null
  if (value === undefined) return undefined

  const raw = typeof value === 'string' ? value.trim() : String(value)
  if (!raw) return undefined

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed)) return undefined
  if (parsed < 1024) return undefined
  return parsed
}

type PrivateShareRow = {
  base_device_id: string
  share_code: string
  enabled: boolean
  expires_at: string | null
  state_actor: string | null
  state_changed_at: string | null
}

type SlotLimitRow = {
  device_id: string
  base_device_id: string
  slot_index: number | null
  daily_limit_mb: number | null
  bytes_today: number | null
  bytes_today_date: string | null
  state_actor: string | null
  state_changed_at: string | null
}

type ProviderDeviceStateRow = {
  device_id: string
  connection_slots: number | null
  last_heartbeat: string | null
  state_actor: string | null
  state_changed_at: string | null
}

type ProfileStateRow = {
  role: string | null
  is_verified?: boolean | null
  total_bytes_shared: number | null
  total_bytes_used: number | null
  bandwidth_used_month: number | null
  bandwidth_limit: number | null
  trust_score: number | null
  is_sharing: boolean | null
  is_premium: boolean | null
  daily_share_limit_mb: number | null
  has_accepted_provider_terms: boolean | null
  contribution_credits_bytes: number | null
  wallet_balance_usd: number | null
  wallet_pending_payout_usd: number | null
  payout_currency: string | null
  share_bytes_today: number | null
  share_bytes_today_date: string | null
  state_actor: string | null
  state_changed_at: string | null
}

function toBaseDeviceId(deviceKey: string): string {
  const match = /^(.*)_slot_\d+$/.exec(deviceKey)
  return match?.[1] ?? deviceKey
}

function getSlotIndex(deviceKey: string, baseDeviceId = toBaseDeviceId(deviceKey)): number | null {
  const prefix = `${baseDeviceId}_slot_`
  if (!deviceKey.startsWith(prefix)) return null
  const parsed = Number.parseInt(deviceKey.slice(prefix.length), 10)
  return Number.isInteger(parsed) ? parsed : null
}

function getSlotLimitStatus(row: SlotLimitRow | null) {
  if (!row) {
    return {
      slot_total_bytes_today: 0,
      slot_daily_limit_bytes: null as number | null,
      slot_can_accept_sessions: true,
    }
  }

  const today = new Date().toISOString().slice(0, 10)
  const totalBytesToday = row.bytes_today_date === today ? (row.bytes_today ?? 0) : 0
  const limitBytes = row.daily_limit_mb == null ? null : row.daily_limit_mb * 1024 * 1024

  return {
    slot_total_bytes_today: totalBytesToday,
    slot_daily_limit_bytes: limitBytes,
    slot_can_accept_sessions: limitBytes == null ? true : totalBytesToday < limitBytes,
  }
}

function sortPrivateShareRows(rows: PrivateShareRow[]): PrivateShareRow[] {
  return [...rows].sort((a, b) => {
    const aBase = toBaseDeviceId(a.base_device_id)
    const bBase = toBaseDeviceId(b.base_device_id)
    if (aBase !== bBase) return aBase.localeCompare(bBase)

    const aSlot = getSlotIndex(a.base_device_id, aBase)
    const bSlot = getSlotIndex(b.base_device_id, bBase)
    if (aSlot == null && bSlot == null) return a.base_device_id.localeCompare(b.base_device_id)
    if (aSlot == null) return -1
    if (bSlot == null) return 1
    return aSlot - bSlot
  })
}

function serializePrivateShare(row: PrivateShareRow | null) {
  if (!row) return null
  const baseDeviceId = toBaseDeviceId(row.base_device_id)
  return {
    device_id: row.base_device_id,
    base_device_id: baseDeviceId,
    slot_index: getSlotIndex(row.base_device_id, baseDeviceId),
    code: row.share_code,
    enabled: row.enabled,
    expires_at: row.expires_at,
    active: isPrivateShareActive(row.enabled, row.expires_at),
    ...serializeSyncState(row),
  }
}

function serializeSlotLimit(row: SlotLimitRow | null) {
  if (!row) return null
  const baseDeviceId = toBaseDeviceId(row.device_id || row.base_device_id)
  const status = getSlotLimitStatus(row)
  return {
    device_id: row.device_id,
    base_device_id: row.base_device_id || baseDeviceId,
    slot_index: Number.isInteger(row.slot_index) ? row.slot_index : getSlotIndex(row.device_id, baseDeviceId),
    daily_limit_mb: row.daily_limit_mb ?? null,
    bytes_today: status.slot_total_bytes_today,
    can_accept_sessions: status.slot_can_accept_sessions,
    ...serializeSyncState(row),
  }
}

function selectPrivateShareRow(
  rows: PrivateShareRow[],
  deviceId?: string | null,
  baseDeviceId?: string | null,
): PrivateShareRow | null {
  if (rows.length === 0) return null
  if (deviceId) {
    const exact = rows.find(row => row.base_device_id === deviceId)
    if (exact) return exact
  }
  if (baseDeviceId) {
    const exactBase = rows.find(row => row.base_device_id === baseDeviceId)
    if (exactBase) return exactBase
    const slotZero = rows.find(row => getSlotIndex(row.base_device_id, baseDeviceId) === 0)
    if (slotZero) return slotZero
  }
  return rows[0] ?? null
}

function resolveConfiguredSlots(rows: ProviderDeviceStateRow[], fallback = 1): number {
  const highest = rows.reduce((max, row) => {
    const value = Number.parseInt(String(row.connection_slots ?? ''), 10)
    if (!Number.isInteger(value) || value < 1) return max
    return Math.max(max, value)
  }, 0)
  return Math.max(1, highest || fallback)
}

function isMatchingPrivateShareKey(deviceKey: string, baseDeviceId: string): boolean {
  return deviceKey === baseDeviceId || deviceKey.startsWith(`${baseDeviceId}_slot_`)
}

function isMatchingSlotKey(deviceKey: string, baseDeviceId: string): boolean {
  return deviceKey === baseDeviceId || deviceKey.startsWith(`${baseDeviceId}_slot_`)
}

async function loadSlotLimitDevices(userId: string, baseDeviceId: string): Promise<SlotLimitRow[]> {
  const t0 = Date.now()
  const { data, error } = await adminClient
    .from('provider_slot_limits')
    .select('device_id, base_device_id, slot_index, daily_limit_mb, bytes_today, bytes_today_date, state_actor, state_changed_at')
    .eq('user_id', userId)

  if (error) throw error

  const filtered = (data ?? []).filter((row) => isMatchingSlotKey(row.device_id, baseDeviceId))
  console.log(`[slot] loadSlotLimitDevices user=${userId} base=${baseDeviceId} total=${data?.length ?? 0} matched=${filtered.length} ms=${Date.now() - t0}`)
  return filtered.sort((a, b) => {
    const aSlot = Number.isInteger(a.slot_index) ? (a.slot_index as number) : getSlotIndex(a.device_id, baseDeviceId) ?? -1
    const bSlot = Number.isInteger(b.slot_index) ? (b.slot_index as number) : getSlotIndex(b.device_id, baseDeviceId) ?? -1
    if (aSlot !== bSlot) return aSlot - bSlot
    return a.device_id.localeCompare(b.device_id)
  })
}

async function loadProviderDeviceStates(userId: string, baseDeviceId: string): Promise<ProviderDeviceStateRow[]> {
  const { data, error } = await adminClient
    .from('provider_devices')
    .select('device_id, connection_slots, last_heartbeat, state_actor, state_changed_at')
    .eq('user_id', userId)

  if (error) throw error

  const filtered = (data ?? []).filter((row) => isMatchingSlotKey(row.device_id, baseDeviceId))
  return filtered.sort((a, b) => {
    const changedDiff = getStateChangedAt(b.state_changed_at) - getStateChangedAt(a.state_changed_at)
    if (changedDiff !== 0) return changedDiff
    const heartbeatDiff = getStateChangedAt(b.last_heartbeat) - getStateChangedAt(a.last_heartbeat)
    if (heartbeatDiff !== 0) return heartbeatDiff
    return a.device_id.localeCompare(b.device_id)
  })
}

function selectSlotLimitRow(
  rows: SlotLimitRow[],
  deviceId?: string | null,
  baseDeviceId?: string | null,
): SlotLimitRow | null {
  if (rows.length === 0) return null
  if (deviceId) {
    const exact = rows.find((row) => row.device_id === deviceId)
    if (exact) return exact
  }
  if (baseDeviceId) {
    const exactBase = rows.find((row) => row.device_id === baseDeviceId)
    if (exactBase) return exactBase
    const slotZero = rows.find((row) => getSlotIndex(row.device_id, baseDeviceId) === 0)
    if (slotZero) return slotZero
  }
  return rows[0] ?? null
}

async function cleanupStaleSlotLimits(
  userId: string,
  baseDeviceId: string,
  maxSlots: number,
): Promise<{ deletedCount: number }> {
  const t0 = Date.now()
  try {
    const allSlots = await loadSlotLimitDevices(userId, baseDeviceId)
    const staleDeviceIds = allSlots
      .filter((row) => {
        const slotIndex = getSlotIndex(row.device_id, baseDeviceId)
        return slotIndex != null && slotIndex >= maxSlots
      })
      .map((row) => row.device_id)

    if (staleDeviceIds.length === 0) {
      console.log(`[slot] cleanupStaleSlotLimits user=${userId} base=${baseDeviceId} maxSlots=${maxSlots} stale=0 ms=${Date.now() - t0}`)
      return { deletedCount: 0 }
    }

    const { error } = await adminClient
      .from('provider_slot_limits')
      .delete()
      .eq('user_id', userId)
      .in('device_id', staleDeviceIds)

    if (error) {
      console.error(`[slot] cleanupStaleSlotLimits delete error user=${userId} base=${baseDeviceId}:`, error)
      return { deletedCount: 0 }
    }
    console.log(`[slot] cleanupStaleSlotLimits user=${userId} base=${baseDeviceId} maxSlots=${maxSlots} deleted=${staleDeviceIds.length} stale=${JSON.stringify(staleDeviceIds)} ms=${Date.now() - t0}`)
    return { deletedCount: staleDeviceIds.length }
  } catch (error) {
    console.error(`[slot] cleanupStaleSlotLimits error user=${userId} base=${baseDeviceId}:`, error)
    return { deletedCount: 0 }
  }
}

async function loadPrivateShareDevices(userId: string, baseDeviceId: string): Promise<PrivateShareRow[]> {
  const t0 = Date.now()
  const { data, error } = await adminClient
    .from('private_share_devices')
    .select('base_device_id, share_code, enabled, expires_at, state_actor, state_changed_at')
    .eq('user_id', userId)

  if (error) throw error
  const filtered = sortPrivateShareRows((data ?? []).filter(row => isMatchingPrivateShareKey(row.base_device_id, baseDeviceId)))
  console.log(`[slot] loadPrivateShareDevices user=${userId} base=${baseDeviceId} total=${data?.length ?? 0} matched=${filtered.length} ms=${Date.now() - t0}`)
  return filtered
}

function selectConnectionSlotState(
  rows: ProviderDeviceStateRow[],
  deviceId?: string | null,
  baseDeviceId?: string | null,
): ProviderDeviceStateRow | null {
  if (rows.length === 0) return null
  if (deviceId) {
    const exact = rows.find((row) => row.device_id === deviceId)
    if (exact) return exact
  }
  if (baseDeviceId) {
    const slotZero = rows.find((row) => getSlotIndex(row.device_id, baseDeviceId) === 0)
    if (slotZero) return slotZero
  }
  return rows[0] ?? null
}

async function issuePrivateShareCode(userId: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = generatePrivateShareCode()
    const { data, error } = await adminClient
      .from('private_share_devices')
      .select('id')
      .eq('share_code', code)
      .maybeSingle()

    if (error) throw error
    if (!data) return code
  }

  throw new Error(`Could not issue a unique private share code for ${userId}`)
}

async function cleanupStalePrivateShareSlots(
  userId: string,
  baseDeviceId: string,
  maxSlots?: number,
): Promise<{ deletedCount: number }> {
  const t0 = Date.now()
  try {
    const configuredSlots = Math.max(1, Number.parseInt(String(maxSlots ?? 1), 10) || 1)
    const allSlots = await loadPrivateShareDevices(userId, baseDeviceId)
    const staleSlots = allSlots.filter(row => {
      const slotIndex = getSlotIndex(row.base_device_id, baseDeviceId)
      return slotIndex !== null && slotIndex >= configuredSlots
    })

    console.log(`[slot] cleanupStalePrivateShareSlots user=${userId} base=${baseDeviceId} configuredSlots=${configuredSlots} total=${allSlots.length} stale=${staleSlots.length}`)

    if (staleSlots.length > 0) {
      const staleDeviceIds = staleSlots.map(row => row.base_device_id)
      console.log(`[slot] cleanupStalePrivateShareSlots deleting stale=${JSON.stringify(staleDeviceIds)}`)
      const { error } = await adminClient
        .from('private_share_devices')
        .delete()
        .eq('user_id', userId)
        .in('base_device_id', staleDeviceIds)

      if (error) {
        console.error(`[slot] cleanupStalePrivateShareSlots delete error user=${userId} base=${baseDeviceId}:`, error)
        return { deletedCount: 0 }
      }
      console.log(`[slot] cleanupStalePrivateShareSlots deleted=${staleSlots.length} ms=${Date.now() - t0}`)
      return { deletedCount: staleSlots.length }
    }

    console.log(`[slot] cleanupStalePrivateShareSlots nothing to delete ms=${Date.now() - t0}`)
    return { deletedCount: 0 }
  } catch (error) {
    console.error(`[slot] cleanupStalePrivateShareSlots error user=${userId} base=${baseDeviceId}:`, error)
    return { deletedCount: 0 }
  }
}

async function resolveUserId(req: Request, bodyUserId?: string): Promise<string | null> {
  if (isRelayRequest(req)) return bodyUserId ?? null

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user) return user.id

  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return null

  return (await resolveBearerUser(token)).userId
}

async function loadProviderEligibilityProfile(userId: string): Promise<{
  role: string | null
  is_verified: boolean | null
  has_accepted_provider_terms: boolean | null
} | null> {
  const { data, error } = await adminClient
    .from('profiles')
    .select('role, is_verified, has_accepted_provider_terms')
    .eq('id', userId)
    .maybeSingle<{
      role: string | null
      is_verified: boolean | null
      has_accepted_provider_terms: boolean | null
    }>()

  if (error || !data) return null
  return data
}

function getProviderEligibilityError(
  profile: {
    role: string | null
    is_verified: boolean | null
    has_accepted_provider_terms: boolean | null
  } | null,
  options: { requireTerms?: boolean } = {},
): string | null {
  if (!profile) return 'Profile not found'
  if (!canRoleProvideNetwork(profile.role)) return getProviderRoleError(profile.role)
  if (profile.is_verified !== true) return 'Verify your phone before sharing bandwidth.'
  if (options.requireTerms !== false && profile.has_accepted_provider_terms !== true) {
    return 'Accept the provider disclosure before sharing bandwidth.'
  }
  return null
}

// ── GET: fetch fresh profile stats (extension polls this) ──────────────────
export async function GET(req: Request) {
  const url = new URL(req.url)
  const relayProviderUserId = url.searchParams.get('providerUserId')
  const deviceId = url.searchParams.get('deviceId')?.trim() || null
  const baseDeviceId = url.searchParams.get('baseDeviceId')?.trim() || null

  if (isRelayRequest(req) && relayProviderUserId) {
    const { data, error } = await adminClient
      .from('profiles')
      .select('daily_share_limit_mb, share_bytes_today, share_bytes_today_date, state_actor, state_changed_at')
      .eq('id', relayProviderUserId)
      .single()

    if (error || !data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Also fetch private share state for this base device if requested
    let private_share = null
    let private_shares = null
    let slot_limit = null
    let slot_limits = null
    let connection_slots = null
    let connection_slots_sync = null
    const resolvedBaseDeviceId = baseDeviceId || (deviceId ? toBaseDeviceId(deviceId) : null)
    if (deviceId || resolvedBaseDeviceId) {
      const [rows, slotRows, providerRows] = await Promise.all([
        resolvedBaseDeviceId ? loadPrivateShareDevices(relayProviderUserId, resolvedBaseDeviceId) : Promise.resolve([]),
        resolvedBaseDeviceId ? loadSlotLimitDevices(relayProviderUserId, resolvedBaseDeviceId) : Promise.resolve([]),
        resolvedBaseDeviceId ? loadProviderDeviceStates(relayProviderUserId, resolvedBaseDeviceId) : Promise.resolve([]),
      ])
      const selectedProviderRow = selectConnectionSlotState(providerRows, deviceId, resolvedBaseDeviceId)
      private_share = serializePrivateShare(selectPrivateShareRow(rows, deviceId, resolvedBaseDeviceId))
      private_shares = rows.map(serializePrivateShare)
      slot_limit = serializeSlotLimit(selectSlotLimitRow(slotRows, deviceId, resolvedBaseDeviceId))
      slot_limits = slotRows.map(serializeSlotLimit)
      connection_slots = selectedProviderRow?.connection_slots ?? null
      connection_slots_sync = serializeSyncState(selectedProviderRow)
      return NextResponse.json({
        ...getProviderShareStatus(data, selectSlotLimitRow(slotRows, deviceId, resolvedBaseDeviceId)),
        profile_sync: serializeSyncState(data),
        private_share,
        private_shares,
        slot_limit,
        slot_limits,
        connection_slots,
        connection_slots_sync,
      })
    }
    return NextResponse.json({
      ...getProviderShareStatus(data),
      profile_sync: serializeSyncState(data),
      private_share,
      private_shares,
      slot_limit,
      slot_limits,
      connection_slots,
      connection_slots_sync,
    })
  }

  const userId = await resolveUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await adminClient
    .from('profiles')
    .select('role, total_bytes_shared, total_bytes_used, bandwidth_used_month, bandwidth_limit, trust_score, is_sharing, is_premium, daily_share_limit_mb, has_accepted_provider_terms, contribution_credits_bytes, wallet_balance_usd, wallet_pending_payout_usd, payout_currency, share_bytes_today, share_bytes_today_date, state_actor, state_changed_at')
    .eq('id', userId)
    .single<ProfileStateRow>()

  if (error || !data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const resolvedBaseDeviceId = baseDeviceId || (deviceId ? toBaseDeviceId(deviceId) : null)
  const [privateShareRows, slotLimitRows, providerRows] = await Promise.all([
    resolvedBaseDeviceId ? loadPrivateShareDevices(userId, resolvedBaseDeviceId) : Promise.resolve([]),
    resolvedBaseDeviceId ? loadSlotLimitDevices(userId, resolvedBaseDeviceId) : Promise.resolve([]),
    resolvedBaseDeviceId ? loadProviderDeviceStates(userId, resolvedBaseDeviceId) : Promise.resolve([]),
  ])
  const privateShare = serializePrivateShare(selectPrivateShareRow(privateShareRows, deviceId, resolvedBaseDeviceId))
  const privateShares = privateShareRows.map(serializePrivateShare)
  const selectedSlotLimit = selectSlotLimitRow(slotLimitRows, deviceId, resolvedBaseDeviceId)
  const slotLimit = serializeSlotLimit(selectedSlotLimit)
  const slotLimits = slotLimitRows.map(serializeSlotLimit)
  const selectedProviderRow = selectConnectionSlotState(providerRows, deviceId, resolvedBaseDeviceId)
  return NextResponse.json({
    role: data.role,
    total_bytes_shared: data.total_bytes_shared,
    total_bytes_used: data.total_bytes_used,
    bandwidth_used_month: data.bandwidth_used_month,
    bandwidth_limit: getEffectiveBandwidthLimitBytes(Number(data.bandwidth_limit ?? 0), data.is_premium === true),
    trust_score: data.trust_score,
    is_sharing: data.is_sharing,
    is_premium: data.is_premium,
    daily_share_limit_mb: data.daily_share_limit_mb,
    has_accepted_provider_terms: data.has_accepted_provider_terms,
    contribution_credits_bytes: data.contribution_credits_bytes,
    wallet_balance_usd: data.wallet_balance_usd,
    wallet_pending_payout_usd: data.wallet_pending_payout_usd,
    payout_currency: data.payout_currency,
    profile_sync: serializeSyncState(data),
    private_share: privateShare,
    private_shares: privateShares,
    slot_limit: slotLimit,
    slot_limits: slotLimits,
    connection_slots: selectedProviderRow?.connection_slots ?? null,
    connection_slots_sync: serializeSyncState(selectedProviderRow),
    ...getProviderShareStatus(data, selectedSlotLimit),
  })
}

// ── POST: set is_sharing flag OR increment bytes (desktop provider) ───────────
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const stateActor = getRequestStateActor(req)
  const stateChangedAt = new Date().toISOString()

  // Desktop bandwidth report: { bytes: number }
  if (typeof body.bytes === 'number' && body.bytes > 0) {
    const userId = await resolveUserId(req)
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    await adminClient.rpc('increment_bytes_shared', { p_user_id: userId, p_bytes: body.bytes })

    const slotDeviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : ''
    if (slotDeviceId) {
      const today = new Date().toISOString().slice(0, 10)
      const baseDeviceId = toBaseDeviceId(slotDeviceId)
      const slotIndex = getSlotIndex(slotDeviceId, baseDeviceId)
      const { data: current } = await adminClient
        .from('provider_slot_limits')
        .select('bytes_today, bytes_today_date, daily_limit_mb')
        .eq('user_id', userId)
        .eq('device_id', slotDeviceId)
        .maybeSingle()

      const nextBytesToday = current?.bytes_today_date === today
        ? (current?.bytes_today ?? 0) + body.bytes
        : body.bytes

      const { error: slotError } = await adminClient
        .from('provider_slot_limits')
        .upsert({
          user_id: userId,
          device_id: slotDeviceId,
          base_device_id: baseDeviceId,
          slot_index: slotIndex,
          daily_limit_mb: current?.daily_limit_mb ?? null,
          bytes_today: nextBytesToday,
          bytes_today_date: today,
          state_changed_at: stateChangedAt,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,device_id' })

      if (slotError) {
        console.error('slot bytes upsert error:', { userId, slotDeviceId, message: slotError.message })
      }
    }

    return NextResponse.json({ ok: true })
  }

  // Accept provider terms — works for all clients (Bearer token or cookie)
  if (body.acceptProviderTerms === true) {
    const userId = await resolveUserId(req)
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    await adminClient.from('profiles').update({ has_accepted_provider_terms: true }).eq('id', userId)
    return NextResponse.json({ ok: true })
  }

  if (body.privateSharing && typeof body.privateSharing === 'object') {
    const userId = await resolveUserId(req)
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const providerError = getProviderEligibilityError(await loadProviderEligibilityProfile(userId))
    if (providerError) return NextResponse.json({ error: providerError }, { status: 403 })

    const requestedDeviceId = String(body.privateSharing.deviceId ?? '').trim()
    const requestedBaseDeviceId = String(body.privateSharing.baseDeviceId ?? '').trim()
    const baseDeviceId = requestedBaseDeviceId || (requestedDeviceId ? toBaseDeviceId(requestedDeviceId) : '')
    if (!baseDeviceId && !requestedDeviceId) {
      return NextResponse.json({ error: 'deviceId or baseDeviceId is required' }, { status: 400 })
    }

    console.log(`[slot] privateSharing POST user=${userId} deviceId=${requestedDeviceId} baseDeviceId=${baseDeviceId} enabled=${body.privateSharing.enabled} refresh=${body.privateSharing.refresh} expiryHours=${body.privateSharing.expiryHours}`)

    const existingShares = baseDeviceId ? await loadPrivateShareDevices(userId, baseDeviceId) : []
    console.log(`[slot] privateSharing existing shares=${existingShares.length}:`, existingShares.map(r => ({ id: r.base_device_id, enabled: r.enabled, expires_at: r.expires_at })))
    const fallbackDeviceId = requestedBaseDeviceId
      ? (requestedBaseDeviceId.includes('_slot_')
          ? requestedBaseDeviceId
          : (existingShares[0]?.base_device_id ?? `${requestedBaseDeviceId}_slot_0`))
      : ''
    const deviceId = requestedDeviceId || fallbackDeviceId
    if (!deviceId || !baseDeviceId) {
      return NextResponse.json({ error: 'deviceId or baseDeviceId is required' }, { status: 400 })
    }

    if (body.privateSharing.enabled !== undefined && typeof body.privateSharing.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be boolean' }, { status: 400 })
    }

    const expiryHours = parsePrivateShareExpiryHours(body.privateSharing.expiryHours)
    if (body.privateSharing.expiryHours !== undefined && expiryHours === undefined) {
      return NextResponse.json({ error: 'expiryHours must be null or an integer between 1 and 720' }, { status: 400 })
    }

    const refresh = body.privateSharing.refresh === true
    const existing = existingShares.find(row => row.base_device_id === deviceId) ?? null
    const enabled = body.privateSharing.enabled ?? existing?.enabled ?? false
    const expiresAt = expiryHours !== undefined
      ? buildPrivateShareExpiry(expiryHours)
      : (existing?.expires_at ?? null)

    if (!enabled && !refresh && expiryHours === undefined && !existing) {
      return NextResponse.json({ ok: true, private_share: null, private_shares: [] })
    }

    let code = existing?.share_code ?? null
    if (!code || refresh) code = await issuePrivateShareCode(userId)

    const payload = {
      user_id: userId,
      base_device_id: deviceId,
      share_code: code,
      enabled,
      expires_at: expiresAt,
      state_actor: stateActor,
      state_changed_at: stateChangedAt,
      updated_at: new Date().toISOString(),
    }

    const writeQuery = existing && existing.base_device_id !== deviceId
      ? adminClient
          .from('private_share_devices')
          .update(payload)
          .eq('user_id', userId)
          .eq('base_device_id', existing.base_device_id)
      : adminClient
          .from('private_share_devices')
          .upsert(payload, { onConflict: 'user_id,base_device_id' })

    const { data, error } = await writeQuery
      .select('base_device_id, share_code, enabled, expires_at, state_actor, state_changed_at')
      .single()

    if (error || !data) {
      console.error(`[slot] privateSharing write error user=${userId} deviceId=${deviceId}:`, error)
      return NextResponse.json({ error: error?.message ?? 'Could not update private sharing' }, { status: 500 })
    }

    console.log(`[slot] privateSharing write ok deviceId=${data.base_device_id} enabled=${data.enabled} expires_at=${data.expires_at}`)

    // Clean up stale slots only when we have live provider state to determine the real slot count.
    // If providerRows is empty (desktop offline), skip cleanup to avoid deleting freshly-written rows.
    const providerRows = await loadProviderDeviceStates(userId, baseDeviceId)
    const configuredSlots = resolveConfiguredSlots(providerRows)
    console.log(`[slot] privateSharing post-write cleanup configuredSlots=${configuredSlots} providerRows=${providerRows.length}`)
    if (providerRows.length > 0) {
      await cleanupStalePrivateShareSlots(userId, baseDeviceId, configuredSlots)
    } else {
      console.log(`[slot] privateSharing post-write cleanup SKIPPED — no live provider rows, cannot determine safe slot count`)
    }

    const privateShareRows = await loadPrivateShareDevices(userId, baseDeviceId)
    const slotLimitRows = await loadSlotLimitDevices(userId, baseDeviceId)
    return NextResponse.json({
      ok: true,
      private_share: serializePrivateShare(data),
      private_shares: privateShareRows.map(serializePrivateShare),
      slot_limit: serializeSlotLimit(selectSlotLimitRow(slotLimitRows, deviceId, baseDeviceId)),
      slot_limits: slotLimitRows.map(serializeSlotLimit),
    })
  }

  // Web dashboard or desktop: { isSharing: boolean } or { dailyLimitMb: number | null }
  // resolveUserId accepts Supabase cookie, Supabase Bearer token, AND desktop device token
  const userId = await resolveUserId(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Setting daily share limit
  if ('dailyLimitMb' in body) {
    const providerError = getProviderEligibilityError(await loadProviderEligibilityProfile(userId), { requireTerms: false })
    if (providerError) return NextResponse.json({ error: providerError }, { status: 403 })
    const limitMb = parseDailyShareLimitMb(body.dailyLimitMb)
    if (limitMb === undefined) {
      return NextResponse.json({ error: 'dailyLimitMb must be null or at least 1024 MB (1 GB)' }, { status: 400 })
    }
    const { data: updatedProfile, error: updateError } = await adminClient
      .from('profiles')
      .update({ daily_share_limit_mb: limitMb ?? null, state_actor: stateActor, state_changed_at: stateChangedAt })
      .eq('id', userId)
      .select('daily_share_limit_mb, state_actor, state_changed_at')
      .single()

    if (updateError || !updatedProfile) {
      return NextResponse.json({ error: updateError?.message ?? 'Could not update daily limit' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      daily_share_limit_mb: updatedProfile.daily_share_limit_mb ?? null,
      profile_sync: serializeSyncState(updatedProfile),
    })
  }

  // Setting per-slot daily share limit
  if ('slotDailyLimitMb' in body) {
    const providerError = getProviderEligibilityError(await loadProviderEligibilityProfile(userId), { requireTerms: false })
    if (providerError) return NextResponse.json({ error: providerError }, { status: 403 })
    const slotDeviceId = typeof body.slotDeviceId === 'string' ? body.slotDeviceId.trim() : ''
    const slotBaseDeviceIdInput = typeof body.baseDeviceId === 'string' ? body.baseDeviceId.trim() : ''
    if (!slotDeviceId) {
      return NextResponse.json({ error: 'slotDeviceId is required' }, { status: 400 })
    }

    const limitMb = parseDailyShareLimitMb(body.slotDailyLimitMb)
    if (limitMb === undefined) {
      return NextResponse.json({ error: 'slotDailyLimitMb must be null or at least 1024 MB (1 GB)' }, { status: 400 })
    }

    const baseDeviceId = slotBaseDeviceIdInput || toBaseDeviceId(slotDeviceId)
    const slotIndex = getSlotIndex(slotDeviceId, baseDeviceId)
    console.log(`[slot] slotDailyLimitMb POST user=${userId} slotDeviceId=${slotDeviceId} base=${baseDeviceId} slotIndex=${slotIndex} limitMb=${limitMb}`)
    const { data: existing, error: existingError } = await adminClient
      .from('provider_slot_limits')
      .select('id')
      .eq('user_id', userId)
      .eq('device_id', slotDeviceId)
      .maybeSingle()

    if (existingError) {
      return NextResponse.json({ error: existingError.message }, { status: 500 })
    }

    const nowIso = new Date().toISOString()
    if (existing?.id) {
      const { error: updateError } = await adminClient
        .from('provider_slot_limits')
        .update({
          daily_limit_mb: limitMb ?? null,
          base_device_id: baseDeviceId,
          slot_index: slotIndex,
          state_actor: stateActor,
          state_changed_at: stateChangedAt,
          updated_at: nowIso,
        })
        .eq('id', existing.id)

      if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })
    } else {
      const { error: insertError } = await adminClient
        .from('provider_slot_limits')
        .insert({
          user_id: userId,
          device_id: slotDeviceId,
          base_device_id: baseDeviceId,
          slot_index: slotIndex,
          daily_limit_mb: limitMb ?? null,
          state_actor: stateActor,
          state_changed_at: stateChangedAt,
          bytes_today: 0,
          bytes_today_date: new Date().toISOString().slice(0, 10),
          updated_at: nowIso,
        })

      if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 })
    }

    const slotRows = await loadSlotLimitDevices(userId, baseDeviceId)
    return NextResponse.json({
      ok: true,
      slot_limit: serializeSlotLimit(selectSlotLimitRow(slotRows, slotDeviceId, baseDeviceId)),
      slot_limits: slotRows.map(serializeSlotLimit),
    })
  }

  // Setting connection slots — clean up stale private share slots with debouncing
  if ('connectionSlots' in body && typeof body.connectionSlots === 'number') {
    const providerError = getProviderEligibilityError(await loadProviderEligibilityProfile(userId), { requireTerms: false })
    if (providerError) return NextResponse.json({ error: providerError }, { status: 403 })
    const baseDeviceId = body.baseDeviceId ? String(body.baseDeviceId).trim() : null
    if (baseDeviceId) {
      const normalizedSlots = Math.max(1, Math.min(32, Number.parseInt(String(body.connectionSlots), 10) || 1))
      console.log(`[slot] connectionSlots POST user=${userId} base=${baseDeviceId} requested=${body.connectionSlots} normalized=${normalizedSlots}`)
      await adminClient
        .from('provider_devices')
        .update({ connection_slots: normalizedSlots, state_actor: stateActor, state_changed_at: stateChangedAt })
        .eq('user_id', userId)
        .like('device_id', `${baseDeviceId}_slot_%`)

      const resultPrivate = await cleanupStalePrivateShareSlots(userId, baseDeviceId, body.connectionSlots)
      const resultLimits = await cleanupStaleSlotLimits(userId, baseDeviceId, body.connectionSlots)
      console.log(`[slot] connectionSlots cleanup done user=${userId} base=${baseDeviceId} private=${resultPrivate.deletedCount} slotLimits=${resultLimits.deletedCount}`)

      const providerRows = await loadProviderDeviceStates(userId, baseDeviceId)
      const selectedProviderRow = selectConnectionSlotState(providerRows, `${baseDeviceId}_slot_0`, baseDeviceId)
      return NextResponse.json({
        ok: true,
        connection_slots: selectedProviderRow?.connection_slots ?? normalizedSlots,
        connection_slots_sync: serializeSyncState(selectedProviderRow),
      })
    }
    return NextResponse.json({ ok: true })
  }

  if (typeof body.isSharing !== 'boolean') {
    return NextResponse.json({ error: 'isSharing must be boolean' }, { status: 400 })
  }
  if (body.isSharing) {
    const providerError = getProviderEligibilityError(await loadProviderEligibilityProfile(userId))
    if (providerError) return NextResponse.json({ error: providerError }, { status: 403 })
  }

  const { data: updatedProfile, error: updateError } = await adminClient
    .from('profiles')
    .update({ is_sharing: body.isSharing, state_actor: stateActor, state_changed_at: stateChangedAt })
    .eq('id', userId)
    .select('is_sharing, state_actor, state_changed_at')
    .single()

  if (updateError || !updatedProfile) {
    return NextResponse.json({ error: updateError?.message ?? 'Could not update sharing state' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    isSharing: updatedProfile.is_sharing,
    profile_sync: serializeSyncState(updatedProfile),
  })
}

// ── PUT: provider heartbeat ───────────────────────────────────────────────────
export async function PUT(req: Request) {
  const body = await req.json().catch(() => ({}))
  const { device_id, user_id } = body
  const stateActor = getRequestStateActor(req)
  const stateChangedAt = new Date().toISOString()

  if (!device_id) {
    return NextResponse.json({ error: 'device_id required' }, { status: 400 })
  }

  let userId = await resolveUserId(req, user_id)

  // Fallback: token expired but body has user_id — verify the user exists before trusting it
  if (!userId && user_id) {
    const { data: profile } = await adminClient
      .from('profiles')
      .select('id')
      .eq('id', user_id)
      .maybeSingle()
    if (profile) userId = user_id
  }

  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const providerError = getProviderEligibilityError(await loadProviderEligibilityProfile(userId))
  if (providerError) return NextResponse.json({ error: providerError }, { status: 403 })

  // Detect country from the request IP
  // x-vercel-ip-country is injected by Vercel for free — no external call needed.
  // When the relay calls this endpoint it passes x-provider-ip (the real provider IP)
  // so we fall back to a geo-lookup only in that case.
  let country = 'XX'
  const providerIp = req.headers.get('x-provider-ip')
  if (providerIp) {
    // Relay-forwarded heartbeat — geo-lookup the real provider IP
    try {
      const geo = await fetch(`https://ipapi.co/${encodeURIComponent(providerIp)}/country/`, { signal: AbortSignal.timeout(3000) })
      if (geo.ok) {
        const countryCode = (await geo.text()).trim().toUpperCase()
        if (/^[A-Z]{2}$/.test(countryCode)) country = countryCode
      }
    } catch {}
  } else {
    // Direct heartbeat from desktop/CLI — Vercel knows the real IP
    const vercelCountry = req.headers.get('x-vercel-ip-country')
    if (vercelCountry && /^[A-Z]{2}$/.test(vercelCountry)) country = vercelCountry
  }

  const { error: rpcError } = await adminClient.rpc('upsert_provider_heartbeat', {
    p_user_id: userId,
    p_device_id: device_id,
    p_country: country,
    p_relay_url: (body.relay_url && typeof body.relay_url === 'string') ? body.relay_url : null,
  })

  // Opportunistically clean up stale devices from other users
  try { await adminClient.rpc('cleanup_stale_providers') } catch {}

  if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 500 })

  const providerUpdate: { state_actor: string; connection_slots?: number } = { state_actor: stateActor }
  const connectionSlots = Number.parseInt(String(body.connection_slots ?? ''), 10)
  if (Number.isInteger(connectionSlots) && connectionSlots >= 1 && connectionSlots <= 32) {
    providerUpdate.connection_slots = connectionSlots
  }

  await adminClient
    .from('provider_devices')
    .update({ ...providerUpdate, state_changed_at: stateChangedAt })
    .eq('user_id', userId)
    .eq('device_id', device_id)

  await adminClient
    .from('profiles')
    .update({ state_actor: stateActor, state_changed_at: stateChangedAt })
    .eq('id', userId)

  return NextResponse.json({ ok: true })
}

// ── DELETE: device stopped sharing ───────────────────────────────────────────
export async function DELETE(req: Request) {
  const body = await req.json().catch(() => ({}))
  const { device_id, user_id } = body
  const stateActor = getRequestStateActor(req)
  const stateChangedAt = new Date().toISOString()

  if (!device_id) return NextResponse.json({ error: 'device_id required' }, { status: 400 })

  const userId = await resolveUserId(req, user_id)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  await adminClient
    .from('provider_devices')
    .update({ state_actor: stateActor, state_changed_at: stateChangedAt })
    .eq('user_id', userId)
    .eq('device_id', device_id)

  await adminClient.rpc('remove_provider_device', {
    p_user_id: userId,
    p_device_id: device_id,
  })

  await adminClient
    .from('profiles')
    .update({ state_actor: stateActor, state_changed_at: stateChangedAt })
    .eq('id', userId)

  // Clean up any other stale devices so is_sharing never stays stale
  try { await adminClient.rpc('cleanup_stale_providers') } catch {}

  return NextResponse.json({ ok: true })
}
