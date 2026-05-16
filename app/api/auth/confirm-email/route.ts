import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE!

function json(body: object, status = 200) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

// Called after client-side verifyOtp succeeds — marks email_confirm: true via admin REST
export async function POST(req: Request) {
  const { searchParams } = new URL(req.url)
  const email = searchParams.get('email')?.trim().toLowerCase()
  if (!email) return json({ error: 'email required' }, 400)

  // Look up user by email via Supabase admin REST API
  const listRes = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
    { headers: { 'apikey': SERVICE_ROLE, 'Authorization': `Bearer ${SERVICE_ROLE}` } }
  )
  if (!listRes.ok) return json({ error: 'Could not find user' }, 500)

  const listData = await listRes.json()
  const user = listData?.users?.[0]
  if (!user?.id) return json({ error: 'User not found' }, 404)

  // Mark email confirmed
  const updateRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SERVICE_ROLE,
      'Authorization': `Bearer ${SERVICE_ROLE}`,
    },
    body: JSON.stringify({ email_confirm: true }),
  })

  if (!updateRes.ok) {
    const err = await updateRes.json().catch(() => ({}))
    console.error('[confirm-email] admin update failed', updateRes.status, err)
    return json({ error: 'Could not confirm email' }, 500)
  }

  return json({ success: true })
}
