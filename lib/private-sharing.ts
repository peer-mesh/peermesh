import { randomInt } from 'crypto'

export const PRIVATE_SHARE_CODE_REGEX = /^\d{9}$/
export const PRIVATE_SHARE_MAX_EXPIRY_HOURS = 24 * 30

export function normalizePrivateShareCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const code = value.trim()
  return PRIVATE_SHARE_CODE_REGEX.test(code) ? code : null
}

export function generatePrivateShareCode(): string {
  return String(randomInt(0, 1_000_000_000)).padStart(9, '0')
}

export function parsePrivateShareExpiryHours(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  const hours = Number.parseInt(String(value), 10)
  if (!Number.isInteger(hours) || hours < 1 || hours > PRIVATE_SHARE_MAX_EXPIRY_HOURS) return undefined
  return hours
}

export function buildPrivateShareExpiry(hours: number | null): string | null {
  if (hours == null) return null
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
}

export function isPrivateShareActive(
  enabled?: boolean | null,
  expiresAt?: string | null,
  now = Date.now()
): boolean {
  if (!enabled) return false
  if (!expiresAt) return true
  const ts = new Date(expiresAt).getTime()
  return Number.isFinite(ts) && ts > now
}

export function shouldDeleteStalePrivateShareSlot(
  enabled?: boolean | null,
  expiresAt?: string | null,
  now = Date.now()
): boolean {
  return !isPrivateShareActive(enabled, expiresAt, now)
}
