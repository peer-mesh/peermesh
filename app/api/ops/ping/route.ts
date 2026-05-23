import { NextResponse } from 'next/server'

// Lightweight keep-alive endpoint — no auth, no DB queries.
// Used by Render free tier cron pings to prevent instance sleep.
export async function GET() {
  return NextResponse.json({ ok: true, ts: Date.now() })
}
