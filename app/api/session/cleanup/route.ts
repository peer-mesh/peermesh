import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'

const RELAY_SECRET = process.env.RELAY_SECRET ?? ''

// Called by the relay scheduler tick to clean up stuck sessions periodically.
// Also callable directly by internal tooling.
export async function POST(req: Request) {
  const secret = req.headers.get('x-relay-secret') ?? ''
  if (RELAY_SECRET && secret !== RELAY_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { error, count } = await adminClient.rpc('cleanup_stale_sessions')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, cleaned: count ?? 0 })
}
