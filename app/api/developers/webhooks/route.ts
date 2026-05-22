import { NextResponse } from 'next/server'
import {
  issueWebhookSecret,
  normalizeWebhookEvents,
  normalizeWebhookUrl,
  serializeWebhook,
} from '@/lib/developer-webhooks'
import { getRequestUser } from '@/lib/request-auth'
import { adminClient } from '@/lib/supabase/admin'

const MAX_WEBHOOKS_PER_ACCOUNT = 10

export async function GET(req: Request) {
  const user = await getRequestUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [{ data: webhooks, error: webhooksError }, { data: deliveries, error: deliveriesError }] = await Promise.all([
    adminClient
      .from('developer_webhooks')
      .select('id, name, url, events, is_active, last_delivery_at, created_at, updated_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false }),
    adminClient
      .from('webhook_deliveries')
      .select('id, webhook_id, event, session_id, status, attempt_count, response_status, error, last_attempt_at, delivered_at, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20),
  ])

  if (webhooksError) return NextResponse.json({ error: webhooksError.message }, { status: 500 })
  if (deliveriesError) return NextResponse.json({ error: deliveriesError.message }, { status: 500 })

  return NextResponse.json({
    webhooks: (webhooks ?? []).map(serializeWebhook),
    deliveries: deliveries ?? [],
  })
}

export async function POST(req: Request) {
  const user = await getRequestUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!user.email_confirmed_at) {
    return NextResponse.json({ error: 'Confirm your email before creating webhooks.' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : 'Webhook endpoint'
  const url = normalizeWebhookUrl(body.url)
  const events = normalizeWebhookEvents(body.events)

  if (!url) return NextResponse.json({ error: 'url must be a valid https:// endpoint' }, { status: 400 })

  const { count, error: countError } = await adminClient
    .from('developer_webhooks')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)

  if (countError) return NextResponse.json({ error: countError.message }, { status: 500 })
  if ((count ?? 0) >= MAX_WEBHOOKS_PER_ACCOUNT) {
    return NextResponse.json({
      error: `Webhook limit reached. Each account can have up to ${MAX_WEBHOOKS_PER_ACCOUNT} webhook endpoints.`,
      code: 'webhook_limit',
      maxWebhooks: MAX_WEBHOOKS_PER_ACCOUNT,
    }, { status: 429 })
  }

  const signingSecret = issueWebhookSecret()
  const { data, error } = await adminClient
    .from('developer_webhooks')
    .insert({
      user_id: user.id,
      name: name || 'Webhook endpoint',
      url,
      events,
      signing_secret: signingSecret,
      is_active: true,
    })
    .select('id, name, url, events, is_active, last_delivery_at, created_at, updated_at')
    .single()

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? 'Could not create webhook' }, { status: 500 })
  }

  return NextResponse.json({
    webhook: serializeWebhook(data),
    signingSecret,
  })
}

export async function PATCH(req: Request) {
  const user = await getRequestUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const id = typeof body.id === 'string' ? body.id.trim() : ''
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.name !== undefined) patch.name = String(body.name || 'Webhook endpoint').trim().slice(0, 80)
  if (body.url !== undefined) {
    const url = normalizeWebhookUrl(body.url)
    if (!url) return NextResponse.json({ error: 'url must be a valid https:// endpoint' }, { status: 400 })
    patch.url = url
  }
  if (body.events !== undefined) patch.events = normalizeWebhookEvents(body.events)
  if (body.isActive !== undefined) patch.is_active = body.isActive === true
  if (body.rotateSecret === true) patch.signing_secret = issueWebhookSecret()

  const { data, error } = await adminClient
    .from('developer_webhooks')
    .update(patch)
    .eq('id', id)
    .eq('user_id', user.id)
    .select('id, name, url, events, is_active, last_delivery_at, created_at, updated_at')
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })

  return NextResponse.json({
    webhook: serializeWebhook(data),
    signingSecret: body.rotateSecret === true ? patch.signing_secret : undefined,
  })
}

export async function DELETE(req: Request) {
  const user = await getRequestUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const id = new URL(req.url).searchParams.get('id')?.trim() ?? ''
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const { error } = await adminClient
    .from('developer_webhooks')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, id })
}
