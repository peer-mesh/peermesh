type Bucket = {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()
let lastPruneAt = 0

function pruneExpiredBuckets(now: number) {
  if (now - lastPruneAt < 60_000) return
  lastPruneAt = now
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
}

export function checkServerRateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterSeconds: number } {
  const now = Date.now()
  pruneExpiredBuckets(now)
  const bucket = buckets.get(key)

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { ok: true, retryAfterSeconds: 0 }
  }

  bucket.count += 1
  if (bucket.count <= limit) return { ok: true, retryAfterSeconds: 0 }

  return {
    ok: false,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  }
}
