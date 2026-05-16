'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type ApiKeyRecord = {
  id: string
  name: string
  key_prefix: string
  tier: string
  rpm_limit: number
  session_mode: string
  is_active: boolean
  last_used_at: string | null
  created_at: string
}

export default function KeysPageClient() {
  const supabase = createClient()
  const [keys, setKeys] = useState<ApiKeyRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [createdKey, setCreatedKey] = useState('')
  const [copied, setCopied] = useState(false)
  const [showCreate, setShowCreate] = useState(false)

  const [name, setName] = useState('My API key')
  const [tier, setTier] = useState('standard')
  const [rpmLimit, setRpmLimit] = useState(60)
  const [sessionMode, setSessionMode] = useState<'rotating' | 'sticky'>('rotating')

  const getToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ?? null
  }, [supabase])

  const loadKeys = useCallback(async () => {
    setLoading(true)
    try {
      const token = await getToken()
      const res = await fetch('/api/billing/api-keys', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not load keys')
      setKeys(data.keys ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load keys')
    } finally {
      setLoading(false)
    }
  }, [getToken])

  async function handleCreate() {
    setSaving(true); setError(''); setNotice(''); setCreatedKey('')
    try {
      const token = await getToken()
      const res = await fetch('/api/billing/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ name, tier, rpmLimit, sessionMode }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not create key')
      setCreatedKey(data.key ?? '')
      setNotice('API key created. Copy it now — it will not be shown again.')
      setShowCreate(false)
      await loadKeys()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create key')
    } finally {
      setSaving(false)
    }
  }

  async function handleToggle(id: string, isActive: boolean) {
    setSaving(true); setError(''); setNotice('')
    try {
      const token = await getToken()
      const res = await fetch('/api/billing/api-keys', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ id, isActive: !isActive }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not update key')
      setNotice(!isActive ? 'Key reactivated.' : 'Key deactivated.')
      await loadKeys()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update key')
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => { void loadKeys() }, [loadKeys])

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '9px 12px', borderRadius: '8px',
    border: '1px solid var(--border)', background: 'var(--bg)',
    color: 'var(--text)', fontSize: '13px', boxSizing: 'border-box',
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '36px 48px', maxWidth: '960px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '28px', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: '0 0 6px', fontSize: '28px', fontWeight: 700 }}>API Keys</h1>
          <p style={{ margin: 0, fontSize: '14px', color: 'var(--muted)' }}>
            Issue and manage Bearer API keys for your developer integrations.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(v => !v)}
          style={{
            padding: '10px 16px', borderRadius: '8px', border: 'none',
            background: 'var(--accent)', color: '#000',
            fontFamily: 'var(--font-geist-mono)', fontSize: '12px', fontWeight: 700,
            cursor: 'pointer', flexShrink: 0,
          }}
        >
          + Create API key
        </button>
      </div>

      {/* Alerts */}
      {error && (
        <div style={{ marginBottom: '16px', padding: '12px 16px', borderRadius: '8px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171', fontSize: '13px' }}>
          {error}
        </div>
      )}
      {notice && (
        <div style={{ marginBottom: '16px', padding: '12px 16px', borderRadius: '8px', background: 'rgba(0,255,136,0.06)', border: '1px solid rgba(0,255,136,0.2)', color: 'var(--accent)', fontSize: '13px' }}>
          {notice}
        </div>
      )}

      {/* New key reveal */}
      {createdKey && (
        <div style={{ marginBottom: '20px', padding: '16px', borderRadius: '10px', background: 'var(--surface)', border: '1px solid rgba(0,255,136,0.2)' }}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '2px', marginBottom: '10px' }}>NEW KEY — COPY NOW</div>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <code style={{ flex: 1, fontFamily: 'var(--font-geist-mono)', fontSize: '12px', background: 'var(--bg)', padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--border)', overflowX: 'auto', display: 'block' }}>
              {createdKey}
            </code>
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(createdKey).catch(() => {})
                setCopied(true); setTimeout(() => setCopied(false), 1500)
              }}
              style={{ padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: copied ? 'var(--accent)' : 'var(--text)', fontFamily: 'var(--font-geist-mono)', fontSize: '11px', cursor: 'pointer', flexShrink: 0 }}
            >
              {copied ? 'COPIED' : 'COPY'}
            </button>
          </div>
        </div>
      )}

      {/* Create form */}
      {showCreate && (
        <div style={{ marginBottom: '24px', padding: '20px', borderRadius: '12px', background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '2px', marginBottom: '16px' }}>NEW API KEY</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '16px' }}>
            <label style={{ fontSize: '12px', color: 'var(--muted)', display: 'grid', gap: '6px' }}>
              Name
              <input value={name} onChange={e => setName(e.target.value)} style={inputStyle} />
            </label>
            <label style={{ fontSize: '12px', color: 'var(--muted)', display: 'grid', gap: '6px' }}>
              Tier
              <select value={tier} onChange={e => setTier(e.target.value)} style={inputStyle}>
                <option value="standard">Standard</option>
                <option value="advanced">Advanced</option>
                <option value="enterprise">Enterprise</option>
                <option value="contributor">Contributor</option>
              </select>
            </label>
            <label style={{ fontSize: '12px', color: 'var(--muted)', display: 'grid', gap: '6px' }}>
              RPM limit
              <input type="number" min={1} max={2400} value={rpmLimit} onChange={e => setRpmLimit(Number(e.target.value) || 60)} style={inputStyle} />
            </label>
            <label style={{ fontSize: '12px', color: 'var(--muted)', display: 'grid', gap: '6px' }}>
              Session mode
              <select value={sessionMode} onChange={e => setSessionMode(e.target.value === 'sticky' ? 'sticky' : 'rotating')} style={inputStyle}>
                <option value="rotating">Rotating</option>
                <option value="sticky">Sticky</option>
              </select>
            </label>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={handleCreate} disabled={saving} style={{ padding: '10px 18px', borderRadius: '8px', border: 'none', background: 'var(--accent)', color: '#000', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
              {saving ? 'CREATING...' : 'CREATE KEY'}
            </button>
            <button onClick={() => setShowCreate(false)} style={{ padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--muted)', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', cursor: 'pointer' }}>
              CANCEL
            </button>
          </div>
        </div>
      )}

      {/* Keys table */}
      <div style={{ border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
        {/* Table header */}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 110px', gap: '0', padding: '10px 20px', background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
          {['Key', 'Tier', 'Created', 'Last used', ''].map(h => (
            <div key={h} style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '1px' }}>{h}</div>
          ))}
        </div>

        {loading && (
          <div style={{ padding: '24px 20px', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--muted)' }}>LOADING...</div>
        )}
        {!loading && keys.length === 0 && (
          <div style={{ padding: '32px 20px', textAlign: 'center', fontSize: '13px', color: 'var(--muted)' }}>
            No API keys yet. Create one above.
          </div>
        )}

        {keys.map((key, i) => (
          <div
            key={key.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '2fr 1fr 1fr 1fr 110px',
              gap: '0',
              padding: '14px 20px',
              alignItems: 'center',
              borderTop: i > 0 ? '1px solid var(--border)' : 'none',
              background: key.is_active ? 'transparent' : 'rgba(255,255,255,0.01)',
              opacity: key.is_active ? 1 : 0.55,
            }}
          >
            <div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '13px', color: 'var(--accent)' }}>
                ...{key.key_prefix.slice(-6)}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '3px' }}>
                {key.name}
                {!key.is_active && <span style={{ marginLeft: '8px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: '#f87171', background: 'rgba(239,68,68,0.1)', padding: '1px 6px', borderRadius: '3px' }}>INACTIVE</span>}
              </div>
            </div>
            <div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--text)' }}>{key.tier.toUpperCase()}</div>
              <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '2px' }}>{key.rpm_limit} RPM · {key.session_mode}</div>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
              {new Date(key.created_at).toLocaleDateString()}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
              {key.last_used_at ? new Date(key.last_used_at).toLocaleDateString() : 'Never'}
            </div>
            <button
              onClick={() => void handleToggle(key.id, key.is_active)}
              disabled={saving}
              style={{
                padding: '7px 12px',
                borderRadius: '7px',
                border: `1px solid ${key.is_active ? 'rgba(239,68,68,0.3)' : 'rgba(0,255,136,0.3)'}`,
                background: key.is_active ? 'rgba(239,68,68,0.06)' : 'rgba(0,255,136,0.06)',
                color: key.is_active ? '#f87171' : 'var(--accent)',
                fontFamily: 'var(--font-geist-mono)',
                fontSize: '10px',
                cursor: saving ? 'not-allowed' : 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {key.is_active ? 'DEACTIVATE' : 'REACTIVATE'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
