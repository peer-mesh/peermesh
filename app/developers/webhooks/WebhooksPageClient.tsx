'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

const EVENTS = ['session.created', 'session.active', 'session.reconnecting', 'session.ended'] as const

type WebhookRecord = {
  id: string
  name: string
  url: string
  events: string[]
  is_active: boolean
  last_delivery_at: string | null
  created_at: string
}

type DeliveryRecord = {
  id: string
  webhook_id: string
  event: string
  session_id: string | null
  status: string
  attempt_count: number
  response_status: number | null
  error: string | null
  last_attempt_at: string | null
  delivered_at: string | null
  created_at: string
}

export default function WebhooksPageClient() {
  const supabase = createClient()
  const [webhooks, setWebhooks] = useState<WebhookRecord[]>([])
  const [deliveries, setDeliveries] = useState<DeliveryRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [signingSecret, setSigningSecret] = useState('')
  const [name, setName] = useState('Session lifecycle')
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<string[]>([...EVENTS])

  const getToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ?? null
  }, [supabase])

  const authHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const token = await getToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
  }, [getToken])

  const loadWebhooks = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/developers/webhooks', { headers: await authHeaders() })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not load webhooks')
      setWebhooks(data.webhooks ?? [])
      setDeliveries(data.deliveries ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load webhooks')
    } finally {
      setLoading(false)
    }
  }, [authHeaders])

  useEffect(() => { void loadWebhooks() }, [loadWebhooks])

  function toggleEvent(event: string) {
    setEvents(prev => {
      const next = prev.includes(event) ? prev.filter(item => item !== event) : [...prev, event]
      return next.length > 0 ? next : prev
    })
  }

  async function handleCreate() {
    setSaving(true); setError(''); setNotice(''); setSigningSecret('')
    try {
      const res = await fetch('/api/developers/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ name, url, events }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not create webhook')
      setSigningSecret(data.signingSecret ?? '')
      setNotice('Webhook created. Copy the signing secret now; it will not be shown again.')
      setUrl('')
      setShowCreate(false)
      await loadWebhooks()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create webhook')
    } finally {
      setSaving(false)
    }
  }

  async function patchWebhook(id: string, patch: Record<string, unknown>) {
    setSaving(true); setError(''); setNotice(''); setSigningSecret('')
    try {
      const res = await fetch('/api/developers/webhooks', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ id, ...patch }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not update webhook')
      if (data.signingSecret) setSigningSecret(data.signingSecret)
      setNotice(patch.rotateSecret ? 'Signing secret rotated. Copy it now.' : 'Webhook updated.')
      await loadWebhooks()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update webhook')
    } finally {
      setSaving(false)
    }
  }

  async function deleteWebhook(id: string) {
    setSaving(true); setError(''); setNotice('')
    try {
      const res = await fetch(`/api/developers/webhooks?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: await authHeaders(),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not delete webhook')
      setNotice('Webhook deleted.')
      await loadWebhooks()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete webhook')
    } finally {
      setSaving(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '9px 12px',
    borderRadius: '8px',
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--text)',
    fontSize: '13px',
    boxSizing: 'border-box',
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '36px 48px', maxWidth: '1040px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '28px', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: '0 0 6px', fontSize: '28px', fontWeight: 700 }}>Webhooks</h1>
          <p style={{ margin: 0, fontSize: '14px', color: 'var(--muted)', lineHeight: 1.7 }}>
            Deliver signed session lifecycle events to your backend with retries and logs.
          </p>
        </div>
        <button onClick={() => setShowCreate(v => !v)} style={{ padding: '10px 16px', borderRadius: '8px', border: 'none', background: 'var(--accent)', color: '#000', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>
          + Create webhook
        </button>
      </div>

      {error && <div style={{ marginBottom: '16px', padding: '12px 16px', borderRadius: '8px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171', fontSize: '13px' }}>{error}</div>}
      {notice && <div style={{ marginBottom: '16px', padding: '12px 16px', borderRadius: '8px', background: 'rgba(0,255,136,0.06)', border: '1px solid rgba(0,255,136,0.2)', color: 'var(--accent)', fontSize: '13px' }}>{notice}</div>}

      {signingSecret && (
        <div style={{ marginBottom: '20px', padding: '16px', borderRadius: '10px', background: 'var(--surface)', border: '1px solid rgba(0,255,136,0.2)' }}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '2px', marginBottom: '10px' }}>SIGNING SECRET</div>
          <code style={{ display: 'block', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', background: 'var(--bg)', padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--border)', overflowX: 'auto' }}>{signingSecret}</code>
        </div>
      )}

      {showCreate && (
        <div style={{ marginBottom: '24px', padding: '20px', borderRadius: '12px', background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) minmax(260px, 2fr)', gap: '12px', marginBottom: '14px' }}>
            <label style={{ fontSize: '12px', color: 'var(--muted)', display: 'grid', gap: '6px' }}>
              Name
              <input value={name} onChange={e => setName(e.target.value)} style={inputStyle} />
            </label>
            <label style={{ fontSize: '12px', color: 'var(--muted)', display: 'grid', gap: '6px' }}>
              Endpoint URL
              <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/peermesh/webhook" style={inputStyle} />
            </label>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
            {EVENTS.map(event => (
              <label key={event} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 10px', border: '1px solid var(--border)', borderRadius: '8px', fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--text)', cursor: 'pointer' }}>
                <input type="checkbox" checked={events.includes(event)} onChange={() => toggleEvent(event)} />
                {event}
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={handleCreate} disabled={saving} style={{ padding: '10px 18px', borderRadius: '8px', border: 'none', background: 'var(--accent)', color: '#000', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
              {saving ? 'CREATING...' : 'CREATE WEBHOOK'}
            </button>
            <button onClick={() => setShowCreate(false)} style={{ padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--muted)', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', cursor: 'pointer' }}>CANCEL</button>
          </div>
        </div>
      )}

      <div style={{ border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden', marginBottom: '24px' }}>
        <div style={{ padding: '10px 20px', background: 'var(--surface)', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '1px' }}>ENDPOINTS</div>
        {loading && <div style={{ padding: '24px 20px', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--muted)' }}>LOADING...</div>}
        {!loading && webhooks.length === 0 && <div style={{ padding: '32px 20px', textAlign: 'center', fontSize: '13px', color: 'var(--muted)' }}>No webhooks yet. Create one above.</div>}
        {webhooks.map((webhook, i) => (
          <div key={webhook.id} style={{ display: 'grid', gridTemplateColumns: '1.5fr 2fr 150px 190px', gap: '14px', padding: '14px 20px', alignItems: 'center', borderTop: i > 0 ? '1px solid var(--border)' : 'none', opacity: webhook.is_active ? 1 : 0.58 }}>
            <div>
              <div style={{ fontSize: '13px', color: 'var(--text)', fontWeight: 600 }}>{webhook.name}</div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: webhook.is_active ? 'var(--accent)' : '#f87171', marginTop: '3px' }}>{webhook.is_active ? 'ACTIVE' : 'INACTIVE'}</div>
            </div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{webhook.url}</div>
            <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{webhook.last_delivery_at ? new Date(webhook.last_delivery_at).toLocaleString() : 'No deliveries'}</div>
            <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
              <button disabled={saving} onClick={() => void patchWebhook(webhook.id, { isActive: !webhook.is_active })} style={{ padding: '7px 9px', borderRadius: '7px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: 'pointer' }}>{webhook.is_active ? 'PAUSE' : 'RESUME'}</button>
              <button disabled={saving} onClick={() => void patchWebhook(webhook.id, { rotateSecret: true })} style={{ padding: '7px 9px', borderRadius: '7px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: 'pointer' }}>ROTATE</button>
              <button disabled={saving} onClick={() => void deleteWebhook(webhook.id)} style={{ padding: '7px 9px', borderRadius: '7px', border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.06)', color: '#f87171', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: 'pointer' }}>DELETE</button>
            </div>
          </div>
        ))}
      </div>

      <div style={{ border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
        <div style={{ padding: '10px 20px', background: 'var(--surface)', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '1px' }}>RECENT DELIVERIES</div>
        {deliveries.length === 0 && <div style={{ padding: '22px 20px', fontSize: '13px', color: 'var(--muted)' }}>No delivery attempts yet.</div>}
        {deliveries.map((delivery, i) => (
          <div key={delivery.id} style={{ display: 'grid', gridTemplateColumns: '1fr 110px 120px 1fr', gap: '14px', padding: '12px 20px', borderTop: i > 0 ? '1px solid var(--border)' : 'none', alignItems: 'center' }}>
            <div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--text)' }}>{delivery.event}</div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', marginTop: '2px' }}>{delivery.session_id ? delivery.session_id.slice(0, 8) : 'no session'}</div>
            </div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: delivery.status === 'delivered' ? 'var(--accent)' : delivery.status === 'abandoned' ? '#f87171' : 'var(--muted)' }}>{delivery.status.toUpperCase()}</div>
            <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{delivery.response_status ?? 'no response'} · {delivery.attempt_count} tries</div>
            <div style={{ fontSize: '12px', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{delivery.error || (delivery.last_attempt_at ? new Date(delivery.last_attempt_at).toLocaleString() : new Date(delivery.created_at).toLocaleString())}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
