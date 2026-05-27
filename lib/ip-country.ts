import { isIP } from 'net'

const COUNTRY_CACHE_TTL_MS = 1000 * 60 * 30
const IP_API_TIMEOUT_MS = 3000
const UNKNOWN_COUNTRY = 'XX'
const countryCache = new Map<string, { country: string | null; timestamp: number }>()

function ipv4ToInt(value: string): number | null {
  const parts = value.split('.').map(part => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
}

function isPrivateIpv4(value: string): boolean {
  const ip = ipv4ToInt(value)
  if (ip === null) return false
  const ranges: Array<[string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ]
  return ranges.some(([base, bits]) => {
    const baseInt = ipv4ToInt(base)
    if (baseInt === null) return false
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return (ip & mask) === (baseInt & mask)
  }) || value === '255.255.255.255'
}

export function normalizeCountryCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const country = value.trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(country) || country === UNKNOWN_COUNTRY) return null
  return country
}

export function normalizeIpAddress(value: unknown): string {
  if (typeof value !== 'string') return ''
  let ip = value.trim()
  if (!ip) return ''

  ip = ip.replace(/^"|"$/g, '')
  if (ip.startsWith('[')) {
    const bracketEnd = ip.indexOf(']')
    if (bracketEnd > 0) ip = ip.slice(1, bracketEnd)
  } else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) {
    ip = ip.slice(0, ip.lastIndexOf(':'))
  }

  if (ip.startsWith('::ffff:')) ip = ip.slice(7)
  const zoneIndex = ip.indexOf('%')
  if (zoneIndex > -1) ip = ip.slice(0, zoneIndex)
  return ip
}

export function isPrivateIpAddress(value: string): boolean {
  const ip = normalizeIpAddress(value)
  const kind = isIP(ip)
  if (kind === 4) return isPrivateIpv4(ip)
  if (kind === 6) {
    const lower = ip.toLowerCase()
    return lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb') ||
      /^::ffff:(127|10|192\.168|172\.(1[6-9]|2\d|3[01])|169\.254|0)\./i.test(lower)
  }
  return false
}

function parseIpToken(value: string): string {
  let token = value.trim()
  if (!token) return ''
  if (token.toLowerCase().startsWith('for=')) token = token.slice(4)
  token = token.split(';')[0]?.trim() ?? ''
  return normalizeIpAddress(token)
}

export function getRequestIpCandidates(req: Request, explicitIp?: string | null): string[] {
  const candidates: string[] = []
  const add = (value: string | null | undefined) => {
    if (!value) return
    for (const part of value.split(',')) {
      const ip = parseIpToken(part)
      if (ip && isIP(ip)) candidates.push(ip)
    }
  }

  add(explicitIp ?? null)
  add(req.headers.get('cf-connecting-ip'))
  add(req.headers.get('true-client-ip'))
  add(req.headers.get('x-real-ip'))
  add(req.headers.get('x-client-ip'))
  add(req.headers.get('x-forwarded-for'))

  const forwarded = req.headers.get('forwarded')
  if (forwarded) {
    for (const segment of forwarded.split(',')) {
      const match = /(?:^|;)\s*for=([^;]+)/i.exec(segment)
      if (match) add(match[1])
    }
  }

  return [...new Set(candidates)]
}

export function getBestRequestIp(req: Request, explicitIp?: string | null): string {
  const candidates = getRequestIpCandidates(req, explicitIp)
  return candidates.find(ip => !isPrivateIpAddress(ip)) ?? candidates[0] ?? ''
}

export async function lookupCountryCodeByIp(ip: string, timeoutMs = IP_API_TIMEOUT_MS): Promise<string | null> {
  const normalizedIp = normalizeIpAddress(ip)
  const queryIp = normalizedIp && isIP(normalizedIp) && !isPrivateIpAddress(normalizedIp) ? normalizedIp : ''
  const cacheKey = queryIp || '__server__'
  const cached = countryCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < COUNTRY_CACHE_TTL_MS) return cached.country

  try {
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(queryIp)}?fields=status,message,countryCode,query`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    })
    if (!res.ok) return null
    const raw = await res.json().catch(() => null) as { status?: string; countryCode?: string } | null
    if (raw?.status !== 'success') return null
    const country = normalizeCountryCode(raw.countryCode)
    if (country) countryCache.set(cacheKey, { country, timestamp: Date.now() })
    return country
  } catch {
    return null
  }
}

export async function detectCountryCodeFromRequest(
  req: Request,
  options: { explicitIp?: string | null; timeoutMs?: number } = {},
): Promise<string | null> {
  const headerCountry =
    normalizeCountryCode(req.headers.get('x-vercel-ip-country')) ??
    normalizeCountryCode(req.headers.get('cf-ipcountry')) ??
    normalizeCountryCode(req.headers.get('x-country-code'))

  if (headerCountry) return headerCountry

  const ip = getBestRequestIp(req, options.explicitIp)
  return lookupCountryCodeByIp(ip, options.timeoutMs)
}
