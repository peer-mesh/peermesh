export type ProviderHealthRow = {
  health_score?: number | null
  provider_avg_mbps?: number | null
  provider_last_mbps?: number | null
  disconnect_count?: number | null
  reconnect_count?: number | null
  last_heartbeat?: string | null
}

export const MIN_PROVIDER_HEALTH_SCORE = 0.25

export function normalizeHealthScore(value: unknown): number {
  const score = Number(value)
  if (!Number.isFinite(score)) return 1
  return Math.max(0, Math.min(1, score))
}

export function providerQualityScore(row: ProviderHealthRow): number {
  const health = normalizeHealthScore(row.health_score)
  const avgMbps = Math.max(0, Number(row.provider_avg_mbps ?? 0) || 0)
  const lastMbps = Math.max(0, Number(row.provider_last_mbps ?? 0) || 0)
  const disconnectPenalty = Math.min(0.35, Math.max(0, Number(row.disconnect_count ?? 0) || 0) * 0.025)
  const speedScore = Math.min(0.25, Math.log10(1 + avgMbps + lastMbps * 0.5) * 0.12)
  const heartbeatTime = row.last_heartbeat ? new Date(row.last_heartbeat).getTime() : NaN
  const heartbeatScore = Number.isFinite(heartbeatTime)
    ? Math.max(0, 0.1 - Math.max(0, Date.now() - heartbeatTime) / 45_000 * 0.1)
    : 0
  return health + speedScore + heartbeatScore - disconnectPenalty
}

export function isProviderHealthy(row: ProviderHealthRow): boolean {
  return normalizeHealthScore(row.health_score) >= MIN_PROVIDER_HEALTH_SCORE
}

export function sortProvidersByHealth<T extends ProviderHealthRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => providerQualityScore(b) - providerQualityScore(a))
}

export function nextProviderHealthScore({
  currentScore,
  disconnectReason,
  avgMbps,
  lastMbps,
}: {
  currentScore?: number | null
  disconnectReason?: string | null
  avgMbps?: number | null
  lastMbps?: number | null
}): number {
  let score = normalizeHealthScore(currentScore)
  const reason = String(disconnectReason || '').toLowerCase()

  if (reason === 'completed' || reason === 'user_disconnected') score += 0.015
  else if (reason.includes('provider')) score -= 0.08
  else if (reason.includes('no_peers')) score -= 0.04
  else if (reason.includes('timeout') || reason.includes('unresponsive')) score -= 0.06

  const avg = Number(avgMbps ?? 0)
  const last = Number(lastMbps ?? 0)
  if (Number.isFinite(avg) && avg >= 2) score += 0.01
  if (Number.isFinite(last) && last > 0 && last < 0.05) score -= 0.015

  return normalizeHealthScore(score)
}
