import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase/admin'
import { detectCountryCodeFromRequest } from '@/lib/ip-country'

export const revalidate = 300 // cache 5 min at CDN edge

export async function GET(req: Request) {
  const url = new URL(req.url)
  const page   = Math.max(1, parseInt(url.searchParams.get('page')  ?? '1', 10))
  const limit  = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10)))
  const region = url.searchParams.get('region') ?? null
  const search = url.searchParams.get('q')?.trim() ?? null
  const offset = (page - 1) * limit

  let query = adminClient
    .from('countries')
    .select('code, name, flag, region, sort_order', { count: 'exact' })
    .eq('active', true)
    .order('sort_order', { ascending: true })
    .order('name',       { ascending: true })
    .range(offset, offset + limit - 1)

  if (region) query = query.eq('region', region)
  if (search) query = query.ilike('name', `%${search}%`)

  const { data, error, count } = await query

  if (error) {
    return new NextResponse(JSON.stringify({ error: 'Could not load countries' }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    })
  }

  const ipCountry = await detectCountryCodeFromRequest(req)

  return new NextResponse(JSON.stringify({
    countries: data ?? [],
    total: count ?? 0,
    page,
    limit,
    pages: Math.ceil((count ?? 0) / limit),
    detectedCountry: ipCountry,
  }), { 
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  })
}
