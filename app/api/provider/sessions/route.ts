import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { getRequestUser } from '@/lib/request-auth'

export async function GET(req: Request) {
  const user = await getRequestUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') ?? '').trim().toLowerCase()
  const limit = Math.min(500, Math.max(1, Number.parseInt(searchParams.get('limit') ?? (q ? '500' : '100'), 10) || 100))

  const { data: sessions, error } = await adminClient
    .from('sessions')
    .select('id, provider_id, provider_kind, provider_device_id, provider_base_device_id, target_country, target_host, target_hosts, relay_endpoint, status, bytes_used, disconnect_reason, started_at, ended_at')
    .eq('provider_id', user.id)
    .order('started_at', { ascending: false })
    .limit(limit)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const filteredSessions = q
    ? (sessions ?? []).filter((session) => {
        const hosts = [session.target_host, ...((session.target_hosts ?? []) as string[])]
          .filter(Boolean)
          .map((host) => String(host).toLowerCase())
        return hosts
          .filter(Boolean)
          .some((host) => host.includes(q))
      })
    : (sessions ?? [])

  return NextResponse.json({
    sessions: filteredSessions.map((session) => ({
      ...session,
      target_hosts: [...new Set([...(session.target_hosts ?? []), session.target_host].filter(Boolean))],
    })),
  })
}
