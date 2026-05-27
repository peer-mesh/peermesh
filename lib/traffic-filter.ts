const ALLOWED_PORTS = new Set([80, 443, 8080, 8443])

const BLOCKED_PATTERNS = [
  /torrent/i,
  /\.onion$/,
  /^smtp\./i,
  /^pop3\./i,
  /^imap\./i,
  /phishing/i,
]

// RFC-1918 + loopback + IPv6 private ranges — never allow routing to private ranges
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^(22[4-9]|23\d)\./,
  /^255\.255\.255\.255$/,
  /^::1$/,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe[89ab][0-9a-f]:/i,
  /^::ffff:(127|10|192\.168|172\.(1[6-9]|2\d|3[01])|169\.254|0)\./i,
]

export function isRequestAllowed(host: string, port: number): boolean {
  const normalizedHost = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!ALLOWED_PORTS.has(port)) return false
  if (BLOCKED_PATTERNS.some(p => p.test(normalizedHost))) return false
  if (BLOCKED_HOST_PATTERNS.some(p => p.test(normalizedHost))) return false
  return true
}

export function isUserTrusted(trustScore: number): boolean {
  return trustScore >= 30
}

// Rate limiter: max 100 requests per minute per session
const sessionRequests = new Map<string, { count: number; windowStart: number }>()

export function checkRateLimit(sessionId: string): boolean {
  const now = Date.now()
  const WINDOW = 60_000
  const MAX = 100

  const record = sessionRequests.get(sessionId)
  if (!record) {
    sessionRequests.set(sessionId, { count: 1, windowStart: now })
    return true
  }

  if (now - record.windowStart > WINDOW) {
    record.count = 1
    record.windowStart = now
    return true
  }

  if (record.count >= MAX) return false
  record.count++
  return true
}

export function clearRateLimit(sessionId: string): void {
  sessionRequests.delete(sessionId)
}
