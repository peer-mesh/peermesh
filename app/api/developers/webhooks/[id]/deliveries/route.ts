import { NextResponse } from 'next/server'
import { getRequestUser } from '@/lib/request-auth'
import { adminClient } from '@/lib/supabase/admin'

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getRequestUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await context.params
  const webhookId = typeof id === 'string' ? id.trim() : ''
  if (!webhookId) return NextResponse.json({ error: 'webhook id is required' }, { status: 400 })

  const { data: webhook, error: webhookError } = await adminClient
    .from('developer_webhooks')
    .select('id')
    .eq('id', webhookId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (webhookError) return NextResponse.json({ error: webhookError.message }, { status: 500 })
  if (!webhook) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })

  const { data, error } = await adminClient
    .from('webhook_deliveries')
    .select('id, webhook_id, event, session_id, payload, status, attempt_count, next_attempt_at, response_status, response_body, error, last_attempt_at, delivered_at, created_at')
    .eq('webhook_id', webhookId)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ deliveries: data ?? [] })
}
