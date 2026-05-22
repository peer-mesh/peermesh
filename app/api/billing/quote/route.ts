import { NextResponse } from 'next/server'
import { quoteApiUsage } from '@/lib/billing'
import { adminClient } from '@/lib/supabase/admin'
import { getRequestUser } from '@/lib/request-auth'

export async function POST(req: Request) {
  const user = await getRequestUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  if (!['standard', 'advanced', 'enterprise', 'contributor'].includes(body.tier)) {
    return NextResponse.json({ error: 'tier is required and must be standard, advanced, enterprise, or contributor' }, { status: 400 })
  }
  const quote = quoteApiUsage({
    bandwidthGb: Number(body.bandwidthGb ?? 1),
    rpm: Number(body.rpm ?? 60),
    periodHours: Number(body.periodHours ?? 1),
    sessionMode: body.sessionMode === 'sticky' ? 'sticky' : 'rotating',
    tier: body.tier,
  })

  const { data: profile } = await adminClient
    .from('profiles')
    .select('is_verified, role, wallet_balance_usd, contribution_credits_bytes')
    .eq('id', user.id)
    .single()

  return NextResponse.json({
    quote,
    account: {
      is_verified: profile?.is_verified ?? false,
      role: profile?.role ?? 'client',
      wallet_balance_usd: Number(profile?.wallet_balance_usd ?? 0),
      contribution_credits_bytes: Number(profile?.contribution_credits_bytes ?? 0),
    },
  })
}
