import { createHmac, randomBytes } from 'crypto'
import { adminClient } from '@/lib/supabase/admin'

export const WEBHOOK_EVENTS = [
  'session.created',
  'session.active',
  'session.reconnecting',
  'session.ended',
] as const

export type WebhookEvent = typeof WEBHOOK_EVENTS[number]

const EVENT_SET = new Set<string>(WEBHOOK_EVENTS)
const MAX_ATTEMPTS = 5
const RETRY_DELAYS_SECONDS = [60, 300, 900, 3600]

type WebhookRow = {
  id: string
  user_id: string
  name: string
  url: string
  signing_secret: string
  events: string[]
  is_active: boolean
}

type DeliveryRow = {
  id: string
  webhook_id: string
  user_id: string
  event: WebhookEvent
  session_id: string | null
  payload: unknown
  attempt_count: number
}

export function isWebhookEvent(value: unknown): value is WebhookEvent {
  return typeof value === 'string' && EVENT_SET.has(value)
}

export function normalizeWebhookEvents(value: unknown): WebhookEvent[] {
  if (!Array.isArray(value)) return [...WEBHOOK_EVENTS]
  const events = [...new Set(value.filter(isWebhookEvent))]
  return events.length > 0 ? events : [...WEBHOOK_EVENTS]
}

export function issueWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`
}

export function normalizeWebhookUrl(value: unknown): string {
  const url = typeof value === 'string' ? value.trim() : ''
  if (!url) return ''
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return ''
    return parsed.toString()
  } catch {
    return ''
  }
}

function signWebhookBody(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

function nextRetryAt(attemptCount: number): string | null {
  if (attemptCount >= MAX_ATTEMPTS) return null
  const delaySeconds = RETRY_DELAYS_SECONDS[Math.max(0, attemptCount - 1)] ?? RETRY_DELAYS_SECONDS.at(-1) ?? 3600
  return new Date(Date.now() + delaySeconds * 1000).toISOString()
}

export function serializeWebhook(row: {
  id: string
  name: string
  url: string
  events: string[]
  is_active: boolean
  last_delivery_at: string | null
  created_at: string
  updated_at?: string | null
}) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: normalizeWebhookEvents(row.events),
    is_active: row.is_active === true,
    last_delivery_at: row.last_delivery_at,
    created_at: row.created_at,
    updated_at: row.updated_at ?? null,
  }
}

export function buildSessionWebhookPayload(input: {
  event: WebhookEvent
  session: Record<string, unknown>
}) {
  return {
    id: `evt_${randomBytes(16).toString('base64url')}`,
    event: input.event,
    createdAt: new Date().toISOString(),
    data: {
      session: input.session,
    },
  }
}

export async function enqueueWebhookEvent(input: {
  userId: string | null | undefined
  event: WebhookEvent
  sessionId?: string | null
  payload: unknown
}) {
  if (!input.userId) return

  const { data: webhooks, error: webhookError } = await adminClient
    .from('developer_webhooks')
    .select('id')
    .eq('user_id', input.userId)
    .eq('is_active', true)
    .contains('events', [input.event])

  if (webhookError || !webhooks || webhooks.length === 0) return

  const { data: deliveries, error: deliveryError } = await adminClient
    .from('webhook_deliveries')
    .insert(webhooks.map(row => ({
      webhook_id: row.id,
      user_id: input.userId,
      event: input.event,
      session_id: input.sessionId ?? null,
      payload: input.payload,
      status: 'pending',
      next_attempt_at: new Date().toISOString(),
    })))
    .select('id')

  if (deliveryError || !deliveries) return

  await Promise.all(deliveries.map(row => deliverWebhookDelivery(row.id).catch(() => null)))
}

export async function deliverWebhookDelivery(deliveryId: string): Promise<boolean> {
  const { data, error } = await adminClient
    .from('webhook_deliveries')
    .select('id, webhook_id, user_id, event, session_id, payload, attempt_count')
    .eq('id', deliveryId)
    .maybeSingle<DeliveryRow>()

  if (error || !data) return false

  const { data: webhook, error: webhookError } = await adminClient
    .from('developer_webhooks')
    .select('id, user_id, name, url, signing_secret, events, is_active')
    .eq('id', data.webhook_id)
    .eq('user_id', data.user_id)
    .maybeSingle<WebhookRow>()

  if (webhookError || !webhook || webhook.is_active !== true) return false

  const nextAttemptCount = Number(data.attempt_count ?? 0) + 1
  const timestamp = Math.floor(Date.now() / 1000)
  const body = JSON.stringify(data.payload)
  const signature = signWebhookBody(webhook.signing_secret, timestamp, body)
  const nowIso = new Date().toISOString()

  try {
    const res = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'PeerMesh-Webhooks/1.0',
        'X-PeerMesh-Event': data.event,
        'X-PeerMesh-Delivery': data.id,
        'X-PeerMesh-Timestamp': String(timestamp),
        'X-PeerMesh-Signature': `t=${timestamp},v1=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    })

    const responseBody = (await res.text().catch(() => '')).slice(0, 2000)
    if (res.ok) {
      await Promise.all([
        adminClient
          .from('webhook_deliveries')
          .update({
            status: 'delivered',
            attempt_count: nextAttemptCount,
            response_status: res.status,
            response_body: responseBody,
            error: null,
            last_attempt_at: nowIso,
            delivered_at: nowIso,
            updated_at: nowIso,
          })
          .eq('id', data.id),
        adminClient
          .from('developer_webhooks')
          .update({ last_delivery_at: nowIso, updated_at: nowIso })
          .eq('id', webhook.id),
      ])
      return true
    }

    const retryAt = nextRetryAt(nextAttemptCount)
    await adminClient
      .from('webhook_deliveries')
      .update({
        status: retryAt ? 'failed' : 'abandoned',
        attempt_count: nextAttemptCount,
        next_attempt_at: retryAt ?? nowIso,
        response_status: res.status,
        response_body: responseBody,
        error: `HTTP ${res.status}`,
        last_attempt_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', data.id)
    return false
  } catch (err) {
    const retryAt = nextRetryAt(nextAttemptCount)
    await adminClient
      .from('webhook_deliveries')
      .update({
        status: retryAt ? 'failed' : 'abandoned',
        attempt_count: nextAttemptCount,
        next_attempt_at: retryAt ?? nowIso,
        error: err instanceof Error ? err.message : 'Delivery failed',
        last_attempt_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', data.id)
    return false
  }
}

export async function processDueWebhookDeliveries(limit = 25): Promise<{ processed: number; delivered: number }> {
  const { data } = await adminClient
    .from('webhook_deliveries')
    .select('id')
    .in('status', ['pending', 'failed'])
    .lte('next_attempt_at', new Date().toISOString())
    .lt('attempt_count', MAX_ATTEMPTS)
    .order('next_attempt_at', { ascending: true })
    .limit(Math.max(1, Math.min(100, limit)))

  const rows = data ?? []
  let delivered = 0
  for (const row of rows) {
    if (await deliverWebhookDelivery(row.id).catch(() => false)) delivered += 1
  }
  return { processed: rows.length, delivered }
}
