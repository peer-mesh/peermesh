'use client'

import { useState } from 'react'

const BASE = 'https://peermesh-beta.vercel.app'
const API = `${BASE}/api`

type Endpoint = {
  id: string
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  title: string
  description: string
  params?: Array<{ name: string; type: string; required: boolean; desc: string; default?: string }>
  body?: Array<{ name: string; type: string; required: boolean; desc: string }>
  headers?: Array<{ name: string; type: string; desc: string }>
  response: string
  statusLabel?: string
  curl: string
  node: string
  python: string
}

const ENDPOINTS: Endpoint[] = [
  {
    id: 'version',
    method: 'GET',
    path: '/version',
    title: 'Get API version',
    description: 'Returns the current API version and latest installable surface versions for client SDKs. No authentication required.',
    response: `{
  "api": {
    "version": "v1",
    "prefix": "/api",
    "docs": "/developers/api-docs"
  },
  "desktop": "1.0.90",
  "extension": "1.0.12",
  "cli": "1.0.54"
}`,
    curl: `curl --request GET \\
  --url '${API}/version' \\
  --header 'accept: application/json'`,
    node: `const res = await fetch('${API}/version')
const { api, desktop, extension, cli } = await res.json()
console.log(\`API: \${api.version}, Desktop: \${desktop}\`)`,
    python: `import requests
r = requests.get('${API}/version')
data = r.json()
print(f"API: {data['api']['version']}, Desktop: {data['desktop']}")`,
  },
  {
    id: 'session-create',
    method: 'POST',
    path: '/session/create',
    title: 'Create session',
    description: 'Create a routed residential proxy session for a target country or pin to a private share code. Returns a relay endpoint (WebSocket) to route traffic through. Requires email confirmation and non-suspicious account activity.',
    body: [
      { name: 'country', type: 'string', required: false, desc: 'ISO 3166-1 alpha-2 country code (e.g., "US", "GB"). Required unless privateCode is provided.' },
      { name: 'privateCode', type: 'string', required: false, desc: '9-digit private share code. Pins session to a specific device. Requires verified access.' },
      { name: 'bandwidthGb', type: 'number', required: false, desc: 'Bandwidth cap in GB. Defaults to API key tier limit.' },
      { name: 'rpm', type: 'integer', required: false, desc: 'Max requests per minute. Defaults to API key RPM limit. Capped by key tier.' },
      { name: 'periodHours', type: 'integer', required: false, desc: 'Session duration in hours. Default: 1. Min: 1, Max: 730 (30 days).' },
      { name: 'sessionMode', type: 'string', required: false, desc: '"rotating" or "sticky". Defaults to "rotating". Standard tier keys only support rotating.' },
      { name: 'requestId', type: 'string', required: false, desc: 'Idempotency key (max 120 chars). Duplicate within 24h returns existing session.' },
    ],
    headers: [
      { name: 'Authorization', type: 'string', desc: 'Bearer <api-key>. Required.' },
      { name: 'Content-Type', type: 'string', desc: 'application/json' },
    ],
    response: `{
  "sessionId": "uuid",
  "relayEndpoint": "wss://peermesh-relay.fly.dev",
  "relayFallbackList": ["wss://relay-1", "wss://relay-2"],
  "receipt": "base64url.sig",
  "country": "US",
  "preferredProviderUserId": null,
  "privateProviderUserId": null,
  "privateBaseDeviceId": null
}

Errors:
401: { "error": "Unauthorized" }
409: { "error": "Private share is currently offline...", "onDemandStartQueued": true, "wakeQueued": true, "providerReachable": false, "retryAfterSeconds": 30 }
429: { "error": "Too many active PeerMesh sessions for this account.", "code": "active_session_limit", "activeSessions": 3, "maxConcurrentSessions": 3 }
429: { "error": "Too many session requests. Please retry shortly.", "retryAfterSeconds": 45 }
403: { "error": "Confirm your email before connecting.", "code": "email_confirmation_required", "nextStep": "/auth/confirm-email" }
403: { "error": "Account suspended due to low trust score" }
403: { "error": "<Key-Name> is capped at 120 RPM." }
403: { "error": "<Key-Name> only supports rotating sessions." }
400: { "error": "country or privateCode is required" }
400: { "error": "Private code must be exactly 9 digits" }`,
    curl: `curl --request POST \\
  --url '${API}/session/create' \\
  --header 'Authorization: Bearer pmk_live_xxx' \\
  --header 'Content-Type: application/json' \\
  --data '{
    "country": "US",
    "bandwidthGb": 2,
    "rpm": 120,
    "periodHours": 6,
    "sessionMode": "rotating",
    "requestId": "job-42"
  }'`,
    node: `const apiKey = 'pmk_live_...' // store securely
const res = await fetch('${API}/session/create', {
  method: 'POST',
  headers: {
    Authorization: \`Bearer \${apiKey}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    country: 'US',
    bandwidthGb: 2,
    rpm: 120,
    periodHours: 6,
    sessionMode: 'rotating',
    requestId: 'job-42',
  }),
})
if (!res.ok) {
  const { error, code } = await res.json()
  throw new Error(\`\${code}: \${error}\`)
}
const { sessionId, relayEndpoint } = await res.json()
console.log('Connected:', relayEndpoint)`,
    python: `import requests
api_key = 'pmk_live_...'  # store securely
resp = requests.post(
  '${API}/session/create',
  headers={
    'Authorization': f'Bearer {api_key}',
    'Content-Type': 'application/json',
  },
  json={
    'country': 'US',
    'bandwidthGb': 2,
    'rpm': 120,
    'periodHours': 6,
    'sessionMode': 'rotating',
    'requestId': 'job-42',
  }
)
if not resp.ok:
  raise Exception(f"{resp.status_code}: {resp.json()['error']}")
session = resp.json()
print(f"Connected: {session['relayEndpoint']}")`,
  },
  {
    id: 'session-end',
    method: 'POST',
    path: '/session/end',
    title: 'End session',
    description: 'Terminate an active session and stop traffic routing. Meter snapshot is taken at relay for final billing (client-reported bytes are not trusted).',
    statusLabel: '202 Accepted',
    body: [
      { name: 'sessionId', type: 'string', required: true, desc: 'The session ID from /session/create response.' },
    ],
    headers: [
      { name: 'Authorization', type: 'string', desc: 'Bearer <api-key>. Required.' },
      { name: 'Content-Type', type: 'string', desc: 'application/json' },
    ],
    response: `{
  "success": true,
  "authoritativeMetering": "relay",
  "bytesUsedAccepted": false,
  "bytesUsedObserved": 1048576,
  "awaitingRelayFinalization": true
}

Errors:
401: { "error": "Unauthorized" }
404: { "error": "Session not found" }`,
    curl: `curl --request POST \\
  --url '${API}/session/end' \\
  --header 'Authorization: Bearer pmk_live_xxx' \\
  --header 'Content-Type: application/json' \\
  --data '{ "sessionId": "uuid" }'`,
    node: `await fetch('${API}/session/end', {
  method: 'POST',
  headers: {
    Authorization: \`Bearer \${apiKey}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ sessionId: 'uuid' }),
})`,
    python: `requests.post(
  '${API}/session/end',
  headers={'Authorization': f'Bearer {api_key}'},
  json={'sessionId': 'uuid'}
)`,
  },
  {
    id: 'session-status',
    method: 'GET',
    path: '/session/{id}',
    title: 'Get session status',
    description: 'Poll the current state, metering, provider speed, reconnect state, and final disconnect reason for a session you own.',
    headers: [
      { name: 'Authorization', type: 'string', desc: 'Bearer <api-key>. Required for API-created sessions.' },
    ],
    response: `{
  "session": {
    "id": "uuid",
    "status": "active",
    "country": "US",
    "relayEndpoint": "wss://peermesh-relay.fly.dev",
    "bytesUsed": 1048576,
    "disconnectReason": null,
    "providerAvgMbps": 12.4,
    "providerLastMbps": 10.9,
    "connectionQuality": { "currentMbps": 10.9 },
    "reconnectAttempts": 0,
    "reconnectReason": null,
    "receipt": "base64url.sig"
  }
}

Errors:
401: { "error": "Unauthorized" }
404: { "error": "Session not found" }`,
    curl: `curl --request GET \\
  --url '${API}/session/uuid' \\
  --header 'Authorization: Bearer pmk_live_xxx'`,
    node: `const res = await fetch('${API}/session/uuid', {
  headers: { Authorization: \`Bearer \${apiKey}\` },
})
const { session } = await res.json()
console.log(session.status, session.bytesUsed, session.providerLastMbps)`,
    python: `r = requests.get(
  '${API}/session/uuid',
  headers={'Authorization': f'Bearer {api_key}'}
)
print(r.json()['session']['status'])`,
  },
  {
    id: 'countries',
    method: 'GET',
    path: '/countries',
    title: 'List countries',
    description: 'Return countries currently configured for PeerMesh with live provider counts, so clients can choose a valid session country.',
    response: `{
  "countries": [
    { "code": "US", "name": "United States", "providers": 12 }
  ]
}`,
    curl: `curl --request GET \\
  --url '${API}/countries'`,
    node: `const res = await fetch('${API}/countries')
const { countries } = await res.json()
console.log(countries.map(c => \`\${c.code}: \${c.providers}\`))`,
    python: `r = requests.get('${API}/countries')
for country in r.json()['countries']:
  print(country['code'], country.get('providers', 0))`,
  },
  {
    id: 'keys-list',
    method: 'GET',
    path: '/billing/api-keys',
    title: 'List API keys',
    description: 'Returns all API keys for your account with metadata and recent usage logs. Requires email confirmation.',
    headers: [
      { name: 'Authorization', type: 'string', desc: 'Bearer <token>. Required.' },
    ],
    response: `{
  "keys": [
    {
      "id": "key_xyz",
      "name": "Checkout worker",
      "key_prefix": "pmk_live_abc",
      "tier": "standard",
      "rpm_limit": 60,
      "session_mode": "rotating",
      "requires_verification": false,
      "is_active": true,
      "created_at": "2026-01-01T00:00:00Z",
      "last_used_at": "2026-05-15T10:00:00Z"
    }
  ],
  "usage": [
    {
      "id": "usage_123",
      "api_key_id": "key_xyz",
      "session_id": "sess_456",
      "bandwidth_bytes": 1073741824,
      "rpm_requested": 60,
      "session_mode": "rotating",
      "duration_minutes": 60,
      "estimated_cost_usd": 1.25,
      "collected_cost_usd": 1.25,
      "created_at": "2026-05-15T09:00:00Z"
    }
  ]
}`,
    curl: `curl --request GET \\
  --url '${API}/billing/api-keys' \\
  --header 'Authorization: Bearer <token>'`,
    node: `const res = await fetch('${API}/billing/api-keys', {
  headers: { Authorization: \`Bearer \${token}\` },
})
const { keys, usage } = await res.json()
keys.forEach(k => console.log(\`\${k.name}: \${k.key_prefix}...\`))`,
    python: `r = requests.get(
  '${API}/billing/api-keys',
  headers={'Authorization': f'Bearer {token}'}
)
data = r.json()
for key in data['keys']:
  print(f"{key['name']}: {key['key_prefix']}...")`,
  },
  {
    id: 'keys-create',
    method: 'POST',
    path: '/billing/api-keys',
    title: 'Create API key',
    description: 'Issue a new API key for your account. The raw key is returned once and cannot be recovered — store it immediately. Only the prefix is shown in subsequent requests. Requires email confirmation.',
    body: [
      { name: 'name', type: 'string', required: true, desc: 'Human-readable label (max 64 chars). Examples: "Checkout worker", "Data pipeline".' },
      { name: 'tier', type: 'string', required: false, desc: '"standard" | "advanced" | "enterprise" | "contributor". Default: "standard". Contributor is for Peer/Host accounts that accepted provider terms.' },
      { name: 'rpmLimit', type: 'integer', required: false, desc: 'Max requests per minute. Default: 60. Capped by tier (standard: 120, advanced: 600, enterprise: 2400).' },
      { name: 'sessionMode', type: 'string', required: false, desc: '"rotating" | "sticky". Default: "rotating". Standard tier only supports rotating.' },
    ],
    headers: [
      { name: 'Authorization', type: 'string', desc: 'Bearer <token>. Required.' },
      { name: 'Content-Type', type: 'string', desc: 'application/json' },
    ],
    response: `{
  "key": "pmk_live_xxxxxxxxxxxxxxxxxxxx",
  "record": {
    "id": "key_xyz",
    "name": "Checkout worker",
    "key_prefix": "pmk_live_abc",
    "tier": "standard",
    "rpm_limit": 60,
    "session_mode": "rotating",
    "requires_verification": false,
    "is_active": true,
    "last_used_at": null,
    "created_at": "2026-05-15T12:00:00Z"
  }
}

Errors:
401: { "error": "Unauthorized" }
403: { "error": "Confirm your email before creating API keys." }
403: { "error": "Verify your phone before creating this API key tier." }
403: { "error": "Contributor keys are only available to Peer or Host accounts." }
400: { "error": "name is required" }
400: { "error": "Standard keys only support rotating sessions." }`,
    curl: `curl --request POST \\
  --url '${API}/billing/api-keys' \\
  --header 'Authorization: Bearer <token>' \\
  --header 'Content-Type: application/json' \\
  --data '{
    "name": "Checkout worker",
    "tier": "standard",
    "rpmLimit": 60,
    "sessionMode": "rotating"
  }'`,
    node: `const res = await fetch('${API}/billing/api-keys', {
  method: 'POST',
  headers: {
    Authorization: \`Bearer \${token}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    name: 'Checkout worker',
    tier: 'standard',
    rpmLimit: 60,
    sessionMode: 'rotating',
  }),
})
if (!res.ok) throw new Error(await res.text())
const { key, record } = await res.json()
// IMPORTANT: Store key immediately — only shown once!
console.log('Key created:', record.name)
console.log('Raw key:', key)
saveToSecureStorage(key)`,
    python: `resp = requests.post(
  '${API}/billing/api-keys',
  headers={'Authorization': f'Bearer {token}'},
  json={
    'name': 'Checkout worker',
    'tier': 'standard',
    'rpmLimit': 60,
    'sessionMode': 'rotating',
  }
)
if not resp.ok:
  raise Exception(resp.json()['error'])
data = resp.json()
# IMPORTANT: Store key immediately — only shown once!
print(f"Key created: {data['record']['name']}")
print(f"Raw key: {data['key']}")
save_to_secure_storage(data['key'])`,
  },
  {
    id: 'keys-toggle',
    method: 'PATCH',
    path: '/billing/api-keys',
    title: 'Toggle API key status',
    description: 'Activate or deactivate an API key without deleting it. Deactivated keys are rejected with 401 Unauthorized on all requests. Requires email confirmation.',
    body: [
      { name: 'id', type: 'string', required: true, desc: 'The key ID (e.g., "key_xyz") from /billing/api-keys list.' },
      { name: 'isActive', type: 'boolean', required: true, desc: 'true to activate, false to deactivate.' },
    ],
    headers: [
      { name: 'Authorization', type: 'string', desc: 'Bearer <token>. Required.' },
      { name: 'Content-Type', type: 'string', desc: 'application/json' },
    ],
    response: `{
  "ok": true,
  "id": "key_xyz",
  "is_active": false
}

Errors:
401: { "error": "Unauthorized" }
400: { "error": "id is required" }`,
    curl: `curl --request PATCH \\
  --url '${API}/billing/api-keys' \\
  --header 'Authorization: Bearer <token>' \\
  --header 'Content-Type: application/json' \\
  --data '{
    "id": "key_xyz",
    "isActive": false
  }'`,
    node: `await fetch('${API}/billing/api-keys', {
  method: 'PATCH',
  headers: {
    Authorization: \`Bearer \${token}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ 
    id: 'key_xyz',
    isActive: false 
  }),
})`,
    python: `requests.patch(
  '${API}/billing/api-keys',
  headers={'Authorization': f'Bearer {token}'},
  json={
    'id': 'key_xyz',
    'isActive': False
  }
)`,
  },
  {
    id: 'billing-quote',
    method: 'POST',
    path: '/billing/quote',
    title: 'Get usage quote',
    description: 'Calculate estimated cost for a session before creating it. Returns pricing breakdown with tier factors, RPM multipliers, and constraints. Use to validate wallet balance.',
    body: [
      { name: 'tier', type: 'string', required: true, desc: '"standard" | "advanced" | "enterprise" | "contributor". Determines pricing multiplier and limits.' },
      { name: 'bandwidthGb', type: 'number', required: true, desc: 'Bandwidth in GB. Min: 0.05, no max. Standard rate: $1/GB base, $3/GB for browse mode.' },
      { name: 'rpm', type: 'integer', required: true, desc: 'Requests per minute. Affects cost. Must match tier limits or returns constraint.' },
      { name: 'periodHours', type: 'integer', required: true, desc: 'Duration in hours. Affects multiplier based on pressure.' },
      { name: 'sessionMode', type: 'string', required: false, desc: '"rotating" | "sticky". Default: "rotating". Affects pricing.' },
    ],
    headers: [
      { name: 'Authorization', type: 'string', desc: 'Bearer <token>. Required.' },
      { name: 'Content-Type', type: 'string', desc: 'application/json' },
    ],
    response: `{
  "quote": {
    "ok": true,
    "tier": "standard",
    "bandwidthGb": 2,
    "rpm": 60,
    "periodHours": 1,
    "sessionMode": "rotating",
    "basePerGbUsd": 1,
    "factors": {
      "rpm": 1,
      "session": 1,
      "period": 1,
      "tier": 1,
      "pressure": 1
    },
    "estimatedUsd": 2.2,
    "constraints": []
  },
  "account": {
    "is_verified": true,
    "role": "client",
    "wallet_balance_usd": 10.5,
    "contribution_credits_bytes": 0
  }
}

Errors:
401: { "error": "Unauthorized" }
400: { "error": "tier is required" }
403: { "quote": { "ok": false, "constraints": [{ "code": "tier_rpm_cap", "message": "Standard tier is capped at 120 RPM" }] } }`,
    curl: `curl --request POST \\
  --url '${API}/billing/quote' \\
  --header 'Authorization: Bearer <token>' \\
  --header 'Content-Type: application/json' \\
  --data '{
    "tier": "standard",
    "bandwidthGb": 2,
    "rpm": 60,
    "periodHours": 1
  }'`,
    node: `const res = await fetch('${API}/billing/quote', {
  method: 'POST',
  headers: {
    Authorization: \`Bearer \${token}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    tier: 'standard',
    bandwidthGb: 2,
    rpm: 60,
    periodHours: 1,
  }),
})
const { quote, account } = await res.json()
if (quote.ok) {
  console.log(\`Estimated: $\${quote.estimatedUsd}\`)
  console.log(\`Wallet: $\${account.wallet_balance_usd}\`)
  if (quote.estimatedUsd > account.wallet_balance_usd) {
    console.log('Insufficient balance')
  }
} else {
  console.log('Constraints:', quote.constraints.map(c => c.message))
}`,
    python: `resp = requests.post(
  '${API}/billing/quote',
  headers={'Authorization': f'Bearer {token}'},
  json={'tier': 'standard', 'bandwidthGb': 2, 'rpm': 60, 'periodHours': 1}
)
data = resp.json()
quote = data['quote']
if quote['ok']:
  print(f"Estimated: \${quote['estimatedUsd']}")
  print(f"Wallet: \${data['account']['wallet_balance_usd']}")
else:
  for constraint in quote['constraints']:
    print(f"Constraint: {constraint['message']}")`,
  },
]

