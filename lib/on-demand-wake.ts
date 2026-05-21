export const ON_DEMAND_WAKE_BUCKET_MS = 5 * 60 * 1000
export const ON_DEMAND_WAKE_EXPIRES_MS = 15 * 60 * 1000

export type OnDemandWakeAction = 'wake' | 'start'

export type OnDemandWakeJobRow = {
  user_id: string
  base_device_id: string
  action: OnDemandWakeAction
  scheduled_for: string
  expires_at: string
  idempotency_key: string
  window_key: string
  payload: {
    reason: 'on_demand_private_wake'
    requesterUserId: string
    requestedAt: string
    source: string
  }
}

export function normalizeProviderBaseDeviceId(deviceKey: string): string {
  const match = /^(.*)_slot_\d+$/.exec(String(deviceKey ?? '').trim())
  return match?.[1] ?? String(deviceKey ?? '').trim()
}

export function getOnDemandWakeBucket(now = new Date(), bucketMs = ON_DEMAND_WAKE_BUCKET_MS): number {
  const parsedBucketMs = Number.isFinite(bucketMs) ? Math.trunc(bucketMs) : ON_DEMAND_WAKE_BUCKET_MS
  const safeBucketMs = Math.max(60_000, parsedBucketMs)
  return Math.floor(now.getTime() / safeBucketMs)
}

export function buildOnDemandWakeJobRows(input: {
  providerUserId: string
  baseDeviceId: string
  requesterUserId: string
  now?: Date
  source?: string
}): OnDemandWakeJobRow[] {
  const now = input.now ?? new Date()
  const requestedAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + ON_DEMAND_WAKE_EXPIRES_MS).toISOString()
  const baseDeviceId = normalizeProviderBaseDeviceId(input.baseDeviceId)
  const source = input.source?.trim() || 'api'
  const bucket = getOnDemandWakeBucket(now)
  const keyBase = `${input.providerUserId}:${baseDeviceId}:${input.requesterUserId}:on-demand:${bucket}`
  const windowKey = `on-demand:${bucket}`

  return (['wake', 'start'] as const).map((action) => ({
    user_id: input.providerUserId,
    base_device_id: baseDeviceId,
    action,
    scheduled_for: requestedAt,
    expires_at: expiresAt,
    idempotency_key: `${keyBase}:${action}`,
    window_key: windowKey,
    payload: {
      reason: 'on_demand_private_wake',
      requesterUserId: input.requesterUserId,
      requestedAt,
      source,
    },
  }))
}
