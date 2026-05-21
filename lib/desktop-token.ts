import { createHmac, timingSafeEqual } from 'crypto'

const ACCESS_TOKEN_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000

export type DesktopTokenPayload = {
  sub: string
  sid: string
  typ: 'desktop_access'
  iat: number
  exp: number
}

function getTokenSecret(): string {
  const secret = process.env.SUPABASE_SERVICE_ROLE ?? ''
  if (!secret) {
    throw new Error('SUPABASE_SERVICE_ROLE is not configured')
  }
  return secret
}

function signPayload(payload: string): string {
  return createHmac('sha256', getTokenSecret()).update(payload).digest('base64url')
}

export function getDesktopAccessTokenTtlMs(): number {
  return ACCESS_TOKEN_TTL_MS
}

export function issueDesktopToken(userId: string, sessionId: string): string {
  const now = Date.now()
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    sid: sessionId,
    typ: 'desktop_access',
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_MS,
  } satisfies DesktopTokenPayload)).toString('base64url')

  return `${payload}.${signPayload(payload)}`
}

export function verifyDesktopToken(token: string): DesktopTokenPayload | null {
  try {
    const [payload, signature] = token.split('.')
    if (!payload || !signature) return null

    const expectedSignature = signPayload(payload)
    const actualBuffer = Buffer.from(signature)
    const expectedBuffer = Buffer.from(expectedSignature)
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
      return null
    }

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Partial<DesktopTokenPayload>
    if (
      decoded.typ !== 'desktop_access'
      || typeof decoded.sub !== 'string'
      || typeof decoded.sid !== 'string'
      || typeof decoded.iat !== 'number'
      || typeof decoded.exp !== 'number'
      || decoded.exp <= Date.now()
    ) {
      return null
    }

    return decoded as DesktopTokenPayload
  } catch {
    return null
  }
}
