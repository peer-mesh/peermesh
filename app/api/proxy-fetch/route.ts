import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit, isRequestAllowed } from '@/lib/traffic-filter'
import { adminClient } from '@/lib/supabase/admin'
import { getConnectionAccessRequirement } from '@/lib/account-access'

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.179 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Cache-Control': 'no-cache',
}

const FORBIDDEN_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'proxy-authorization',
  'proxy-connection',
  'transfer-encoding',
  'cookie',
  'origin',
  'referer',
])

function getPort(url: URL): number {
  return url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80)
}

function sanitizeRequestHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(headers ?? {})) {
    const key = rawKey.trim().toLowerCase()
    if (!key || FORBIDDEN_REQUEST_HEADERS.has(key) || key.startsWith('sec-')) continue
    if (rawValue == null) continue
    out[key] = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue)
  }
  return out
}

function validateTarget(url: URL): boolean {
  return ['http:', 'https:'].includes(url.protocol) && isRequestAllowed(url.hostname, getPort(url))
}

// Fetch a sub-resource and return its text, or null on failure
async function fetchSubResource(url: string): Promise<string | null> {
  try {
    const parsed = new URL(url)
    if (!validateTarget(parsed)) return null
    const res = await fetch(url, { headers: FETCH_HEADERS, redirect: 'manual' })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

// Inline relative <script src> and <link rel="stylesheet" href> tags
async function inlineRelativeAssets(html: string, baseUrl: string): Promise<string> {
  const base = new URL(baseUrl)

  // Inline relative script tags
  const scriptRegex = /<script([^>]*)\ssrc="((?!https?:|\/\/|data:)([^"]+))"([^>]*)><\/script>/gi
  const scriptMatches = [...html.matchAll(scriptRegex)]
  for (const match of scriptMatches) {
    const [full, pre, path, , post] = match
    try {
      const absUrl = new URL(path, base).href
      const content = await fetchSubResource(absUrl)
      if (content) {
        html = html.replace(full, `<script${pre}${post}>${content}</script>`)
      }
    } catch {}
  }

  // Inline relative stylesheet link tags
  const cssRegex = /<link([^>]*)\shref="((?!https?:|\/\/|data:)([^"]+))"([^>]*rel=["']stylesheet["'][^>]*)>/gi
  const cssMatches = [...html.matchAll(cssRegex)]
  for (const match of cssMatches) {
    const [full, , path] = match
    try {
      const absUrl = new URL(path, base).href
      const content = await fetchSubResource(absUrl)
      if (content) {
        html = html.replace(full, `<style>${content}</style>`)
      }
    } catch {}
  }

  // Also inline stylesheet links with href before rel
  const cssRegex2 = /<link([^>]*rel=["']stylesheet["'][^>]*)\shref="((?!https?:|\/\/|data:)([^"]+))"([^>]*)>/gi
  const cssMatches2 = [...html.matchAll(cssRegex2)]
  for (const match of cssMatches2) {
    const [full, , path] = match
    try {
      const absUrl = new URL(path, base).href
      const content = await fetchSubResource(absUrl)
      if (content) {
        html = html.replace(full, `<style>${content}</style>`)
      }
    } catch {}
  }

  return html
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  let authed = !!user
  let userId = user?.id ?? null
  if (!authed) {
    const auth = req.headers.get('authorization')
    if (auth?.startsWith('Bearer ')) {
      const { data } = await supabase.auth.getUser(auth.slice(7))
      authed = !!data.user
      userId = data.user?.id ?? null
    }
  }
  if (!authed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { url, method = 'GET', headers: reqHeaders = {}, body = null, sessionId = null } = await req.json()
  if (!url) return NextResponse.json({ error: 'url required' }, { status: 400 })
  if (!sessionId || typeof sessionId !== 'string') {
    return NextResponse.json({ error: 'An active PeerMesh session is required for browser fetches.' }, { status: 403 })
  }
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: session } = await adminClient
    .from('sessions')
    .select('id, user_id, status, request_access_mode')
    .eq('id', sessionId)
    .maybeSingle()

  if (!session || session.user_id !== userId || !['pending', 'active'].includes(session.status)) {
    return NextResponse.json({ error: 'PeerMesh session is not active. Reconnect from the dashboard.' }, { status: 403 })
  }

  if (session.request_access_mode !== 'private') {
    const { data: profile } = await adminClient
      .from('profiles')
      .select('role, is_verified, is_sharing, is_premium, wallet_balance_usd, contribution_credits_bytes')
      .eq('id', userId)
      .maybeSingle()
    const access = getConnectionAccessRequirement(profile, { mode: 'public' })
    if (!access.ok) {
      return NextResponse.json({ error: access.error, code: access.code, nextStep: access.nextStep }, { status: 403 })
    }
  }

  if (sessionId && !checkRateLimit(sessionId)) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }

  let parsed: URL
  try { parsed = new URL(url) } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return NextResponse.json({ error: 'Protocol not allowed' }, { status: 403 })
  }
  if (!isRequestAllowed(parsed.hostname, getPort(parsed))) {
    return NextResponse.json({ error: 'Host not allowed' }, { status: 403 })
  }

  try {
    const res = await fetch(url, {
      method,
      headers: { ...FETCH_HEADERS, ...sanitizeRequestHeaders(reqHeaders) },
      body: body ?? undefined,
      redirect: 'manual',
    })

    let responseBody = await res.text()
    const contentType = res.headers.get('content-type') ?? ''

    // For HTML responses, inline relative scripts and stylesheets
    if (contentType.includes('text/html')) {
      responseBody = await inlineRelativeAssets(responseBody, res.url)
    }

    const responseHeaders: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      if (!['content-encoding', 'transfer-encoding', 'connection'].includes(k)) {
        responseHeaders[k] = v
      }
    })

    return NextResponse.json({
      status: res.status,
      headers: responseHeaders,
      body: responseBody,
      finalUrl: res.url,
    })
  } catch (err: unknown) {
    return NextResponse.json({
      error: err instanceof Error ? err.message : 'Fetch failed',
      status: 502,
    }, { status: 502 })
  }
}