const GROUPS = [
  { label: 'Core', ids: ['version', 'countries'] },
  { label: 'Sessions', ids: ['session-create', 'session-status', 'session-end'] },
  { label: 'API Keys', ids: ['keys-list', 'keys-create', 'keys-toggle'] },
  { label: 'Billing', ids: ['billing-quote'] },
]

const METHOD_COLOR: Record<string, string> = {
  GET: '#22c55e',
  POST: '#3b82f6',
  PATCH: '#f59e0b',
  DELETE: '#ef4444',
}

const TABS = ['Shell', 'Node', 'Python'] as const
type Tab = typeof TABS[number]

export default function ApiDocsPage() {
  const [active, setActive] = useState('session-create')
  const [tab, setTab] = useState<Tab>('Shell')
  const [bearer, setBearer] = useState('')
  const [activeGroup, setActiveGroup] = useState('Sessions')

  const ep = ENDPOINTS.find(e => e.id === active) ?? ENDPOINTS[0]
  const currentGroup = GROUPS.find(g => g.label === activeGroup)

  function injectBearer(code: string) {
    if (!bearer) return code
    return code.replace(/<api-key>/g, bearer)
  }

  const codeMap: Record<Tab, string> = {
    Shell: injectBearer(ep.curl),
    Node: injectBearer(ep.node),
    Python: injectBearer(ep.python),
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', overflow: 'auto' }}>
      {/* Top: Endpoint Tabs & Selector */}
      <div style={{
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg)',
        flex: '0 0 auto',
      }}>
        {/* Group Tabs */}
        <div style={{
          display: 'flex',
          gap: '0',
          padding: '0 32px',
          borderBottom: '1px solid var(--border)',
          overflowX: 'auto',
        }}>
          {GROUPS.map(group => (
            <button
              key={group.label}
              onClick={() => {
                setActiveGroup(group.label)
                setActive(group.ids[0])
              }}
              style={{
                padding: '12px 16px',
                background: activeGroup === group.label ? 'transparent' : 'transparent',
                border: 'none',
                borderBottom: activeGroup === group.label ? '2px solid var(--accent)' : '2px solid transparent',
                color: activeGroup === group.label ? 'var(--text)' : 'var(--muted)',
                fontFamily: 'var(--font-geist-mono)',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                letterSpacing: '0.5px',
                whiteSpace: 'nowrap',
              }}
            >
              {group.label.toUpperCase()}
            </button>
          ))}
        </div>

        {/* Endpoints for Active Group */}
        <div style={{
          padding: '12px 32px',
          display: 'flex',
          gap: '8px',
          flexWrap: 'wrap',
        }}>
          {currentGroup?.ids.map(id => {
            const e = ENDPOINTS.find(ep => ep.id === id)!
            const isActive = active === id
            return (
              <button
                key={id}
                onClick={() => setActive(id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '6px 12px',
                  background: isActive ? 'rgba(255,255,255,0.08)' : 'transparent',
                  border: isActive ? '1px solid var(--border)' : '1px solid transparent',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  whiteSpace: 'nowrap',
                }}
              >
                <span style={{
                  fontFamily: 'var(--font-geist-mono)',
                  fontSize: '9px',
                  fontWeight: 700,
                  color: METHOD_COLOR[e.method],
                  width: '32px',
                  flexShrink: 0,
                }}>
                  {e.method}
                </span>
                <span style={{ fontSize: '12px', color: isActive ? 'var(--text)' : 'var(--muted)' }}>
                  {e.title}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Middle: Documentation Content */}
      <div style={{ flex: '0 0 auto', padding: '32px', display: 'flex', justifyContent: 'center' }}>
        <div style={{ maxWidth: '900px', width: '100%' }}>
          {/* Title */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
            <span style={{
              fontFamily: 'var(--font-geist-mono)',
              fontSize: '11px',
              fontWeight: 700,
              color: '#000',
              background: METHOD_COLOR[ep.method],
              padding: '3px 8px',
              borderRadius: '4px',
            }}>
              {ep.method}
            </span>
            <code style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '13px', color: 'var(--muted)' }}>
              {BASE}/api{ep.path}
            </code>
          </div>
          <h1 style={{ margin: '0 0 12px', fontSize: '26px', fontWeight: 700 }}>{ep.title}</h1>
          <p style={{ margin: '0 0 28px', fontSize: '14px', color: 'var(--muted)', lineHeight: 1.8 }}>{ep.description}</p>

          {/* Headers */}
          {ep.headers && ep.headers.length > 0 && (
            <section style={{ marginBottom: '28px' }}>
              <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 600, color: 'var(--text)' }}>Headers</h3>
              <div style={{ border: '1px solid var(--border)', borderRadius: '10px', overflow: 'hidden' }}>
                {ep.headers.map((h, i) => (
                  <div key={h.name} style={{
                    display: 'grid',
                    gridTemplateColumns: '180px 1fr',
                    gap: '16px',
                    padding: '12px 16px',
                    borderTop: i > 0 ? '1px solid var(--border)' : 'none',
                    background: 'var(--surface)',
                  }}>
                    <div>
                      <code style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--text)' }}>{h.name}</code>
                      <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', marginTop: '2px' }}>{h.type}</div>
                    </div>
                    <div style={{ fontSize: '13px', color: 'var(--muted)', lineHeight: 1.6 }}>{h.desc}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Body params */}
          {ep.body && ep.body.length > 0 && (
            <section style={{ marginBottom: '28px' }}>
              <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 600, color: 'var(--text)' }}>Request body</h3>
              <div style={{ border: '1px solid var(--border)', borderRadius: '10px', overflow: 'hidden' }}>
                {ep.body.map((p, i) => (
                  <div key={p.name} style={{
                    display: 'grid',
                    gridTemplateColumns: '200px 1fr',
                    gap: '16px',
                    padding: '12px 16px',
                    borderTop: i > 0 ? '1px solid var(--border)' : 'none',
                    background: 'var(--surface)',
                  }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <code style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--text)' }}>{p.name}</code>
                        {p.required && (
                          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: '#ef4444', background: 'rgba(239,68,68,0.1)', padding: '1px 5px', borderRadius: '3px' }}>required</span>
                        )}
                    </div>
                    <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', marginTop: '2px' }}>{p.type}</div>
                  </div>
                  <div style={{ fontSize: '13px', color: 'var(--muted)', lineHeight: 1.6 }}>{p.desc}</div>
                </div>
              ))}
            </div>
          </section>
        )}

          {activeGroup === 'Sessions' && (
            <section style={{ marginBottom: '28px' }}>
              <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 600, color: 'var(--text)' }}>WebSocket connection flow</h3>
              <div style={{ padding: '14px 16px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '10px', fontSize: '13px', color: 'var(--muted)', lineHeight: 1.8 }}>
                Create a session, connect to <code style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px' }}>relayEndpoint</code>, and keep <code style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px' }}>relayFallbackList</code> for retry. Send <code style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px' }}>request_session</code> with <code style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px' }}>authToken</code>, <code style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px' }}>dbSessionId</code>, <code style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px' }}>country</code>, and <code style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px' }}>userId</code>. Wait for <code style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px' }}>agent_session_ready</code> before sending proxy requests. Handle <code style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px' }}>session_reconnecting</code> and <code style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px' }}>session_reconnected</code> without routing direct traffic. The <code style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px' }}>receipt</code> is the signed accountability token for the session.
              </div>
            </section>
          )}

          {/* Response */}
          <section>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
              <span style={{ fontSize: '13px', color: 'var(--text)', fontWeight: 600 }}>{ep.statusLabel ?? '200 OK'}</span>
            </div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '1px', marginBottom: '8px' }}>RESPONSE BODY</div>
            <pre style={{
              margin: 0,
              padding: '16px',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: '10px',
              fontSize: '12px',
              lineHeight: 1.7,
              overflowX: 'auto',
              color: 'var(--text)',
            }}>
              <code>{ep.response}</code>
            </pre>
          </section>
        </div>
      </div>

      {/* Bottom: Credentials & Code Panel */}
      <div style={{
        borderTop: '1px solid var(--border)',
        background: 'var(--surface)',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '24px',
        padding: '24px 32px',
        flex: '0 0 auto',
      }}>
        {/* Left: Credentials */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '2px' }}>CREDENTIALS</span>
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)' }}>BEARER</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px', padding: '8px 12px' }}>
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--muted)', flexShrink: 0 }}>Bearer</span>
            <input
              value={bearer}
              onChange={e => setBearer(e.target.value)}
              placeholder="token"
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                fontFamily: 'var(--font-geist-mono)',
                fontSize: '11px',
                color: 'var(--text)',
              }}
            />
          </div>
        </div>

        {/* Right: Code Panel */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div style={{ display: 'flex', gap: '4px' }}>
              {TABS.map(t => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  style={{
                    padding: '6px 12px',
                    borderRadius: '6px',
                    border: tab === t ? '1px solid var(--accent)' : '1px solid var(--border)',
                    background: tab === t ? 'rgba(255,255,255,0.08)' : 'transparent',
                    color: tab === t ? 'var(--text)' : 'var(--muted)',
                    fontFamily: 'var(--font-geist-mono)',
                    fontSize: '11px',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
            <CopyButton text={codeMap[tab]} />
          </div>
          <pre style={{
            margin: 0,
            padding: '12px',
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            fontSize: '11px',
            lineHeight: 1.6,
            overflowX: 'auto',
            color: 'var(--text)',
            fontFamily: 'var(--font-geist-mono)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}>
            <code>{codeMap[tab]}</code>
          </pre>
        </div>
      </div>
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(text).catch(() => {})
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
      style={{
        background: 'none',
        border: '1px solid var(--border)',
        borderRadius: '5px',
        padding: '3px 8px',
        fontFamily: 'var(--font-geist-mono)',
        fontSize: '10px',
        color: copied ? 'var(--accent)' : 'var(--muted)',
        cursor: 'pointer',
      }}
    >
      {copied ? 'COPIED' : 'COPY'}
    </button>
  )
}


