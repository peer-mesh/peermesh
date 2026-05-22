'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { formatBytes } from '@/lib/utils'

type ProviderSessionRecord = {
  id: string
  target_country: string
  target_host: string | null
  target_hosts: string[]
  status: string
  request_auth_kind: string | null
  provider_last_mbps: number | null
  provider_avg_mbps: number | null
  connection_quality: { currentMbps?: number; avgMbps?: number } | null
  bytes_used: number
  disconnect_reason: string | null
  started_at: string
  ended_at: string | null
}

export default function ProviderSessionsPage() {
  const supabaseRef = useRef(createClient())
  const [sessions, setSessions] = useState<ProviderSessionRecord[]>([])
  const [search, setSearch] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [initialLoading, setInitialLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [reportingId, setReportingId] = useState<string | null>(null)
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const [expandedHosts, setExpandedHosts] = useState<Record<string, boolean>>({})

  const getAccessToken = useCallback(async () => {
    const { data: { session } } = await supabaseRef.current.auth.getSession()
    return session?.access_token ?? null
  }, [])

  const loadSessions = useCallback(async (query: string, mode: 'initial' | 'refresh' = 'refresh') => {
    if (mode === 'initial') setInitialLoading(true)
    else setRefreshing(true)
    setError('')
    try {
      const token = await getAccessToken()
      const params = new URLSearchParams()
      if (query.trim()) params.set('q', query.trim())
      const res = await fetch(`/api/provider/sessions?${params.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not load provider sessions')
      setSessions(data.sessions ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load provider sessions')
    } finally {
      setInitialLoading(false)
      setRefreshing(false)
    }
  }, [getAccessToken])

  async function reportRequester(sessionId: string) {
    const reason = window.prompt('Reason for reporting this requester')
    if (!reason) return
    setReportingId(sessionId)
    setError('')
    try {
      const token = await getAccessToken()
      const res = await fetch('/api/abuse/report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ sessionId, reason, reportSubject: 'requester' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not submit report')
      await loadSessions(appliedSearch)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit report')
    } finally {
      setReportingId(null)
    }
  }

  async function stopSession(sessionId: string) {
    if (!window.confirm('Stop this active requester session now?')) return
    setStoppingId(sessionId)
    setError('')
    try {
      const token = await getAccessToken()
      const res = await fetch('/api/provider/sessions', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ sessionId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not stop provider session')
      await loadSessions(appliedSearch)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not stop provider session')
    } finally {
      setStoppingId(null)
    }
  }

  function applySearch() {
    const next = search.trim()
    setAppliedSearch(next)
    void loadSessions(next)
  }

  useEffect(() => {
    void loadSessions('', 'initial')
  }, [loadSessions])

  useEffect(() => {
    if (appliedSearch) return
    const timer = window.setInterval(() => {
      void loadSessions('', 'refresh')
    }, 30000)
    return () => window.clearInterval(timer)
  }, [appliedSearch, loadSessions])

  const totalBytes = useMemo(() => sessions.reduce((sum, session) => sum + Number(session.bytes_used ?? 0), 0), [sessions])
  const activeCount = sessions.filter(session => session.status === 'active' || !session.ended_at).length

  return (
    <main style={{ width: '100%', maxWidth: '1100px', margin: '0 auto', padding: '32px 20px 64px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: '24px' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', letterSpacing: '2px', marginBottom: '8px' }}>
            PROVIDER TRAFFIC
          </div>
          <h1 style={{ margin: 0, fontSize: '30px', lineHeight: 1.15 }}>Inspect routed host history</h1>
          <p style={{ margin: '10px 0 0', color: 'var(--muted)', fontSize: '13px', lineHeight: 1.7, maxWidth: '620px' }}>
            Search the hosts routed through your provider sessions. Use this to audit traffic, inspect active routes, and report suspicious requesters.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', fontFamily: 'var(--font-geist-mono)', fontSize: '11px' }}>
          <Link href="/dashboard" style={{ padding: '9px 12px', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', textDecoration: 'none' }}>DASHBOARD</Link>
          <Link href="/developers/api-docs" style={{ padding: '9px 12px', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', textDecoration: 'none' }}>API DOCS</Link>
        </div>
      </div>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px', marginBottom: '16px' }}>
        {[
          ['Sessions', String(sessions.length)],
          ['Active', String(activeCount)],
          ['Traffic', formatBytes(totalBytes)],
          ['Filter', appliedSearch || 'All hosts'],
        ].map(([label, value]) => (
          <div key={label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', padding: '12px' }}>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', letterSpacing: '1px', marginBottom: '6px' }}>{label.toUpperCase()}</div>
            <div style={{ fontSize: '16px', fontWeight: 700 }}>{value}</div>
          </div>
        ))}
      </section>

      <section style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', padding: '16px', display: 'grid', gap: '14px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '8px' }}>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') applySearch() }}
            placeholder="Search routed host, for example example.com"
            style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', boxSizing: 'border-box' }}
          />
          <button onClick={applySearch} style={{ padding: '0 14px', borderRadius: '8px', border: 'none', background: 'var(--accent)', color: '#000', fontFamily: 'var(--font-geist-mono)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>SEARCH</button>
          <button onClick={() => { setSearch(''); setAppliedSearch(''); void loadSessions('') }} style={{ padding: '0 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font-geist-mono)', fontSize: '11px', cursor: 'pointer' }}>RESET</button>
        </div>

        {error ? <div style={{ color: '#ff8080', fontSize: '13px' }}>{error}</div> : null}
        {refreshing && !initialLoading ? <div style={{ color: 'var(--muted)', fontFamily: 'var(--font-geist-mono)', fontSize: '10px' }}>REFRESHING IN BACKGROUND</div> : null}
        {initialLoading ? <div style={{ color: 'var(--muted)', fontFamily: 'var(--font-geist-mono)', fontSize: '11px' }}>LOADING...</div> : null}
        {!initialLoading && sessions.length === 0 ? <div style={{ color: 'var(--muted)', fontSize: '13px' }}>No routed traffic matched this host search.</div> : null}

        <div style={{ display: 'grid', gap: '10px' }}>
          {sessions.map((session) => {
            const hosts = session.target_hosts.length > 0 ? session.target_hosts : [session.target_host].filter(Boolean) as string[]
            const expanded = expandedHosts[session.id] === true
            const visibleHosts = expanded ? hosts : hosts.slice(0, 5)

            return (
              <article key={session.id} style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '14px', background: 'var(--bg)', display: 'grid', gap: '12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '13px', color: 'var(--accent)' }}>{session.target_host ?? hosts[0] ?? 'Host pending'}</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '4px' }}>{session.target_country} - {session.status.toUpperCase()} - {session.id.slice(0, 8)}</div>
                  </div>
                  <button
                    onClick={() => void reportRequester(session.id)}
                    disabled={reportingId === session.id}
                    style={{ padding: '8px 10px', borderRadius: '8px', border: '1px solid rgba(255,96,96,0.35)', background: 'rgba(255,96,96,0.08)', color: '#ff8080', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: reportingId === session.id ? 'not-allowed' : 'pointer' }}
                  >
                    {reportingId === session.id ? 'REPORTING...' : 'REPORT REQUESTER'}
                  </button>
                  {session.status === 'active' || session.status === 'reconnecting' ? (
                    <button
                      onClick={() => void stopSession(session.id)}
                      disabled={stoppingId === session.id}
                      style={{ padding: '8px 10px', borderRadius: '8px', border: '1px solid rgba(255,96,96,0.45)', background: 'rgba(255,96,96,0.14)', color: '#ffb0b0', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: stoppingId === session.id ? 'not-allowed' : 'pointer' }}
                    >
                      {stoppingId === session.id ? 'STOPPING...' : 'STOP SESSION'}
                    </button>
                  ) : null}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px', fontSize: '12px', color: 'var(--muted)' }}>
                  <div>Traffic: <strong style={{ color: 'var(--text)' }}>{formatBytes(Number(session.bytes_used ?? 0))}</strong></div>
                  <div>Requester: <strong style={{ color: 'var(--text)' }}>{(session.request_auth_kind ?? 'user').toUpperCase()}</strong></div>
                  <div>Speed: <strong style={{ color: 'var(--text)' }}>{Number(session.provider_last_mbps ?? session.connection_quality?.currentMbps ?? 0).toFixed(2)} Mbps</strong></div>
                  <div>Avg: <strong style={{ color: 'var(--text)' }}>{Number(session.provider_avg_mbps ?? session.connection_quality?.avgMbps ?? 0).toFixed(2)} Mbps</strong></div>
                  <div>Started: <strong style={{ color: 'var(--text)' }}>{new Date(session.started_at).toLocaleString()}</strong></div>
                  <div>Ended: <strong style={{ color: 'var(--text)' }}>{session.ended_at ? new Date(session.ended_at).toLocaleString() : 'Active'}</strong></div>
                  <div>Disconnect: <strong style={{ color: 'var(--text)' }}>{session.disconnect_reason ?? '-'}</strong></div>
                </div>

                {hosts.length > 0 ? (
                  <div style={{ display: 'grid', gap: '8px' }}>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      {visibleHosts.map(host => (
                        <button
                          key={host}
                          onClick={() => { setSearch(host); setAppliedSearch(host); void loadSessions(host) }}
                          style={{ padding: '5px 8px', border: '1px solid var(--border)', borderRadius: '999px', background: 'var(--surface)', color: 'var(--text)', fontSize: '11px', cursor: 'pointer' }}
                        >
                          {host}
                        </button>
                      ))}
                    </div>
                    {hosts.length > 5 ? (
                      <button onClick={() => setExpandedHosts((current) => ({ ...current, [session.id]: !current[session.id] }))} style={{ justifySelf: 'flex-start', padding: '7px 9px', borderRadius: '7px', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: 'pointer' }}>
                        {expanded ? 'SHOW FEWER HOSTS' : `SHOW ${hosts.length - 5} MORE HOSTS`}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </article>
            )
          })}
        </div>
      </section>
    </main>
  )
}
