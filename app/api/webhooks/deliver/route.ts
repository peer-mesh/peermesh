import { NextResponse } from 'next/server'
import { processDueWebhookDeliveries } from '@/lib/developer-webhooks'

export async function POST(req: Request) {
  const configuredSecret = process.env.WEBHOOK_DELIVERY_SECRET ?? process.env.CRON_SECRET ?? process.env.RELAY_SECRET ?? ''
  if (!configuredSecret) {
    return NextResponse.json({ error: 'WEBHOOK_DELIVERY_SECRET is not configured' }, { status: 503 })
  }

  const provided = req.headers.get('x-webhook-delivery-secret') ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  if (provided !== configuredSecret) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const limit = Number.parseInt(String(body.limit ?? 25), 10)
  const result = await processDueWebhookDeliveries(Number.isInteger(limit) ? limit : 25)
  return NextResponse.json({ ok: true, ...result })
}
