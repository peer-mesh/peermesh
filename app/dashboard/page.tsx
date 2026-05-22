'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { checkDesktop, syncDesktopAuth, startDesktopSharing, stopDesktopSharing, setDesktopConnectionSlots } from '@/lib/agent-client'
import { hasPaidAccess as profileHasPaidAccess } from '@/lib/account-access'
import { formatBytes } from '@/lib/utils'
import type { Profile, PeerAvailability, PrivateShare, SyncState } from '@/lib/types'
import type { DesktopState } from '@/lib/agent-client'

type Country = { code: string; name: string; flag: string }
const COUNTRIES_PAGE_SIZE = 20
const PROFILE_SELECT_FIELDS = 'id, username, role, country_code, trust_score, is_verified, verified_at, phone_number, gov_id_verified, is_premium, subscription_status, stripe_customer_id, is_sharing, total_bytes_shared, share_bytes_today, share_bytes_today_date, total_bytes_used, bandwidth_used_month, bandwidth_limit, preferred_providers, has_accepted_provider_terms, daily_share_limit_mb, contribution_credits_bytes, wallet_balance_usd, wallet_pending_payout_usd, payout_currency, created_at, updated_at, state_actor, state_changed_at'

// ── Debug logger — all strings, no objects, easy to copy from console ──────────
function log(tag: string, ...parts: (string | number | boolean | null | undefined)[]) {
  const ts = new Date().toISOString().slice(11, 23)
  console.log(`[SLOT ${ts}] [${tag}]`, parts.map(p => String(p ?? 'null')).join(' | '))
}


function CliSection({ label, cmd }: { label: string; cmd: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div>
      <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '5px', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ position: 'relative', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', padding: '10px 40px 10px 12px' }}>
        <pre style={{ margin: 0, fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.6 }}>{cmd}</pre>
        <button
          onClick={() => { navigator.clipboard.writeText(cmd).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
          style={{ position: 'absolute', top: '8px', right: '8px', background: 'none', border: 'none', color: copied ? 'var(--accent)' : 'var(--muted)', cursor: 'pointer', fontFamily: 'var(--font-geist-mono)', fontSize: '9px', padding: '2px 4px' }}
        >
          {copied ? '✓' : 'COPY'}
        </button>
      </div>
    </div>
  )
}

type PrivateShareState = PrivateShare | null
type SlotLimitEntry = {
  device_id: string
  base_device_id: string
  slot_index: number | null
  daily_limit_mb: number | null
  bytes_today: number
  can_accept_sessions: boolean
} & SyncState

type DesktopAuthBundle = {
  token: string
  refreshToken: string
  deviceSessionId: string
}

const DASHBOARD_SHARING_HEADERS = {
  'Content-Type': 'application/json',
  'x-peermesh-actor': 'dashboard',
}

function getHelperMismatchError(where: string | null | undefined): string {
  const source = where === 'cli' ? 'CLI' : 'desktop app'
  return `This ${source} is signed in as a different user. Sign out of the ${source} first.`
}

const DAILY_LIMIT_MIN_MB = 1024

function getExpiryPreset(expiresAt: string | null): string {
  if (!expiresAt) return 'none'
  const hours = Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 3_600_000))
  if (hours <= 2) return '1'
  if (hours <= 30) return '24'
  if (hours <= 24 * 8) return '168'
  return 'none'
}

function isDesktopOwnedByUser(state: DesktopState | null, userId: string | null | undefined): boolean {
  return !(state?.available && state.userId && userId && state.userId !== userId)
}

function isDesktopSharing(state: DesktopState | null): boolean {
  return !!state?.running
}

function isDesktopSharePending(state: DesktopState | null): boolean {
  return !!(state?.shareEnabled && !state?.running)
}

function createDisabledPrivateShare(deviceId: string, baseDeviceId: string, slotIndex: number): PrivateShare {
  return {
    device_id: deviceId,
    base_device_id: baseDeviceId,
    slot_index: slotIndex,
    code: '',
    enabled: false,
    expires_at: null,
    active: false,
    state_actor: null,
    state_changed_at: null,
  }
}

function getSyncTimestamp(value: string | null | undefined): number {
  if (!value) return 0
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

function preferLatestSync<T extends SyncState>(current: T | null | undefined, candidate: T | null | undefined): T | null {
  if (!candidate) return current ?? null
  if (!current) return candidate

  const currentTs = getSyncTimestamp(current.state_changed_at)
  const candidateTs = getSyncTimestamp(candidate.state_changed_at)
  if (candidateTs > currentTs) return candidate
  if (candidateTs < currentTs) return current
  return current
}

function formatSyncLabel(sync: SyncState | null | undefined): string | null {
  if (!sync?.state_changed_at) return null
  const actor = sync.state_actor ? sync.state_actor.toUpperCase() : 'SYSTEM'
  return `Synced from ${actor} at ${new Date(sync.state_changed_at).toLocaleTimeString()}`
}

function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0
  const aParts = a.split(/[.-]/).map(part => Number.parseInt(part, 10) || 0)
  const bParts = b.split(/[.-]/).map(part => Number.parseInt(part, 10) || 0)
  const length = Math.max(aParts.length, bParts.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (aParts[index] ?? 0) - (bParts[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function withTimeout<T>(promise: PromiseLike<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer))
  })
}

function mergeProfileSync(profile: Profile | null, sync: SyncState | null | undefined, updates: Partial<Profile> = {}): Profile | null {
  if (!profile) return profile

  const nextProfile = { ...profile, ...updates }
  if (!sync) return nextProfile
  if (getSyncTimestamp(sync.state_changed_at) < getSyncTimestamp(profile.state_changed_at)) return nextProfile

  return {
    ...nextProfile,
    state_actor: sync.state_actor ?? nextProfile.state_actor,
    state_changed_at: sync.state_changed_at ?? nextProfile.state_changed_at,
  }
}

function sortPrivateShares(rows: PrivateShare[]): PrivateShare[] {
  return [...rows].sort((a, b) => {
    if (a.base_device_id !== b.base_device_id) return a.base_device_id.localeCompare(b.base_device_id)
    const aSlot = a.slot_index ?? -1
    const bSlot = b.slot_index ?? -1
    if (aSlot !== bSlot) return aSlot - bSlot
    return a.device_id.localeCompare(b.device_id)
  })
}

function getPrivateShareSlotIndex(share: PrivateShare | null | undefined, baseDeviceId: string): number | null {
  if (!share || share.base_device_id !== baseDeviceId) return null
  if (Number.isInteger(share.slot_index)) return share.slot_index
  if (share.device_id === baseDeviceId) return 0
  const match = share.device_id.match(/^(.+)_slot_(\d+)$/)
  if (!match || match[1] !== baseDeviceId) return null
  const parsed = Number.parseInt(match[2], 10)
  return Number.isFinite(parsed) ? parsed : null
}

function hasPrivateShareSlot(rows: PrivateShare[], baseDeviceId: string, slotIndex: number): boolean {
  return rows.some(row => getPrivateShareSlotIndex(row, baseDeviceId) === slotIndex)
}

function mergePrivateShares(rows: PrivateShare[] | null | undefined, baseDeviceId: string, desktop: DesktopState | null): PrivateShare[] {
  const merged = new Map<string, PrivateShare>()
  const add = (share: PrivateShare | null | undefined) => {
    if (!share?.device_id) return
    if (share.base_device_id !== baseDeviceId && share.device_id !== baseDeviceId) return
    const current = merged.get(share.device_id)
    merged.set(share.device_id, preferLatestSync(current, share) ?? share)
  }

  // First, add all API rows
  for (const row of rows ?? []) add(row)

  const sources: Array<{
    baseDeviceId?: string | null
    connectionSlots?: number | null
    slots?: DesktopState['slots'] | null
    privateShare?: PrivateShareState
    privateShares?: PrivateShare[] | null
  }> = []
  if (desktop?.baseDeviceId === baseDeviceId) sources.push(desktop)
  if (desktop?.peer?.baseDeviceId === baseDeviceId) sources.push(desktop.peer)

  for (const source of sources) {
    for (const row of source.privateShares ?? []) add(row)
    add(source.privateShare ?? null)

    const configuredSlots = Math.max(1, source.slots?.configured ?? source.connectionSlots ?? 1)

    for (let index = 0; index < configuredSlots; index++) {
      const slotDeviceId = `${baseDeviceId}_slot_${index}`
      if (!hasPrivateShareSlot([...merged.values()], baseDeviceId, index)) {
        merged.set(slotDeviceId, createDisabledPrivateShare(slotDeviceId, baseDeviceId, index))
      }
    }

    for (const [deviceId, share] of merged) {
      const slotIndex = getPrivateShareSlotIndex(share, baseDeviceId)
      if (slotIndex !== null && slotIndex >= configuredSlots) {
        merged.delete(deviceId)
      }
    }
  }

  if (merged.size === 0) {
    const deviceId = `${baseDeviceId}_slot_0`
    merged.set(deviceId, createDisabledPrivateShare(deviceId, baseDeviceId, 0))
  }

  return sortPrivateShares([...merged.values()])
}

function summarizePrivateShareSlots(rows: PrivateShare[], baseDeviceId: string | null, configuredSlots: number): { publicCount: number; privateCount: number } {
  const slotCount = Math.max(1, configuredSlots || 1)
  const activeBySlot = new Map<number, boolean>()

  for (let index = 0; index < slotCount; index++) {
    activeBySlot.set(index, false)
  }

  if (baseDeviceId) {
    for (const row of rows) {
      const slotIndex = getPrivateShareSlotIndex(row, baseDeviceId)
      if (slotIndex === null || slotIndex < 0 || slotIndex >= slotCount) continue
      activeBySlot.set(slotIndex, (activeBySlot.get(slotIndex) ?? false) || !!row.active)
    }
  }

  let privateCount = 0
  for (const active of activeBySlot.values()) {
    if (active) privateCount += 1
  }

  return {
    publicCount: slotCount - privateCount,
    privateCount,
  }
}

function selectPrivateShare(rows: PrivateShare[], deviceId?: string | null, baseDeviceId?: string | null): PrivateShareState {
  if (rows.length === 0) return null
  if (deviceId) {
    const exact = rows.find(row => row.device_id === deviceId)
    if (exact) return exact
  }
  if (baseDeviceId) {
    const exactBase = rows.find(row => row.device_id === baseDeviceId)
    if (exactBase) return exactBase
    const slotZero = rows.find(row => row.base_device_id === baseDeviceId && (row.slot_index === 0 || row.device_id === `${baseDeviceId}_slot_0`))
    if (slotZero) return slotZero
  }
  return rows[0] ?? null
}

function getPrivateShareLabel(share: PrivateShareState, fallbackIndex = 0): string {
  if (Number.isInteger(share?.slot_index)) return `Slot ${(share?.slot_index ?? 0) + 1}`
  return `Slot ${fallbackIndex + 1}`
}

function mapSlotLimits(rows: SlotLimitEntry[] | null | undefined): Record<string, SlotLimitEntry> {
  const mapped: Record<string, SlotLimitEntry> = {}
  for (const row of rows ?? []) {
    if (!row?.device_id) continue
    mapped[row.device_id] = preferLatestSync(mapped[row.device_id], row) ?? row
  }
  return mapped
}

export default function Dashboard() {
  const router = useRouter()
  const supabase = createClient()
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pendingShareTargetRef = useRef<boolean | null>(null)
  const desktopAuthTokenRef = useRef<DesktopAuthBundle | null>(null)
  // FIX: tracks the explicit user slot selection — survives polls and stale closures
  const userSelectedSlotRef = useRef<string | null>(null)
  const privateShareReqSeqRef = useRef(0)
  // Pending edits: user changes that haven't been saved yet.
  // Polls skip overwriting these fields until the edit is saved or expires (30s).
  const pendingEditsRef = useRef<{
    expiryHours?: { value: string; ts: number }
    selectedSlotDeviceId?: { value: string; ts: number }
  }>({})

  const PENDING_EDIT_TTL = 30_000

  function setPendingEdit<K extends keyof typeof pendingEditsRef.current>(
    key: K,
    value: NonNullable<typeof pendingEditsRef.current[K]>['value'],
  ) {
    pendingEditsRef.current = { ...pendingEditsRef.current, [key]: { value, ts: Date.now() } }
  }

  function clearPendingEdit(key: keyof typeof pendingEditsRef.current) {
    const next = { ...pendingEditsRef.current }
    delete next[key]
    pendingEditsRef.current = next
  }

  function getPendingEdit<K extends keyof typeof pendingEditsRef.current>(
    key: K,
  ): NonNullable<typeof pendingEditsRef.current[K]>['value'] | null {
    const entry = pendingEditsRef.current[key]
    if (!entry) return null
    if (Date.now() - entry.ts > PENDING_EDIT_TTL) {
      clearPendingEdit(key)
      return null
    }
    return entry.value as NonNullable<typeof pendingEditsRef.current[K]>['value']
  }

  const [profile, setProfile] = useState<Profile | null>(null)
  const [peerCounts, setPeerCounts] = useState<Record<string, number>>({})
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null)
  const [isSharing, setIsSharing] = useState(false)
  const [desktop, setDesktop] = useState<DesktopState | null>(null)
  const [desktopChecked, setDesktopChecked] = useState(false)
  const [sharingStats, setSharingStats] = useState({ bytesServed: 0, requestsHandled: 0 })
  const [connecting, setConnecting] = useState(false)
  const [shareToggling, setShareToggling] = useState(false)
  const [shareTarget, setShareTarget] = useState<boolean | null>(null)
  const [showDisclosure, setShowDisclosure] = useState(false)
  const [privateCodeInput, setPrivateCodeInput] = useState('')
  const [privateShare, setPrivateShare] = useState<PrivateShareState>(null)
  const [privateShares, setPrivateShares] = useState<PrivateShare[]>([])
  const [privateShareDeviceId, setPrivateShareDeviceId] = useState<string | null>(null)
  const [privateExpiryHours, setPrivateExpiryHours] = useState('none')
  const [savedPrivateExpiryHours, setSavedPrivateExpiryHours] = useState('none')
  const [privateShareSaving, setPrivateShareSaving] = useState(false)
  const [privateShareAction, setPrivateShareAction] = useState<'toggle' | 'refresh' | null>(null)
  const [slotUpdating, setSlotUpdating] = useState(false)
  const [dailyLimitInput, setDailyLimitInput] = useState('')
  const [dailyLimitSaving, setDailyLimitSaving] = useState(false)
  const [dailyLimitError, setDailyLimitError] = useState<string | null>(null)
  const [slotLimits, setSlotLimits] = useState<Record<string, SlotLimitEntry>>({})
  const [slotDailyLimitInput, setSlotDailyLimitInput] = useState('')
  const [slotDailyLimitSaving, setSlotDailyLimitSaving] = useState(false)
  const [slotDailyLimitError, setSlotDailyLimitError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [shareError, setShareError] = useState<string | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [roleSaving, setRoleSaving] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [isOnline, setIsOnline] = useState(true)
  const [latestDesktopVersion, setLatestDesktopVersion] = useState<string | null>(null)
  const [latestExtVersion, setLatestExtVersion] = useState<string | null>(null)
  const [latestCliVersion, setLatestCliVersion] = useState<string | null>(null)
  const [extInstalled, setExtInstalled] = useState(false)
  const [extVersion, setExtVersion] = useState<string | null>(null)
  const [showCliDocs, setShowCliDocs] = useState(false)
  const [cliDocTab, setCliDocTab] = useState<'windows' | 'mac' | 'linux'>('windows')
  const [isMobile, setIsMobile] = useState(false)

  // ── Countries from DB ──────────────────────────────────────────────────────
  const [countries, setCountries] = useState<Country[]>([])
  const [countriesPage, setCountriesPage] = useState(1)
  const [countriesTotalPages, setCountriesTotalPages] = useState(1)
  const [countriesLoading, setCountriesLoading] = useState(false)
  const [countriesError, setCountriesError] = useState(false)
  const [countriesSearch, setCountriesSearch] = useState('')
  const countriesSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('privateCode') ?? params.get('private') ?? params.get('code')
    const normalized = code?.trim() ?? ''
    if (/^\d{9}$/.test(normalized)) {
      setPrivateCodeInput(normalized)
      setSelectedCountry(null)
    }
  }, [])

  const loadCountries = useCallback(async (page: number, search: string) => {
    setCountriesLoading(true)
    setCountriesError(false)
    try {
      const qs = new URLSearchParams({ page: String(page), limit: String(COUNTRIES_PAGE_SIZE) })
      if (search) qs.set('q', search)
      const res = await fetch(`/api/countries?${qs}`)
      if (!res.ok) throw new Error('failed')
      const data = await res.json()
      setCountries(data.countries ?? [])
      setCountriesTotalPages(data.pages ?? 1)
      setCountriesPage(page)
      if (page === 1 && !search && data.detectedCountry && !selectedCountry) {
        // auto-select removed — let user choose their own country
      }
    } catch {
      setCountriesError(true)
    } finally {
      setCountriesLoading(false)
    }
  }, [selectedCountry])

  // Country availability is loaded once on entry; subsequent updates are user-driven.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadCountries(1, '') }, [])

  const getDesktopAuthToken = useCallback(async () => {
    if (desktopAuthTokenRef.current) return desktopAuthTokenRef.current
    const response = await fetch('/api/device-token', { signal: AbortSignal.timeout(5000) })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || !data.token || !data.refreshToken || !data.deviceSessionId) {
      throw new Error(data.error ?? 'Could not issue a desktop auth token')
    }
    desktopAuthTokenRef.current = {
      token: data.token as string,
      refreshToken: data.refreshToken as string,
      deviceSessionId: data.deviceSessionId as string,
    }
    return desktopAuthTokenRef.current
  }, [])

  // ── Mobile detection ────────────────────────────────────────────────────────
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // ── Network status ──────────────────────────────────────────────────────────
  useEffect(() => {
    const onOnline = () => setIsOnline(true)
    const onOffline = () => setIsOnline(false)
    setIsOnline(navigator.onLine)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline) }
  }, [])

  // ── Load profile ────────────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      try {
        // Use getSession first to avoid throwing on missing session
        const { data: { session }, error: sessionError } = await withTimeout(
          supabase.auth.getSession(),
          8000,
          'Could not verify session - please refresh',
        )
        if (sessionError) throw new Error('Could not verify session – please refresh')
        if (!session) {
          setLoading(false)
          router.replace('/auth?mode=login')
          return
        }

        const user = session.user
        if (!user.email_confirmed_at) {
          setLoading(false)
          router.replace('/auth/confirm-email')
          return
        }

        const { data, error: profileError } = await withTimeout(
          supabase.from('profiles').select(PROFILE_SELECT_FIELDS).eq('id', user.id).single<Profile>(),
          10000,
          'Could not load your profile - please refresh',
        )
        if (profileError) throw new Error('Could not load your profile – please refresh')
        const nextProfile = data

        setProfile(nextProfile)
        setLoading(false)

        fetch('/api/version').then(r => r.json()).then(v => {
          setLatestDesktopVersion(v.desktop ?? null)
          setLatestExtVersion(v.extension ?? null)
          setLatestCliVersion(v.cli ?? null)
        }).catch(() => {})

        const dt = await checkDesktop()
        const desktopState = applyDesktopSnapshot(dt, user.id)
        setDesktopChecked(true)
        startPolling()

        if (dt.available) {
          if (desktopState.desktopOwnedByOther) {
            setShareError(getHelperMismatchError(dt.where))
          } else {
            const authResult = await syncDesktopAuth({
              ...(await getDesktopAuthToken()),
              userId: user.id,
              country: nextProfile.country_code,
              trust: nextProfile.trust_score,
            })
            if (!authResult.ok && authResult.error) {
              setShareError(authResult.error)
            }
            setShareError(prev => prev != null && prev.includes('signed in as a different user') ? null : prev)
          }
        } else if (nextProfile.is_sharing) {
          const shareStateResponse = await fetch('/api/user/sharing', {
            method: 'POST',
            headers: DASHBOARD_SHARING_HEADERS,
            body: JSON.stringify({ isSharing: false }),
          }).catch(() => {})
          const shareStateData = await shareStateResponse?.json?.().catch(() => null)
          if (shareStateData?.profile_sync) {
            setProfile(current => mergeProfileSync(current, shareStateData.profile_sync, { is_sharing: false }))
          }
        }
      } catch (err: unknown) {
        setLoadError(err instanceof Error ? err.message : 'Something went wrong – please refresh')
        setLoading(false)
      }
    }
    load()
    return () => stopPolling()
  // Initial dashboard bootstrap intentionally runs once and manages its own async lifecycle.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Extension detection ─────────────────────────────────────────────────────
  useEffect(() => {
    const syncExtensionMarker = () => {
      const el = document.documentElement
      const installed = !!el?.dataset.peermeshExtension
      setExtInstalled(installed)
      setExtVersion(installed ? (el.dataset.extVersion ?? null) : null)
    }

    syncExtensionMarker()

    const root = document.documentElement
    const observer = root
      ? new MutationObserver(() => syncExtensionMarker())
      : null

    if (root) {
      observer?.observe(root, {
        attributes: true,
        attributeFilter: ['data-peermesh-extension', 'data-ext-version'],
      })
    }

    window.addEventListener('focus', syncExtensionMarker)
    window.addEventListener('pageshow', syncExtensionMarker)
    document.addEventListener('visibilitychange', syncExtensionMarker)

    return () => {
      observer?.disconnect()
      window.removeEventListener('focus', syncExtensionMarker)
      window.removeEventListener('pageshow', syncExtensionMarker)
      document.removeEventListener('visibilitychange', syncExtensionMarker)
    }
  }, [])

  // ── Load peer counts ────────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/peers/available')
      .then(r => r.json())
      .then(({ peers }: { peers: PeerAvailability[] }) => {
        const counts: Record<string, number> = {}
        peers.forEach(p => { counts[p.country] = p.count })
        setPeerCounts(counts)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    setDailyLimitInput(profile?.daily_share_limit_mb != null ? String(profile.daily_share_limit_mb) : '')
  }, [profile?.daily_share_limit_mb])

  useEffect(() => {
    const selectedDeviceId = privateShareDeviceId ?? privateShare?.device_id ?? null
    const selected = selectedDeviceId ? slotLimits[selectedDeviceId] : null
    setSlotDailyLimitInput(selected?.daily_limit_mb != null ? String(selected.daily_limit_mb) : '')
  }, [privateShareDeviceId, privateShare?.device_id, slotLimits])

  useEffect(() => {
    const baseDeviceId = isDesktopOwnedByUser(desktop, profile?.id)
      ? (desktop?.baseDeviceId ?? desktop?.peer?.baseDeviceId ?? null)
      : null
    log('useEffect[desktop/profile]',
      'baseDeviceId=' + (baseDeviceId ?? 'null'),
      'desktop.baseDeviceId=' + (desktop?.baseDeviceId ?? 'null'),
      'desktop.peer.baseDeviceId=' + (desktop?.peer?.baseDeviceId ?? 'null'),
      'desktop.userId=' + (desktop?.userId ?? 'null'),
      'profile.id=' + (profile?.id ?? 'null'),
      'userSelectedSlotRef=' + (userSelectedSlotRef.current ?? 'null'),
    )
    if (!profile || !baseDeviceId) {
      log('useEffect[desktop/profile] CLEARING', 'reason=' + (!profile ? 'no profile' : 'no baseDeviceId'))
      setPrivateShare(null)
      setPrivateShares([])
      setPrivateShareDeviceId(null)
      userSelectedSlotRef.current = null
      pendingEditsRef.current = {}
      return
    }
    loadPrivateShare(baseDeviceId).catch(() => {})
  // Private-share sync is keyed to the currently active helper identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id, desktop?.baseDeviceId, desktop?.peer?.baseDeviceId, desktop?.userId])

  // ── Poll desktop state + refresh profile ────────────────────────────────────
  const applyDesktopSnapshot = useCallback((dt: DesktopState, userId: string | null | undefined) => {
    setDesktop(dt)

    const desktopOwnedByOther = !isDesktopOwnedByUser(dt, userId)
    if (desktopOwnedByOther) {
      pendingShareTargetRef.current = null
      setShareTarget(null)
      setShareToggling(false)
      setIsSharing(false)
      return { desktopOwnedByOther, helperSharing: false }
    }

    if (dt.stats) {
      setSharingStats({
        bytesServed: dt.stats.bytesServed,
        requestsHandled: dt.stats.requestsHandled,
      })
    }

    const helperSharing = isDesktopSharing(dt)
    if (pendingShareTargetRef.current !== null && helperSharing !== pendingShareTargetRef.current) {
      return { desktopOwnedByOther: false, helperSharing }
    }

    if (pendingShareTargetRef.current !== null) {
      pendingShareTargetRef.current = null
      setShareTarget(null)
      setShareToggling(false)
    }

    setIsSharing(helperSharing)
    return { desktopOwnedByOther: false, helperSharing }
  }, [])

  function startPolling() {
    if (pollRef.current) return
    let tick = 0
    pollRef.current = setInterval(async () => {
      tick++
      const dt = await checkDesktop()
      const currentBaseDeviceId = dt.baseDeviceId ?? dt.peer?.baseDeviceId ?? null
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user ?? null
      const desktopOwnedByOther = dt.available && dt.userId && user && dt.userId !== user.id
      if (dt.available && !desktopOwnedByOther) {
        const wasStarting = desktop?.shareEnabled && !desktop?.running
        applyDesktopSnapshot(dt, user?.id ?? null)
        // Detect unexpected stop: was starting/sharing, now stopped with no error
        if (wasStarting && !dt.running && !dt.shareEnabled) {
          setShareError('Sharing stopped — your account may need phone verification or a role change. Check the desktop app for details.')
        }
        setShareError(prev => prev != null && prev.includes('signed in as a different user') ? null : prev)
      } else {
        setDesktop(dt)
        pendingShareTargetRef.current = null
        setShareTarget(null)
        setShareToggling(false)
        setIsSharing(false)
        if (desktopOwnedByOther) setShareError(getHelperMismatchError(dt.where))
        else setShareError(prev => prev != null && prev.includes('signed in as a different user') ? null : prev)
      }
      if (tick % 3 === 0 && user) {
        const { data } = await supabase.from('profiles').select(PROFILE_SELECT_FIELDS).eq('id', user.id).single<Profile>()
        if (data) setProfile(data)
      }
      if (tick % 10 === 0) {
        fetch('/api/peers/available')
          .then(r => r.json())
          .then(({ peers }: { peers: PeerAvailability[] }) => {
            const counts: Record<string, number> = {}
            peers.forEach(p => { counts[p.country] = p.count })
            setPeerCounts(counts)
          })
          .catch(() => {})
      }
      if (tick % 2 === 0) {
        if (currentBaseDeviceId && !desktopOwnedByOther) {
          log('poll LOAD PRIVATE SHARE',
            'tick=' + tick,
            'baseDeviceId=' + currentBaseDeviceId,
            'userSelectedSlotRef=' + (userSelectedSlotRef.current ?? 'null'),
          )
          loadPrivateShare(currentBaseDeviceId, dt).catch(() => {})
        } else {
          log('poll CLEAR PRIVATE SHARE',
            'tick=' + tick,
            'currentBaseDeviceId=' + (currentBaseDeviceId ?? 'null'),
            'desktopOwnedByOther=' + String(!!desktopOwnedByOther),
          )
          setPrivateShare(null)
          setPrivateShares([])
          setPrivateShareDeviceId(null)
          setSlotLimits({})
        }
      }
    }, 3000)
  }

  function stopPolling() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  // FIX: userSelectedSlotRef.current is the highest-priority selection signal.
  // It is set explicitly by the user and survives stale closures in polling.
  // We only update privateShareDeviceId state when no explicit user selection is active.
  function applyPrivateShareRows(rows: PrivateShare[], baseDeviceId: string, preferredDeviceId?: string | null, desktopState: DesktopState | null = desktop) {
    const merged = mergePrivateShares(rows, baseDeviceId, desktopState)

    const resolvedBy = userSelectedSlotRef.current ? 'userSelectedSlotRef'
      : preferredDeviceId ? 'preferredDeviceId'
      : desktopState?.privateShareDeviceId ? 'desktopState.privateShareDeviceId'
      : desktopState?.peer?.privateShareDeviceId ? 'desktopState.peer.privateShareDeviceId'
      : 'fallback/first'

    log('applyPrivateShareRows',
      'baseDeviceId=' + baseDeviceId,
      'rows=' + rows.length,
      'merged=' + merged.length,
      'mergedIds=' + merged.map(s => s.device_id + '[' + (s.enabled ? 'ON' : 'off') + (s.active ? '+ACTIVE' : '') + ']').join(','),
      'userSelectedSlotRef=' + (userSelectedSlotRef.current ?? 'null'),
      'preferredDeviceId=' + (preferredDeviceId ?? 'null'),
      'desktopState.privateShareDeviceId=' + (desktopState?.privateShareDeviceId ?? 'null'),
      'desktopState.peer.privateShareDeviceId=' + (desktopState?.peer?.privateShareDeviceId ?? 'null'),
      'resolvedBy=' + resolvedBy,
      'desktopState.connectionSlots=' + (desktopState?.connectionSlots ?? 'null'),
      'desktopState.slots.configured=' + (desktopState?.slots?.configured ?? 'null'),
      'desktopState.peer.connectionSlots=' + (desktopState?.peer?.connectionSlots ?? 'null'),
      'desktopState.peer.slots.configured=' + (desktopState?.peer?.slots?.configured ?? 'null'),
    )

    const requestedDeviceId = userSelectedSlotRef.current
      ?? getPendingEdit('selectedSlotDeviceId')
      ?? preferredDeviceId
      ?? desktopState?.privateShareDeviceId
      ?? desktopState?.peer?.privateShareDeviceId
      ?? null
    const requestedSelectionStillExists = requestedDeviceId
      ? merged.some((share) => share.device_id === requestedDeviceId)
      : false
    const nextSelected = selectPrivateShare(
      merged,
      requestedDeviceId,
      baseDeviceId,
    )
    const resolvedDeviceId = nextSelected?.device_id ?? preferredDeviceId ?? null
    const resetUserSelectedSlot = !!userSelectedSlotRef.current && !requestedSelectionStillExists

    log('applyPrivateShareRows SELECTED',
      'nextSelected.device_id=' + (nextSelected?.device_id ?? 'null'),
      'nextSelected.slot_index=' + (nextSelected?.slot_index ?? 'null'),
      'nextSelected.enabled=' + (nextSelected?.enabled ?? 'null'),
      'nextSelected.active=' + (nextSelected?.active ?? 'null'),
      'requestedDeviceId=' + (requestedDeviceId ?? 'null'),
      'requestedSelectionStillExists=' + String(requestedSelectionStillExists),
      'willResetUserSelectedSlot=' + String(resetUserSelectedSlot),
    )

    setPrivateShares(merged)
    setPrivateShare(nextSelected)
    if (resetUserSelectedSlot) {
      userSelectedSlotRef.current = resolvedDeviceId
    }
    setPrivateShareDeviceId(userSelectedSlotRef.current ?? resolvedDeviceId)

    // Only update expiry display if user has no pending (unsaved) expiry edit
    const pendingExpiry = getPendingEdit('expiryHours')
    if (!pendingExpiry) {
      const preset = getExpiryPreset(nextSelected?.expires_at ?? null)
      setPrivateExpiryHours(preset)
      setSavedPrivateExpiryHours(preset)
    }
    
    log('applyPrivateShareRows AFTER STATE UPDATE',
      'privateShare.device_id=' + (nextSelected?.device_id ?? 'null'),
      'privateShare.code=' + (nextSelected?.code || 'EMPTY'),
      'privateShare.enabled=' + (nextSelected?.enabled ?? 'null'),
      'privateShare.active=' + (nextSelected?.active ?? 'null'),
    )
  }

  async function loadPrivateShare(baseDeviceId: string, desktopState: DesktopState | null = null) {
    const requestSeq = ++privateShareReqSeqRef.current
    const effectiveDesktopState = desktopState ?? desktop
    log('loadPrivateShare START', 'baseDeviceId=' + baseDeviceId, 'userSelectedSlotRef=' + (userSelectedSlotRef.current ?? 'null'))
    const res = await fetch(`/api/user/sharing?baseDeviceId=${encodeURIComponent(baseDeviceId)}`, {
      headers: { 'x-peermesh-actor': 'dashboard' },
    })
    if (!res.ok) throw new Error('Could not load private sharing state')
    const data = await res.json()
    if (requestSeq !== privateShareReqSeqRef.current) {
      log('loadPrivateShare STALE_RESPONSE', 'requestSeq=' + requestSeq, 'latest=' + privateShareReqSeqRef.current)
      return
    }
    const apiShares: PrivateShare[] = data.private_shares ?? (data.private_share ? [data.private_share] : [])
    const apiSlotLimits: SlotLimitEntry[] = data.slot_limits ?? []
    log('loadPrivateShare API RESPONSE',
      'private_shares.length=' + apiShares.length,
      'ids=' + apiShares.map((s: PrivateShare) => s.device_id + '[enabled=' + s.enabled + ',active=' + s.active + ',slot=' + s.slot_index + ',code=' + (s.code || 'EMPTY') + ']').join(','),
      'primary_device_id=' + (data.private_share?.device_id ?? 'null'),
      'primary_code=' + (data.private_share?.code ?? 'null'),
      'slot_limits.length=' + apiSlotLimits.length,
    )
    setSlotLimits(mapSlotLimits(apiSlotLimits))
    applyPrivateShareRows(
      apiShares,
      baseDeviceId,
      data.private_share?.device_id ?? null,
      effectiveDesktopState,
    )
  }

  async function savePrivateShare(input: { enabled?: boolean; refresh?: boolean; expiryHours?: string }) {
    privateShareReqSeqRef.current += 1
    if (profile && !isDesktopOwnedByUser(desktop, profile.id)) {
      setShareError(getHelperMismatchError(desktop?.where))
      return
    }
    const baseDeviceId = desktop?.baseDeviceId ?? desktop?.peer?.baseDeviceId ?? null
    if (!baseDeviceId) {
      setShareError('A local desktop app or CLI device is required to manage private sharing')
      return
    }
    const targetDeviceId = privateShareDeviceId ?? privateShare?.device_id ?? `${baseDeviceId}_slot_0`
    log('savePrivateShare START',
      'targetDeviceId=' + targetDeviceId,
      'baseDeviceId=' + baseDeviceId,
      'enabled=' + (input.enabled ?? 'undefined'),
      'refresh=' + (input.refresh ?? false),
      'expiryHours=' + (input.expiryHours ?? 'undefined'),
      'userSelectedSlotRef=' + (userSelectedSlotRef.current ?? 'null'),
      'privateShareDeviceId_state=' + (privateShareDeviceId ?? 'null'),
      'privateShare.device_id=' + (privateShare?.device_id ?? 'null'),
    )
    setPrivateShareAction(input.refresh === true ? 'refresh' : 'toggle')
    setPrivateShareSaving(true)
    setShareError(null)
    try {
      const expiryHours = input.expiryHours === undefined
        ? undefined
        : (input.expiryHours === 'none' ? null : Number.parseInt(input.expiryHours, 10))
      const res = await fetch('/api/user/sharing', {
        method: 'POST',
        headers: DASHBOARD_SHARING_HEADERS,
        body: JSON.stringify({
          privateSharing: {
            deviceId: targetDeviceId,
            baseDeviceId,
            enabled: input.enabled,
            refresh: input.refresh === true,
            expiryHours,
          },
        }),
      })
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error ?? 'Could not update private sharing')

      const returnedId = data.private_share?.device_id ?? targetDeviceId
      const apiShares: PrivateShare[] = data.private_shares ?? (data.private_share ? [data.private_share] : [])
      log('savePrivateShare RESPONSE',
        'returnedId=' + returnedId,
        'private_shares.length=' + apiShares.length,
        'ids=' + apiShares.map((s: PrivateShare) => s.device_id + '[enabled=' + s.enabled + ',active=' + s.active + ',slot=' + s.slot_index + ']').join(','),
      )

      if (returnedId) {
        log('savePrivateShare SET REF', 'userSelectedSlotRef=' + returnedId)
        userSelectedSlotRef.current = returnedId
        setPrivateShareDeviceId(returnedId)
        clearPendingEdit('selectedSlotDeviceId')
      }

      setSlotLimits(mapSlotLimits(data.slot_limits ?? []))
      applyPrivateShareRows(apiShares, baseDeviceId, returnedId)
      if (input.expiryHours !== undefined && data.private_share) {
        setPrivateExpiryHours(input.expiryHours)
        setSavedPrivateExpiryHours(input.expiryHours)
        clearPendingEdit('expiryHours')
      }
    } catch (err: unknown) {
      log('savePrivateShare ERROR', String(err))
      setShareError(err instanceof Error ? err.message : 'Could not update private sharing')
    } finally {
      setPrivateShareSaving(false)
      setPrivateShareAction(null)
    }
  }

  async function updateConnectionSlots(nextSlots: number) {
    if (slotUpdating) return
    if (profile && !isDesktopOwnedByUser(desktop, profile.id)) {
      setShareError(getHelperMismatchError(desktop?.where))
      return
    }
    if (!desktopAvailable && !cliRunning && !desktopRunning) {
      setShareError('Desktop or CLI not running. Start a local helper before changing connection slots.')
      return
    }
    setSlotUpdating(true)
    setShareError(null)
    try {
      const result = await setDesktopConnectionSlots(nextSlots, { actor: 'dashboard' })
      if (!result.ok || !result.state) throw new Error(result.error ?? 'Could not update connection slots')
      applyDesktopSnapshot(result.state, profile?.id ?? null)
      const baseDeviceId = result.state.baseDeviceId ?? result.state.peer?.baseDeviceId ?? null
      if (baseDeviceId) await loadPrivateShare(baseDeviceId, result.state)
    } catch (err: unknown) {
      setShareError(err instanceof Error ? err.message : 'Could not update connection slots')
    } finally {
      setSlotUpdating(false)
    }
  }

  async function saveDailyLimit(nextLimitMb: number | null) {
    if (dailyLimitSaving) return
    if (profile && !isDesktopOwnedByUser(desktop, profile.id)) {
      setDailyLimitError(getHelperMismatchError(desktop?.where))
      return
    }
    if (nextLimitMb !== null && nextLimitMb < DAILY_LIMIT_MIN_MB) {
      setDailyLimitError(`Minimum daily limit is ${DAILY_LIMIT_MIN_MB} MB (1 GB)`)
      return
    }
    setDailyLimitSaving(true)
    setDailyLimitError(null)
    try {
      const res = await fetch('/api/user/sharing', {
        method: 'POST',
        headers: DASHBOARD_SHARING_HEADERS,
        body: JSON.stringify({ dailyLimitMb: nextLimitMb }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.error) throw new Error(data.error ?? 'Could not update daily limit')
      const savedLimit = data.daily_share_limit_mb ?? null
      setProfile(current => mergeProfileSync(current, data.profile_sync ?? null, { daily_share_limit_mb: savedLimit }))
      setDailyLimitInput(savedLimit != null ? String(savedLimit) : '')
    } catch (err: unknown) {
      setDailyLimitError(err instanceof Error ? err.message : 'Could not update daily limit')
    } finally {
      setDailyLimitSaving(false)
    }
  }

  async function saveSlotDailyLimit(nextLimitMb: number | null) {
    if (slotDailyLimitSaving) return
    if (profile && !isDesktopOwnedByUser(desktop, profile.id)) {
      setSlotDailyLimitError(getHelperMismatchError(desktop?.where))
      return
    }
    if (nextLimitMb !== null && nextLimitMb < DAILY_LIMIT_MIN_MB) {
      setSlotDailyLimitError(`Minimum slot limit is ${DAILY_LIMIT_MIN_MB} MB (1 GB)`)
      return
    }

    const baseDeviceId = desktop?.baseDeviceId ?? desktop?.peer?.baseDeviceId ?? null
    const slotDeviceId = privateShareDeviceId ?? privateShare?.device_id ?? (baseDeviceId ? `${baseDeviceId}_slot_0` : null)
    if (!baseDeviceId || !slotDeviceId) {
      setSlotDailyLimitError('Select an active slot to configure a per-slot limit.')
      return
    }

    setSlotDailyLimitSaving(true)
    setSlotDailyLimitError(null)
    try {
      const res = await fetch('/api/user/sharing', {
        method: 'POST',
        headers: DASHBOARD_SHARING_HEADERS,
        body: JSON.stringify({
          slotDailyLimitMb: nextLimitMb,
          slotDeviceId,
          baseDeviceId,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.error) throw new Error(data.error ?? 'Could not update slot daily limit')
      const mapped = mapSlotLimits(data.slot_limits ?? [])
      setSlotLimits(mapped)
      const savedLimit = mapped[slotDeviceId]?.daily_limit_mb ?? null
      setSlotDailyLimitInput(savedLimit != null ? String(savedLimit) : '')
    } catch (err: unknown) {
      setSlotDailyLimitError(err instanceof Error ? err.message : 'Could not update slot daily limit')
    } finally {
      setSlotDailyLimitSaving(false)
    }
  }

  // ── Share toggle ────────────────────────────────────────────────────────────
  async function handleShareToggle() {
    if (!profile || shareToggling) return
    if (!isDesktopOwnedByUser(desktop, profile.id)) {
      setShareError(getHelperMismatchError(desktop?.where))
      return
    }
    setShareError(null)

    // Already starting (shareEnabled=true but not yet running) — ignore
    if (!isSharing && desktop?.shareEnabled) return

    if (isSharing) {
      pendingShareTargetRef.current = false
      setShareTarget(false)
      setShareToggling(true)
      const result = await stopDesktopSharing()
      if (result.state) applyDesktopSnapshot(result.state, profile.id)
      const shareStateResponse = await fetch('/api/user/sharing', {
        method: 'POST',
        headers: DASHBOARD_SHARING_HEADERS,
        body: JSON.stringify({ isSharing: false }),
      }).catch(() => {})
      const shareStateData = await shareStateResponse?.json?.().catch(() => null)
      if (shareStateData?.profile_sync) {
        setProfile(current => mergeProfileSync(current, shareStateData.profile_sync, { is_sharing: false }))
      }
      if (!result.ok) {
        pendingShareTargetRef.current = null
        setShareTarget(null)
        setShareToggling(false)
        setIsSharing(true)
        setShareError('Could not stop sharing')
      }
      return
    }

    if (!profile.has_accepted_provider_terms) {
      setShowDisclosure(true)
      return
    }

    await startSharing()
  }

  async function startSharing() {
    setShareToggling(true)
    setShareError(null)

    // Safety: always clear shareToggling after 15s regardless
    const safetyTimer = setTimeout(() => {
      pendingShareTargetRef.current = null
      setShareTarget(null)
      setShareToggling(false)
    }, 15000)

    try {
      if (!navigator.onLine) {
        setShareError('No internet connection – check your network and try again')
        return
      }

      const dt = await checkDesktop()
      setDesktop(dt)

      if (!dt.available) {
        setShareError('desktop_required')
        return
      }
      if (!isDesktopOwnedByUser(dt, profile!.id)) {
        setShareError(getHelperMismatchError(dt.where))
        return
      }

      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        setShareError('Session expired – please sign out and sign back in')
        return
      }

      pendingShareTargetRef.current = true
      setShareTarget(true)
      const result = await startDesktopSharing({
        ...(await getDesktopAuthToken()),
        userId: profile!.id,
        country: profile!.country_code,
        trust: profile!.trust_score,
      })

      if (!result.ok) {
        pendingShareTargetRef.current = null
        setShareTarget(null)
        setShareError(result.error ?? 'desktop_required')
        setShareToggling(false)
        return
      }

      if (result.state) {
        applyDesktopSnapshot(result.state, profile!.id)
      } else {
        pendingShareTargetRef.current = null
        setShareTarget(null)
        setIsSharing(true)
        setShareToggling(false)
      }
      const shareStateResponse = await fetch('/api/user/sharing', {
        method: 'POST',
        headers: DASHBOARD_SHARING_HEADERS,
        body: JSON.stringify({ isSharing: true }),
      }).catch(() => {})
      const shareStateData = await shareStateResponse?.json?.().catch(() => null)
      if (shareStateData?.profile_sync) {
        setProfile(current => mergeProfileSync(current, shareStateData.profile_sync, { is_sharing: true }))
      }
    } catch {
      pendingShareTargetRef.current = null
      setShareTarget(null)
      setShareToggling(false)
    } finally {
      clearTimeout(safetyTimer)
    }
  }

  // ── Connect ─────────────────────────────────────────────────────────────────
  async function handleConnect() {
    const trimmedPrivateCode = privateCodeInput.trim()
    const isPrivateConnect = !selectedCountry && !!trimmedPrivateCode
    if ((!selectedCountry && !trimmedPrivateCode) || !profile) return
    setConnectError(null)
    if (profile.role === 'host') {
      setConnectError('Host accounts can only share. Switch role to Peer or Client to connect.')
      return
    }
    if (!profile.is_verified) {
      router.push('/verify/phone')
      return
    }
    if (!isPrivateConnect && !hasPaidAccess && !displayIsSharing) {
      router.push('/developers/billing')
      return
    }
    if (!navigator.onLine) {
      setConnectError('No internet connection – check your network and try again')
      return
    }
    setConnecting(true)
    try {
      let lastQueuedMessage: string | null = null
      for (let attempt = 0; attempt < (isPrivateConnect ? 4 : 1); attempt += 1) {
        const res = await fetch('/api/session/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(isPrivateConnect ? { privateCode: trimmedPrivateCode } : { country: selectedCountry }),
        })
        const data = await res.json()
        if ((!res.ok || data.error) && data.nextStep) {
          router.push(data.nextStep)
          return
        }
        if (!res.ok || data.error) {
          if (isPrivateConnect && data.onDemandStartQueued && attempt < 3) {
            lastQueuedMessage = data.error ?? 'Provider is starting. Retrying...'
            setConnectError(lastQueuedMessage)
            const retryMs = Math.max(3000, Math.min(10000, Number(data.retryAfterSeconds ?? 5) * 1000))
            await new Promise(resolve => setTimeout(resolve, retryMs))
            continue
          }
          throw new Error(data.error ?? `Server error (${res.status})`)
        }
        const targetCountry = data.country ?? selectedCountry
        const fallback = (data.relayFallbackList ?? [data.relayEndpoint]).join(',')
        router.push(`/browse?relay=${encodeURIComponent(data.relayEndpoint)}&relayFallback=${encodeURIComponent(fallback)}&country=${encodeURIComponent(targetCountry)}&userId=${profile.id}&dbSessionId=${data.sessionId}&preferredProviderUserId=${encodeURIComponent(data.preferredProviderUserId ?? '')}&privateProviderUserId=${encodeURIComponent(data.privateProviderUserId ?? '')}&privateBaseDeviceId=${encodeURIComponent(data.privateBaseDeviceId ?? '')}&connectionType=${isPrivateConnect ? 'private' : 'public'}`)
        return
      }
      throw new Error(lastQueuedMessage ?? 'Private provider did not come online in time. Try again shortly.')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not connect'
      setConnectError(msg === 'Failed to fetch' ? 'Network error – could not reach server' : msg)
    } finally {
      setConnecting(false)
    }
  }

  async function updateRole(nextRole: 'peer' | 'host' | 'client') {
    if (!profile || roleSaving || nextRole === profile.role) return
    setRoleSaving(true)
    setConnectError(null)
    setShareError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token ?? null
      const res = await fetch('/api/account/role', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ role: nextRole }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? `Could not switch role (${res.status})`)
      setProfile(current => current ? { ...current, role: data.role } : current)
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Could not switch role')
    } finally {
      setRoleSaving(false)
    }
  }

  async function handleSignOut() {
    if (!confirm('Sign out of PeerMesh?')) return
    setSigningOut(true)
    stopPolling()
    await stopDesktopSharing()
    await supabase.auth.signOut()
    router.push('/')
  }

  function dismissErrors() {
    setConnectError(null)
    setShareError(null)
  }

  if (loading) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
          <span style={{ display: 'inline-block', width: '20px', height: '20px', border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
          <div style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--muted)', fontSize: '11px', letterSpacing: '2px' }}>LOADING...</div>
        </div>
      </main>
    )
  }

  if (loadError) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <div style={{ textAlign: 'center', padding: '24px' }}>
          <div style={{ fontSize: '11px', color: '#ff6060', fontFamily: 'var(--font-geist-mono)', marginBottom: '16px', letterSpacing: '0.5px' }}>{loadError}</div>
          <button onClick={() => window.location.reload()} style={{ padding: '10px 20px', background: 'var(--accent)', color: '#000', border: 'none', borderRadius: '8px', fontFamily: 'var(--font-geist-mono)', fontSize: '11px', fontWeight: 700, cursor: 'pointer', letterSpacing: '0.5px' }}>RETRY</button>
        </div>
      </main>
    )
  }

  if (!profile) return null

  const bandwidthPct = profile.bandwidth_limit > 0
    ? Math.min(100, Math.max(profile.bandwidth_used_month > 0 ? 1 : 0, Math.round((profile.bandwidth_used_month / profile.bandwidth_limit) * 100)))
    : profile.bandwidth_used_month > 0 ? 100 : 0
  const desktopAvailable = desktop?.available ?? false
  const helperOwnedByCurrentUser = isDesktopOwnedByUser(desktop, profile.id)
  const desktopAvailableForUser = desktopAvailable && helperOwnedByCurrentUser
  const primaryWhere = desktop?.where ?? desktop?.source ?? null
  const isCLI = primaryWhere === 'cli'
  const isDesktopApp = primaryWhere === 'desktop'

  const peerWhere = desktop?.peer?.where ?? null

  const desktopProcessVersion = isDesktopApp ? desktop?.version : (peerWhere === 'desktop' ? desktop?.peer?.version : null)
  const cliProcessVersion = isCLI ? desktop?.version : (peerWhere === 'cli' ? desktop?.peer?.version : null)
  const desktopRunning = isDesktopApp || peerWhere === 'desktop'
  const cliRunning = isCLI || peerWhere === 'cli'
  const desktopRunningForUser = desktopRunning && helperOwnedByCurrentUser
  const cliRunningForUser = cliRunning && helperOwnedByCurrentUser

  const desktopUpdateAvailable = !!(desktopRunning && latestDesktopVersion && desktopProcessVersion && compareVersions(latestDesktopVersion, desktopProcessVersion) > 0)
  const cliUpdateAvailable = !!(cliRunning && latestCliVersion && cliProcessVersion && compareVersions(latestCliVersion, cliProcessVersion) > 0)
  const extUpdateAvailable = !!(extInstalled && latestExtVersion && extVersion && compareVersions(latestExtVersion, extVersion) > 0)
  const showExtBanner = !extInstalled || extUpdateAvailable
  const helperBaseDeviceId = helperOwnedByCurrentUser ? (desktop?.baseDeviceId ?? desktop?.peer?.baseDeviceId ?? null) : null
  const helperSlots = helperOwnedByCurrentUser ? (desktop?.slots ?? desktop?.peer?.slots ?? null) : null
  const slotDisplayCount = helperSlots?.configured ?? (helperOwnedByCurrentUser ? (desktop?.connectionSlots ?? desktop?.peer?.connectionSlots ?? 1) : 1)
  const slotDisplayActive = helperSlots?.active ?? 0
  const selectedSlotDeviceId = privateShareDeviceId ?? privateShare?.device_id ?? (helperBaseDeviceId ? `${helperBaseDeviceId}_slot_0` : null)
  const selectedSlotLimit = selectedSlotDeviceId ? slotLimits[selectedSlotDeviceId] : null
  const connectionSlotsSyncLabel = formatSyncLabel(desktop?.connectionSlotsSync ?? desktop?.peer?.connectionSlotsSync ?? null)
  const privateShareSyncLabel = formatSyncLabel(privateShare)
  const slotLimitSyncLabel = formatSyncLabel(selectedSlotLimit)
  const profileSyncLabel = formatSyncLabel(profile)
  const displayIsSharing = shareTarget ?? isSharing
  const helperStarting = isDesktopSharePending(desktop)
  const privateConnectReady = !selectedCountry && !!privateCodeInput.trim()
  const walletBalanceLabel = `$${Number(profile.wallet_balance_usd ?? 0).toFixed(2)}`
  const payoutBalanceLabel = `$${Number(profile.wallet_pending_payout_usd ?? 0).toFixed(2)}`
  const contributionCreditsLabel = formatBytes(Number(profile.contribution_credits_bytes ?? 0))
  const hasPaidAccess = profileHasPaidAccess(profile)

  const detectedOS: 'windows' | 'mac' | 'linux' = typeof navigator !== 'undefined'
    ? navigator.userAgent.includes('Win') ? 'windows'
      : navigator.userAgent.includes('Mac') ? 'mac'
      : 'linux'
    : 'linux'

  return (
    <main style={{ maxWidth: '680px', margin: '0 auto', width: '100%', padding: '24px 20px' }}>

      {/* Offline banner */}
      {!isOnline && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(255,170,0,0.08)', border: '1px solid rgba(255,170,0,0.4)', borderRadius: '10px', padding: '10px 14px', marginBottom: '16px' }}>
          <span style={{ fontSize: '16px' }}>⚠️</span>
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: '#ffaa00', letterSpacing: '0.5px' }}>NO INTERNET CONNECTION – features unavailable until reconnected</span>
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '28px' }}>
        <span style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--accent)', fontSize: '13px', letterSpacing: '4px' }}>PEERMESH</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {profile.is_premium && (
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', border: '1px solid var(--accent)', padding: '3px 8px', borderRadius: '4px', letterSpacing: '1px' }}>PREMIUM</span>
          )}
          {desktopChecked && !isMobile && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {[{ label: 'CLI', green: cliRunning }, { label: 'DSK', green: desktopRunning }]
                .filter(s => s.green || (!cliRunning && !desktopRunning))
                .map(s => (
                  <span key={s.label} style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: s.green ? 'var(--accent)' : '#ff6060', letterSpacing: '0.5px' }}>
                    {s.green ? '●' : '○'} {s.label}
                  </span>
                ))
              }
            </span>
          )}
          <span style={{ fontSize: '13px', color: 'var(--muted)' }}>{profile.username ?? 'user'}</span>
          <button onClick={handleSignOut} disabled={signingOut} style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--muted)', padding: '6px 12px', borderRadius: '6px', fontSize: '11px', cursor: signingOut ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-geist-mono)', opacity: signingOut ? 0.6 : 1 }}>{signingOut ? '...' : 'OUT'}</button>
        </div>
      </div>

      {/* Desktop update banner */}
      {!isMobile && desktopChecked && desktopRunning && desktopUpdateAvailable && (
        <a href="/api/desktop-download" download style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', background: 'rgba(0,255,136,0.05)', border: '1px solid rgba(0,255,136,0.3)', borderRadius: '12px', padding: '12px 16px', marginBottom: '16px', textDecoration: 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '18px' }}>⬆️</span>
            <div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '0.5px', marginBottom: '2px' }}>DESKTOP UPDATE AVAILABLE – v{latestDesktopVersion}</div>
              <div style={{ fontSize: '12px', color: 'var(--muted)' }}>You have v{desktopProcessVersion}. Download the latest for best performance.</div>
            </div>
          </div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', whiteSpace: 'nowrap', flexShrink: 0 }}>↓ UPDATE</div>
        </a>
      )}

      {/* Desktop install banner */}
      {!isMobile && desktopChecked && !desktopRunning && !cliRunning && (
        <a href="/api/desktop-download" download style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', background: 'rgba(255,80,80,0.07)', border: '1px solid rgba(255,80,80,0.3)', borderRadius: '12px', padding: '12px 16px', marginBottom: '16px', textDecoration: 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '18px' }}>🖥️</span>
            <div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: '#ff6060', letterSpacing: '0.5px', marginBottom: '2px' }}>DESKTOP OR CLI REQUIRED TO SHARE</div>
              <div style={{ fontSize: '12px', color: 'var(--muted)' }}>Install the desktop app or run <code style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px' }}>npx @btcmaster1000/peermesh-provider</code></div>
            </div>
          </div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: '#ff6060', whiteSpace: 'nowrap', flexShrink: 0 }}>↓ DESKTOP</div>
        </a>
      )}

      {/* Extension banner */}
      {!isMobile && showExtBanner && (
        <a
          href={extUpdateAvailable ? '/api/extension-download' : '/extension'}
          download={extUpdateAvailable ? 'peermesh-extension.zip' : undefined}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', background: 'var(--surface)', border: `1px solid ${extUpdateAvailable ? 'rgba(255,200,0,0.5)' : 'var(--accent)'}`, borderRadius: '12px', padding: '12px 16px', marginBottom: '16px', textDecoration: 'none' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '18px' }}>🧩</span>
            <div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: extUpdateAvailable ? '#ffc800' : 'var(--accent)', letterSpacing: '0.5px', marginBottom: '2px' }}>
                {extUpdateAvailable ? `UPDATE AVAILABLE – v${latestExtVersion}` : 'CHROME EXTENSION – RECOMMENDED'}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
                {extUpdateAvailable ? `You have v${extVersion}. Update for latest features.` : 'Routes your entire browser – YouTube, Google, Netflix all work'}
              </div>
            </div>
          </div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: extUpdateAvailable ? '#ffc800' : 'var(--accent)', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {extUpdateAvailable ? '↑ UPDATE ↑' : 'INSTALL →'}
          </div>
        </a>
      )}

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '20px' }}>
        {[
          { label: 'TRUST', value: String(profile.trust_score) },
          { label: 'SHARED', value: formatBytes(profile.total_bytes_shared + (isSharing ? sharingStats.bytesServed : 0)) },
          { label: 'USED', value: formatBytes(profile.total_bytes_used) },
        ].map(({ label, value }) => (
          <div key={label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '10px', padding: '14px', textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '18px', color: 'var(--accent)', marginBottom: '4px' }}>{value}</div>
            <div style={{ fontSize: '10px', color: 'var(--muted)', letterSpacing: '1px' }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Bandwidth */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '10px', padding: '14px', marginBottom: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '1px' }}>MONTHLY BANDWIDTH</span>
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--text)' }}>
            {formatBytes(profile.bandwidth_used_month)} / {formatBytes(profile.bandwidth_limit)}
          </span>
        </div>
        <div style={{ height: '5px', background: 'var(--border)', borderRadius: '3px', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${bandwidthPct}%`, background: bandwidthPct > 80 ? 'var(--danger)' : 'var(--accent)', borderRadius: '3px', transition: 'width 0.4s' }} />
        </div>
      </div>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '16px', marginBottom: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px', marginBottom: '6px' }}>ROLE</div>
            <div style={{ fontSize: '12px', color: 'var(--muted)', lineHeight: 1.6 }}>
              Peer shares and uses. Host shares only. Client uses only and cannot expose provider slots.
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {(['peer', 'host', 'client'] as const).map((role) => (
              <button
                key={role}
                onClick={() => updateRole(role)}
                disabled={roleSaving || profile.role === role}
                style={{
                  padding: '9px 12px',
                  borderRadius: '8px',
                  border: `1px solid ${profile.role === role ? 'rgba(0,255,136,0.4)' : 'var(--border)'}`,
                  background: profile.role === role ? 'var(--accent-dim)' : 'var(--bg)',
                  color: profile.role === role ? 'var(--accent)' : 'var(--text)',
                  textTransform: 'uppercase',
                  fontFamily: 'var(--font-geist-mono)',
                  fontSize: '11px',
                  cursor: roleSaving || profile.role === role ? 'not-allowed' : 'pointer',
                  opacity: roleSaving && profile.role !== role ? 0.7 : 1,
                }}
              >
                {roleSaving && profile.role !== role ? 'SAVING...' : role}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '16px', marginBottom: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: '12px' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px', marginBottom: '6px' }}>WALLET AND CREDITS</div>
            <div style={{ fontSize: '12px', color: 'var(--muted)', lineHeight: 1.6 }}>
              Free monthly allocation and contribution credits are consumed before paid wallet balance.
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <a href="/developers/billing" style={{ padding: '9px 12px', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', textDecoration: 'none', fontFamily: 'var(--font-geist-mono)', fontSize: '11px' }}>BILLING</a>
            <a href="/provider/sessions" style={{ padding: '9px 12px', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', textDecoration: 'none', fontFamily: 'var(--font-geist-mono)', fontSize: '11px' }}>PROVIDER SESSIONS</a>
            <a href="/developers/api-docs" style={{ padding: '9px 12px', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', textDecoration: 'none', fontFamily: 'var(--font-geist-mono)', fontSize: '11px' }}>API DOCS</a>
            <a href="/developers/keys" style={{ padding: '9px 12px', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', textDecoration: 'none', fontFamily: 'var(--font-geist-mono)', fontSize: '11px' }}>API KEYS</a>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px' }}>
          {[
            { label: 'USD WALLET', value: walletBalanceLabel },
            { label: 'CREDITS', value: contributionCreditsLabel },
            { label: 'PAYOUT', value: payoutBalanceLabel },
          ].map(({ label, value }) => (
            <div key={label} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '10px', padding: '14px' }}>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '16px', color: 'var(--accent)', marginBottom: '4px' }}>{value}</div>
              <div style={{ fontSize: '10px', color: 'var(--muted)', letterSpacing: '1px' }}>{label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Mobile: only show stats + bandwidth + free tier enforcement */}
      {!isMobile && (<div style={{ display: 'contents' }}>

      {/* Private connect */}
      <div style={{ background: 'var(--surface)', border: '1px solid rgba(0,255,136,0.18)', borderRadius: '12px', padding: '16px', marginBottom: '16px' }}>
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px', marginBottom: '6px' }}>PRIVATE SHARE CODE</div>
        <div style={{ fontSize: '12px', color: 'var(--muted)', lineHeight: 1.6, marginBottom: '12px' }}>
          Connect directly to a known device. PeerMesh will only use that device&apos;s active slots and will not fall back to the public pool.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '10px' }}>
          <div style={{ position: 'relative' }}>
            <input
              value={privateCodeInput}
              onChange={(e) => { setPrivateCodeInput(e.target.value.replace(/\D/g, '').slice(0, 9)); setConnectError(null) }}
              placeholder="Enter 9-digit code"
              inputMode="numeric"
              maxLength={9}
              style={{ width: '100%', padding: '10px 36px 10px 12px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', letterSpacing: '1px', boxSizing: 'border-box' }}
            />
            {privateCodeInput && (
              <button
                onClick={() => { setPrivateCodeInput(''); setConnectError(null) }}
                style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '14px', lineHeight: 1, padding: '2px' }}
                title="Clear code"
              >✕</button>
            )}
          </div>
          <button
            onClick={handleConnect}
            disabled={connecting || !privateConnectReady}
            title={selectedCountry ? 'Clear country selection to use private code' : !profile.is_verified ? 'Verify your phone to connect' : undefined}
            style={{ padding: '10px 14px', background: privateConnectReady ? 'var(--accent)' : 'var(--border)', color: privateConnectReady ? '#000' : 'var(--muted)', border: 'none', borderRadius: '8px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.5px', cursor: connecting || !privateConnectReady ? 'not-allowed' : 'pointer' }}
          >
            {connecting && privateConnectReady ? 'CONNECTING...' : 'CONNECT CODE'}
          </button>
        </div>
        {selectedCountry && privateCodeInput && (
          <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--muted)', fontFamily: 'var(--font-geist-mono)' }}>
            Country selected – connecting publicly. Clear country to use private code.
          </div>
        )}
      </div>

      {/* Country picker */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '16px', marginBottom: '16px', opacity: connecting ? 0.5 : 1, pointerEvents: connecting ? 'none' : 'auto' }}>
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '1px', marginBottom: '10px' }}>BROWSE AS...</div>
        <input
          value={countriesSearch}
          onChange={(e) => {
            const q = e.target.value
            setCountriesSearch(q)
            if (countriesSearchTimer.current) clearTimeout(countriesSearchTimer.current)
            countriesSearchTimer.current = setTimeout(() => loadCountries(1, q), 300)
          }}
          placeholder="Search country..."
          style={{ width: '100%', padding: '8px 10px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text)', fontFamily: 'var(--font-geist-mono)', fontSize: '11px', marginBottom: '10px', boxSizing: 'border-box' }}
        />
        {countriesLoading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px', color: 'var(--muted)', fontFamily: 'var(--font-geist-mono)', fontSize: '11px' }}>
            <span style={{ display: 'inline-block', width: '10px', height: '10px', border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
            LOADING COUNTRIES...
          </div>
        ) : countriesError ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px', background: 'rgba(255,68,102,0.08)', border: '1px solid rgba(255,68,102,0.25)', borderRadius: '8px' }}>
            <span style={{ color: '#ff6060', fontSize: '12px' }}>Could not load countries</span>
            <button onClick={() => loadCountries(countriesPage, countriesSearch)} style={{ background: 'none', border: 'none', color: 'var(--accent)', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: 'pointer' }}>RETRY</button>
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
              {countries.map(c => {
                const count = peerCounts[c.code] ?? 0
                const selected = selectedCountry === c.code
                return (
                  <button
                    key={c.code}
                    onClick={() => { const next = selected ? null : c.code; setSelectedCountry(next); setConnectError(null); if (next) setPrivateCodeInput('') }}
                    style={{ background: selected ? 'var(--accent-dim)' : 'var(--bg)', border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`, borderRadius: '8px', padding: '10px 6px', cursor: 'pointer', textAlign: 'center', transition: 'all 0.15s' }}
                  >
                    <div style={{ fontSize: '20px', marginBottom: '3px' }}>{c.flag}</div>
                    <div style={{ fontSize: '10px', color: 'var(--text)', marginBottom: '2px' }}>{c.name}</div>
                    <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: count > 0 ? 'var(--accent)' : 'var(--muted)' }}>{count} devices</div>
                  </button>
                )
              })}
            </div>
            {countriesTotalPages > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '10px' }}>
                <button onClick={() => loadCountries(countriesPage - 1, countriesSearch)} disabled={countriesPage <= 1} style={{ background: 'none', border: '1px solid var(--border)', color: countriesPage <= 1 ? 'var(--muted)' : 'var(--text)', borderRadius: '6px', padding: '5px 12px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: countriesPage <= 1 ? 'not-allowed' : 'pointer' }}>← PREV</button>
                <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)' }}>{countriesPage} / {countriesTotalPages}</span>
                <button onClick={() => loadCountries(countriesPage + 1, countriesSearch)} disabled={countriesPage >= countriesTotalPages} style={{ background: 'none', border: '1px solid var(--border)', color: countriesPage >= countriesTotalPages ? 'var(--muted)' : 'var(--text)', borderRadius: '6px', padding: '5px 12px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: countriesPage >= countriesTotalPages ? 'not-allowed' : 'pointer' }}>NEXT →</button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Connect error */}
      {connectError && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', background: 'rgba(255,80,80,0.07)', border: '1px solid rgba(255,80,80,0.3)', borderRadius: '10px', padding: '10px 14px', marginBottom: '12px' }}>
          <span style={{ fontSize: '12px', color: '#ff9090' }}>{connectError}</span>
          <button onClick={dismissErrors} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '14px', lineHeight: 1, padding: '0 2px' }}>✕</button>
        </div>
      )}

      {/* Connect buttons */}
      {selectedCountry && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '16px' }}>
          <a
            href="/extension"
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '6px',
              padding: '14px 10px', background: 'var(--accent)',
              color: '#000',
              border: '1px solid var(--accent)',
              borderRadius: '10px', textDecoration: 'none', textAlign: 'center', transition: 'all 0.2s',
            }}
          >
            <span style={{ fontSize: '18px' }}>🧩</span>
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.5px' }}>EXTENSION</span>
            <span style={{ fontSize: '10px', opacity: 0.8 }}>Full browser · YouTube works</span>
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', background: 'rgba(0,0,0,0.15)', padding: '2px 6px', borderRadius: '4px' }}>🌐 PUBLIC</span>
          </a>

          <button
            onClick={handleConnect}
            disabled={connecting}
            title={!profile.is_verified ? 'Verify your phone to connect' : !hasPaidAccess && !displayIsSharing ? 'Enable sharing or fund your wallet to connect' : undefined}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '6px',
              padding: '14px 10px', background: 'var(--surface)',
              color: connecting ? 'var(--muted)' : 'var(--text)',
              border: '1px solid rgba(0,255,136,0.4)',
              borderRadius: '10px', cursor: connecting ? 'not-allowed' : 'pointer',
              textAlign: 'center', transition: 'all 0.2s',
            }}
          >
            {connecting
              ? <span style={{ display: 'inline-block', width: '18px', height: '18px', border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
              : <span style={{ fontSize: '18px' }}>🌐</span>
            }
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', fontWeight: 700, letterSpacing: '0.5px' }}>
              {connecting ? 'CONNECTING...' : 'WEB BROWSER'}
            </span>
            <span style={{ fontSize: '10px', opacity: 0.7 }}>Limited sites · No install</span>
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', background: 'var(--border)', padding: '2px 6px', borderRadius: '4px' }}>🌐 PUBLIC</span>
          </button>
        </div>
      )}

      {/* Share toggle */}
      <div style={{ background: 'var(--surface)', border: `1px solid ${displayIsSharing ? 'rgba(0,255,136,0.3)' : shareError ? 'rgba(255,80,80,0.3)' : 'var(--border)'}`, borderRadius: '12px', padding: '16px', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 500, marginBottom: '3px' }}>Share my connection</div>
            <div style={{ fontSize: '12px', color: displayIsSharing ? 'var(--accent)' : 'var(--muted)' }}>
              {shareToggling && shareTarget === true
                ? 'Connecting...'
                : displayIsSharing
                  ? (() => {
                      const { publicCount, privateCount } = summarizePrivateShareSlots(privateShares, helperBaseDeviceId, slotDisplayCount)
                      const modeLabel = publicCount > 0 && privateCount > 0
                        ? `${publicCount} 🌐 · ${privateCount} 🔒`
                        : privateCount > 0 ? '🔒 PRIVATE' : '🌐 PUBLIC'
                      return `${sharingStats.requestsHandled} requests · ${formatBytes(sharingStats.bytesServed)} served · ${modeLabel}`
                    })()
                  : !helperOwnedByCurrentUser
                    ? 'Local helper belongs to another user.'
                    : helperStarting
                      ? 'Starting local sharing...'
                    : desktopAvailableForUser
                      ? `${cliRunningForUser && desktopRunningForUser ? 'CLI + Desktop' : cliRunningForUser ? 'CLI' : 'Desktop'} ready – toggle to start sharing`
                      : 'Install the desktop app or run the CLI to share your connection'}
            </div>
          </div>
          <button
            onClick={handleShareToggle}
            disabled={shareToggling || helperStarting}
            style={{ width: '44px', height: '24px', borderRadius: '12px', border: 'none', background: displayIsSharing ? 'var(--accent)' : 'var(--border)', cursor: shareToggling || helperStarting ? 'not-allowed' : 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0, opacity: shareToggling || helperStarting ? 0.6 : 1 }}
          >
            {shareToggling
              ? <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span style={{ width: '10px', height: '10px', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: 'white', borderRadius: '50%', animation: 'spin 0.7s linear infinite', display: 'inline-block' }} /></span>
              : <div style={{ position: 'absolute', width: '18px', height: '18px', borderRadius: '50%', background: 'white', top: '3px', left: displayIsSharing ? '23px' : '3px', transition: 'left 0.2s' }} />
            }
          </button>
        </div>

        <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '4px' }}>CONNECTION SLOTS</div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' }}>
                {Array.from({ length: slotDisplayCount }, (_, index) => {
                  const running = !!helperSlots?.statuses?.[index]?.running || index < slotDisplayActive
                  return (
                    <span
                      key={`slot-dot-${index}`}
                      style={{
                        width: '10px',
                        height: '10px',
                        borderRadius: '999px',
                        background: running ? 'var(--accent)' : 'var(--border)',
                        boxShadow: running ? '0 0 8px rgba(0,255,136,0.35)' : 'none',
                      }}
                    />
                  )
                })}
              </div>
              <div style={{ display: 'grid', gap: '2px' }}>
                <div style={{ fontSize: '11px', color: 'var(--muted)' }}>
                  {slotUpdating ? 'Updating slot count...' : `${slotDisplayActive} / ${slotDisplayCount} active${helperSlots?.warning ? ` - ${helperSlots.warning}` : ''}`}
                </div>
                {!slotUpdating && connectionSlotsSyncLabel && (
                  <div style={{ fontSize: '10px', color: 'var(--muted)', fontFamily: 'var(--font-geist-mono)' }}>
                    {connectionSlotsSyncLabel}
                  </div>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
              <button
                onClick={() => updateConnectionSlots(slotDisplayCount - 1)}
                disabled={slotUpdating || slotDisplayCount <= 1 || !desktopAvailableForUser}
                style={{ width: '30px', height: '30px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: slotDisplayCount <= 1 ? 'var(--muted)' : 'var(--text)', cursor: slotUpdating || slotDisplayCount <= 1 || !desktopAvailableForUser ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-geist-mono)', fontSize: '16px' }}
              >-</button>
              <div style={{ minWidth: '28px', textAlign: 'center', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--text)' }}>
                {slotUpdating ? '...' : slotDisplayCount}
              </div>
              <button
                onClick={() => updateConnectionSlots(slotDisplayCount + 1)}
                disabled={slotUpdating || slotDisplayCount >= 32 || !desktopAvailableForUser}
                style={{ width: '30px', height: '30px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: slotDisplayCount >= 32 ? 'var(--muted)' : 'var(--text)', cursor: slotUpdating || slotDisplayCount >= 32 || !desktopAvailableForUser ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-geist-mono)', fontSize: '16px' }}
              >+</button>
            </div>
          </div>
        </div>

        {/* Daily limit */}
        <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '2px' }}>DAILY SHARE LIMIT</div>
            <div style={{ display: 'grid', gap: '2px' }}>
              <div style={{ fontSize: '11px', color: 'var(--muted)' }}>
                {dailyLimitSaving
                  ? 'Updating daily limit...'
                  : (profile.daily_share_limit_mb != null ? `${profile.daily_share_limit_mb} MB/day - auto-stops when reached` : 'No limit set')}
              </div>
              {!dailyLimitSaving && profileSyncLabel && (
                <div style={{ fontSize: '10px', color: 'var(--muted)', fontFamily: 'var(--font-geist-mono)' }}>
                  {profileSyncLabel}
                </div>
              )}
            </div>
          </div>
          <div style={{ display: 'grid', gap: '8px', minWidth: '220px', flex: '1 1 220px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px' }}>
              <input
                value={dailyLimitInput}
                onChange={(e) => { setDailyLimitInput(e.target.value.replace(/\D/g, '')); setDailyLimitError(null) }}
                inputMode="numeric"
                placeholder="1024+ MB"
                disabled={!helperOwnedByCurrentUser}
                style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '6px', padding: '7px 9px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px' }}
              />
              <button
                onClick={() => saveDailyLimit(dailyLimitInput ? Number.parseInt(dailyLimitInput, 10) : null)}
                disabled={dailyLimitSaving || !helperOwnedByCurrentUser}
                style={{ padding: '7px 12px', background: 'var(--accent)', color: '#000', border: 'none', borderRadius: '6px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', fontWeight: 700, cursor: dailyLimitSaving || !helperOwnedByCurrentUser ? 'not-allowed' : 'pointer', opacity: dailyLimitSaving || !helperOwnedByCurrentUser ? 0.6 : 1 }}
              >
                {dailyLimitSaving ? 'APPLYING...' : 'APPLY'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {[1024, 2048, 5120].map(limit => (
                <button
                  key={`limit-preset-${limit}`}
                  onClick={() => { setDailyLimitInput(String(limit)); void saveDailyLimit(limit) }}
                  disabled={dailyLimitSaving || !helperOwnedByCurrentUser}
                  style={{ padding: '6px 8px', background: profile.daily_share_limit_mb === limit ? 'var(--accent-dim)' : 'var(--bg)', color: profile.daily_share_limit_mb === limit ? 'var(--accent)' : 'var(--text)', border: `1px solid ${profile.daily_share_limit_mb === limit ? 'rgba(0,255,136,0.4)' : 'var(--border)'}`, borderRadius: '6px', fontFamily: 'var(--font-geist-mono)', fontSize: '9px', cursor: dailyLimitSaving || !helperOwnedByCurrentUser ? 'not-allowed' : 'pointer', opacity: dailyLimitSaving || !helperOwnedByCurrentUser ? 0.6 : 1 }}
                >
                  {limit >= 1024 ? `${limit / 1024} GB` : `${limit} MB`}
                </button>
              ))}
              <button
                onClick={() => { setDailyLimitInput(''); void saveDailyLimit(null) }}
                disabled={dailyLimitSaving || !helperOwnedByCurrentUser}
                style={{ padding: '6px 8px', background: profile.daily_share_limit_mb == null ? 'var(--accent-dim)' : 'var(--bg)', color: profile.daily_share_limit_mb == null ? 'var(--accent)' : 'var(--text)', border: `1px solid ${profile.daily_share_limit_mb == null ? 'rgba(0,255,136,0.4)' : 'var(--border)'}`, borderRadius: '6px', fontFamily: 'var(--font-geist-mono)', fontSize: '9px', cursor: dailyLimitSaving || !helperOwnedByCurrentUser ? 'not-allowed' : 'pointer', opacity: dailyLimitSaving || !helperOwnedByCurrentUser ? 0.6 : 1 }}
              >
                NO LIMIT
              </button>
            </div>
            {dailyLimitError && (
              <div style={{ fontSize: '10px', color: '#ff9090', fontFamily: 'var(--font-geist-mono)', lineHeight: 1.5 }}>
                {dailyLimitError}
              </div>
            )}
          </div>
        </div>

        {shareError && (
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', marginTop: '10px', padding: '8px 10px', background: 'rgba(255,80,80,0.07)', border: '1px solid rgba(255,80,80,0.2)', borderRadius: '7px' }}>
            <div style={{ fontSize: '11px', color: '#ff6060', fontFamily: 'var(--font-geist-mono)', lineHeight: 1.5 }}>
              {shareError === 'desktop_required' ? (
                <>Desktop or CLI not running.{' '}<a href="/api/desktop-download" download style={{ color: 'var(--accent)', textDecoration: 'underline' }}>Download desktop</a>{' '}or run <code style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px' }}>npx @btcmaster1000/peermesh-provider</code> then reopen this page.</>
              ) : shareError}
            </div>
            <button onClick={() => setShareError(null)} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '13px', lineHeight: 1, padding: '0', flexShrink: 0 }}>x</button>
          </div>
        )}
      </div>

      {helperBaseDeviceId && (
        <div style={{ background: 'var(--surface)', border: '1px solid rgba(0,255,136,0.18)', borderRadius: '12px', padding: '16px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', marginBottom: '12px' }}>
            <div>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px', marginBottom: '4px' }}>PRIVATE SHARING</div>
              <div style={{ display: 'grid', gap: '4px' }}>
                <div style={{ fontSize: '12px', color: 'var(--muted)', lineHeight: 1.6 }}>
                  {privateShare?.active
                    ? `Enabled for ${getPrivateShareLabel(privateShare)} only. Requesters need this code for that slot.`
                    : 'Optional per-slot sharing for trusted requesters only.'}
                </div>
                {privateShareSaving ? (
                  <div style={{ fontSize: '10px', color: 'var(--muted)', fontFamily: 'var(--font-geist-mono)' }}>
                    Waiting for the database to confirm the latest private-share state...
                  </div>
                ) : privateShareSyncLabel ? (
                  <div style={{ fontSize: '10px', color: 'var(--muted)', fontFamily: 'var(--font-geist-mono)' }}>
                    {privateShareSyncLabel}
                  </div>
                ) : null}
              </div>
            </div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: privateShare?.active ? 'var(--accent)' : 'var(--muted)', whiteSpace: 'nowrap' }}>
              {privateShare?.active ? 'ACTIVE' : 'OFF'}
            </div>
          </div>

          {/* FIX: Always show selector when slotDisplayCount > 1 (from desktop state)
              This prevents transient disappearance when privateShares is temporarily empty */}
          {slotDisplayCount > 1 && privateShares.length > 0 && (
            <div style={{ marginBottom: '10px' }}>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '6px', textTransform: 'uppercase' }}>Selected Slot</div>
              <select
                value={privateShareDeviceId ?? privateShare?.device_id ?? ''}
                onChange={(e) => {
                  const nextDeviceId = e.target.value
                  const nextShare = selectPrivateShare(privateShares, nextDeviceId, helperBaseDeviceId)
                  log('USER SELECTED SLOT',
                    'nextDeviceId=' + nextDeviceId,
                    'prevUserSelectedSlotRef=' + (userSelectedSlotRef.current ?? 'null'),
                    'prevPrivateShareDeviceId=' + (privateShareDeviceId ?? 'null'),
                    'nextShare.device_id=' + (nextShare?.device_id ?? 'null'),
                    'nextShare.slot_index=' + (nextShare?.slot_index ?? 'null'),
                    'nextShare.enabled=' + (nextShare?.enabled ?? 'null'),
                  )
                  // FIX: write to ref so polls respect this selection and don't override it
                  userSelectedSlotRef.current = nextDeviceId
                  setPendingEdit('selectedSlotDeviceId', nextDeviceId)
                  setPrivateShareDeviceId(nextDeviceId)
                  setPrivateShare(nextShare)
                  setPrivateExpiryHours(getExpiryPreset(nextShare?.expires_at ?? null))
                  setSavedPrivateExpiryHours(getExpiryPreset(nextShare?.expires_at ?? null))
                  clearPendingEdit('expiryHours')
                }}
                style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '8px', padding: '8px 10px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: 'pointer' }}
              >
                {privateShares.map((share, index) => {
                  const label = getPrivateShareLabel(share, index)
                  const badge = share.enabled ? (share.active ? ' [ACTIVE]' : ' [ON]') : ' [OFF]'
                  return <option key={share.device_id} value={share.device_id}>{label}{badge}</option>
                })}
              </select>
            </div>
          )}

          <div style={{ marginBottom: '10px', padding: '10px', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--bg)' }}>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '6px', textTransform: 'uppercase' }}>
              {selectedSlotDeviceId ? `${getPrivateShareLabel(privateShare)} SLOT LIMIT` : 'SLOT LIMIT'}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px' }}>
              <input
                value={slotDailyLimitInput}
                onChange={(e) => { setSlotDailyLimitInput(e.target.value.replace(/\D/g, '')); setSlotDailyLimitError(null) }}
                inputMode="numeric"
                placeholder="1024+ MB"
                disabled={!helperOwnedByCurrentUser}
                style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '6px', padding: '7px 9px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px' }}
              />
              <button
                onClick={() => saveSlotDailyLimit(slotDailyLimitInput ? Number.parseInt(slotDailyLimitInput, 10) : null)}
                disabled={slotDailyLimitSaving || !helperOwnedByCurrentUser}
                style={{ padding: '7px 10px', background: 'var(--accent)', color: '#000', border: 'none', borderRadius: '6px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', fontWeight: 700, cursor: slotDailyLimitSaving || !helperOwnedByCurrentUser ? 'not-allowed' : 'pointer', opacity: slotDailyLimitSaving || !helperOwnedByCurrentUser ? 0.6 : 1 }}
              >
                {slotDailyLimitSaving ? 'APPLYING...' : 'APPLY'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
              {[1024, 2048, 5120].map(limit => (
                <button
                  key={`slot-limit-preset-${limit}`}
                  onClick={() => { setSlotDailyLimitInput(String(limit)); void saveSlotDailyLimit(limit) }}
                  disabled={slotDailyLimitSaving || !helperOwnedByCurrentUser}
                  style={{ padding: '6px 8px', background: selectedSlotLimit?.daily_limit_mb === limit ? 'var(--accent-dim)' : 'var(--surface)', color: selectedSlotLimit?.daily_limit_mb === limit ? 'var(--accent)' : 'var(--text)', border: `1px solid ${selectedSlotLimit?.daily_limit_mb === limit ? 'rgba(0,255,136,0.4)' : 'var(--border)'}`, borderRadius: '6px', fontFamily: 'var(--font-geist-mono)', fontSize: '9px', cursor: slotDailyLimitSaving || !helperOwnedByCurrentUser ? 'not-allowed' : 'pointer', opacity: slotDailyLimitSaving || !helperOwnedByCurrentUser ? 0.6 : 1 }}
                >
                  {limit >= 1024 ? `${limit / 1024} GB` : `${limit} MB`}
                </button>
              ))}
              <button
                onClick={() => { setSlotDailyLimitInput(''); void saveSlotDailyLimit(null) }}
                disabled={slotDailyLimitSaving || !helperOwnedByCurrentUser}
                style={{ padding: '6px 8px', background: selectedSlotLimit?.daily_limit_mb == null ? 'var(--accent-dim)' : 'var(--surface)', color: selectedSlotLimit?.daily_limit_mb == null ? 'var(--accent)' : 'var(--text)', border: `1px solid ${selectedSlotLimit?.daily_limit_mb == null ? 'rgba(0,255,136,0.4)' : 'var(--border)'}`, borderRadius: '6px', fontFamily: 'var(--font-geist-mono)', fontSize: '9px', cursor: slotDailyLimitSaving || !helperOwnedByCurrentUser ? 'not-allowed' : 'pointer', opacity: slotDailyLimitSaving || !helperOwnedByCurrentUser ? 0.6 : 1 }}
              >
                NO LIMIT
              </button>
            </div>
            <div style={{ display: 'grid', gap: '2px', marginTop: '6px' }}>
              <div style={{ fontSize: '10px', color: 'var(--muted)', fontFamily: 'var(--font-geist-mono)' }}>
                {slotDailyLimitSaving
                  ? 'Updating slot limit...'
                  : (selectedSlotLimit?.daily_limit_mb != null ? `${selectedSlotLimit.daily_limit_mb} MB/day on this slot` : 'No per-slot cap on this slot')}
              </div>
              {!slotDailyLimitSaving && slotLimitSyncLabel && (
                <div style={{ fontSize: '10px', color: 'var(--muted)', fontFamily: 'var(--font-geist-mono)' }}>
                  {slotLimitSyncLabel}
                </div>
              )}
            </div>
            {slotDailyLimitError && (
              <div style={{ marginTop: '6px', fontSize: '10px', color: '#ff9090', fontFamily: 'var(--font-geist-mono)' }}>
                {slotDailyLimitError}
              </div>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '10px', marginBottom: '10px' }}>
            <div style={{ padding: '10px 12px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px', fontFamily: 'var(--font-geist-mono)', fontSize: '15px', letterSpacing: '3px', color: privateShare?.code ? 'var(--accent)' : 'var(--muted)' }}>
              {privateShare?.code ?? 'CODE OFF'}
            </div>
            <button
              onClick={() => { if (privateShare?.code) navigator.clipboard.writeText(privateShare.code).catch(() => {}) }}
              disabled={!privateShare?.code}
              style={{ padding: '10px 12px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px', color: privateShare?.code ? 'var(--text)' : 'var(--muted)', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: privateShare?.code ? 'pointer' : 'not-allowed' }}
            >
              COPY
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
            <select
              value={privateExpiryHours}
              onChange={(e) => {
                setPrivateExpiryHours(e.target.value)
                setPendingEdit('expiryHours', e.target.value)
              }}
              style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '6px', padding: '6px 8px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: 'pointer' }}
            >
              <option value='none'>No expiry</option>
              <option value='1'>1 hour</option>
              <option value='24'>24 hours</option>
              <option value='168'>7 days</option>
            </select>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {privateShare?.code && privateExpiryHours !== savedPrivateExpiryHours && (
                <button
                  onClick={() => savePrivateShare({ expiryHours: privateExpiryHours })}
                  disabled={privateShareSaving}
                  style={{ padding: '7px 12px', background: 'var(--accent)', color: '#000', border: 'none', borderRadius: '7px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', fontWeight: 700, cursor: privateShareSaving ? 'not-allowed' : 'pointer', opacity: privateShareSaving ? 0.6 : 1 }}
                >
                  {privateShareSaving ? 'SAVING...' : 'APPLY EXPIRY'}
                </button>
              )}
              <button
                onClick={() => savePrivateShare({ enabled: !(privateShare?.enabled ?? false), expiryHours: privateExpiryHours })}
                disabled={privateShareSaving}
                style={{ padding: '7px 12px', background: privateShare?.enabled ? 'transparent' : 'var(--accent)', color: privateShare?.enabled ? 'var(--text)' : '#000', border: `1px solid ${privateShare?.enabled ? 'var(--border)' : 'var(--accent)'}`, borderRadius: '7px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: privateShareSaving ? 'not-allowed' : 'pointer', opacity: privateShareSaving ? 0.6 : 1 }}
              >
                {privateShareSaving && privateShareAction !== 'refresh' ? 'SAVING...' : (privateShare?.enabled ? 'DISABLE' : 'ENABLE')}
              </button>
              <button
                onClick={() => savePrivateShare({ enabled: true, refresh: true, expiryHours: privateExpiryHours })}
                disabled={privateShareSaving}
                style={{ padding: '7px 12px', background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '7px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: privateShareSaving ? 'not-allowed' : 'pointer', opacity: privateShareSaving ? 0.6 : 1 }}
              >
                {privateShareSaving && privateShareAction === 'refresh' ? 'REFRESHING...' : 'REFRESH CODE'}
              </button>
            </div>
          </div>
          {privateShareSaving && (
            <div style={{ marginTop: '8px', fontSize: '10px', color: 'var(--muted)', fontFamily: 'var(--font-geist-mono)' }}>
              Updating private sharing...
            </div>
          )}

          {isSharing && (() => {
            const { publicCount, privateCount } = summarizePrivateShareSlots(privateShares, helperBaseDeviceId, slotDisplayCount)
            return (
              <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--muted)', fontFamily: 'var(--font-geist-mono)', background: 'rgba(0,255,136,0.05)', border: '1px solid rgba(0,255,136,0.15)', borderRadius: '6px', padding: '6px 10px' }}>
                {publicCount > 0 && privateCount > 0
                  ? `${publicCount} public slot${publicCount !== 1 ? 's' : ''} · ${privateCount} private slot${privateCount !== 1 ? 's' : ''}`
                  : privateCount > 0
                    ? `All ${privateCount} slot${privateCount !== 1 ? 's are' : ' is'} private – only code holders can connect`
                    : `All ${publicCount} slot${publicCount !== 1 ? 's are' : ' is'} public – any eligible user can connect`}
              </div>
            )
          })()}
          {privateShare?.expires_at && (
            <div style={{ marginTop: '10px', fontSize: '11px', color: 'var(--muted)' }}>
              Expires {new Date(privateShare.expires_at).toLocaleString()}
            </div>
          )}
        </div>
      )}

      {!profile.is_verified && (
        <div style={{ background: 'rgba(255,204,102,0.08)', border: '1px solid rgba(255,204,102,0.3)', borderRadius: '10px', padding: '12px 16px', marginBottom: '12px', fontSize: '12px', color: '#ffcc66' }}>
          <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', letterSpacing: '0.5px' }}>PHONE CHECK - </span>
          Email confirmation is enough to sign in. Phone verification is only required before you connect through another provider.{' '}
          <a href="/verify/phone" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>Verify phone</a>.
        </div>
      )}

      {/* Free tier enforcement – shown on all screen sizes */}
      {!hasPaidAccess && !isSharing && (selectedCountry || privateConnectReady) && !isMobile && (
        selectedCountry ? (
          <div style={{ background: 'rgba(255,80,80,0.07)', border: '1px solid rgba(255,80,80,0.3)', borderRadius: '10px', padding: '12px 16px', marginBottom: '16px', fontSize: '12px', color: '#ff9090' }}>
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', letterSpacing: '0.5px' }}>FREE LAYER – </span>
            Enable sharing above to connect publicly, or{' '}
            <a href="/developers/billing" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>fund your wallet</a> to browse without sharing.
          </div>
        ) : (
          <div style={{ background: 'rgba(0,255,136,0.07)', border: '1px solid rgba(0,255,136,0.24)', borderRadius: '10px', padding: '12px 16px', marginBottom: '16px', fontSize: '12px', color: 'var(--accent)' }}>
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', letterSpacing: '0.5px' }}>PRIVATE CONNECT – </span>
            Private code sessions use your base allowance. Wallet funding only increases limits and adds advanced features.
          </div>
        )
      )}

      {/* Close desktop-only wrapper */}
      </div>)}

      {/* Wallet banner – always visible so mobile users can fund access */}
      {!hasPaidAccess && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', background: 'var(--accent-dim)', border: '1px solid rgba(0,255,136,0.2)', borderRadius: '10px', marginBottom: '12px' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', letterSpacing: '0.5px', marginBottom: '2px' }}>FREE LAYER</div>
            <div style={{ fontSize: '12px', color: 'var(--muted)' }}>Fund your wallet to browse without sharing your IP</div>
          </div>
          <a href="/developers/billing" style={{ padding: '8px 14px', background: 'var(--accent)', color: '#000', borderRadius: '7px', fontSize: '11px', fontFamily: 'var(--font-geist-mono)', fontWeight: 700, textDecoration: 'none', letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>
            FUND WALLET
          </a>
        </div>
      )}

      {/* Desktop-only: premium reservation, CLI banner, modals */}
      {!isMobile && (<div style={{ display: 'contents' }}>

      {/* Premium peer reservation */}
      {profile.is_premium && selectedCountry && (
        <div style={{ padding: '14px 16px', background: 'var(--surface)', border: '1px solid rgba(0,255,136,0.2)', borderRadius: '10px', marginBottom: '12px' }}>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '0.5px', marginBottom: '6px' }}>PREMIUM – PEER RESERVATION</div>
          {(profile.preferred_providers as Record<string, string>)?.[selectedCountry] ? (
            <>
              <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '10px' }}>
                Reserved peer for <strong style={{ color: 'var(--text)' }}>{selectedCountry}</strong> – they will be matched first on every connection.
              </div>
              <button
                onClick={async () => {
                  const { data: { session } } = await supabase.auth.getSession()
                  if (!session) return
                  await supabase.from('profiles').update({
                    preferred_providers: { ...(profile.preferred_providers as Record<string, string>), [selectedCountry]: undefined }
                  }).eq('id', session.user.id)
                  const { data } = await supabase.from('profiles').select('preferred_providers').eq('id', profile.id).single()
                  if (data) setProfile(p => p ? { ...p, preferred_providers: data.preferred_providers } : p)
                }}
                style={{ padding: '7px 14px', background: 'none', border: '1px solid var(--border)', color: 'var(--muted)', borderRadius: '7px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: 'pointer' }}
              >
                CLEAR RESERVATION
              </button>
            </>
          ) : (
            <div style={{ fontSize: '12px', color: 'var(--muted)', lineHeight: 1.6 }}>
              No reserved peer for <strong style={{ color: 'var(--text)' }}>{selectedCountry}</strong> yet.<br />
              <span style={{ fontSize: '11px' }}>Connect to a peer and they will be auto-reserved so you always get the same IP.</span>
            </div>
          )}
        </div>
      )}

      {/* CLI banner */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'var(--surface)', border: `1px solid ${cliRunning ? (cliUpdateAvailable ? 'rgba(255,200,0,0.5)' : 'rgba(0,255,136,0.3)') : 'var(--border)'}`, borderRadius: '10px', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '16px' }}>⌨️</span>
          <div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: cliRunning ? (cliUpdateAvailable ? '#ffc800' : 'var(--accent)') : 'var(--muted)', letterSpacing: '0.5px', marginBottom: '2px' }}>
              {cliRunning
                ? cliUpdateAvailable ? `CLI UPDATE AVAILABLE – v${latestCliVersion}` : '● CLI DETECTED – SHARING ACTIVE'
                : 'SHARE FROM ANY MACHINE'}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--muted)' }}>
              {cliRunning
                ? cliUpdateAvailable ? `You have v${cliProcessVersion}. Run: npm install -g @btcmaster1000/peermesh-provider@latest` : `v${cliProcessVersion} – in sync with this dashboard`
                : latestCliVersion ? `Latest: v${latestCliVersion} – no desktop app needed` : 'No desktop app needed – just Node.js'}
            </div>
          </div>
        </div>
        <button
          onClick={() => { setCliDocTab(detectedOS); setShowCliDocs(true) }}
          style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: cliUpdateAvailable ? '#ffc800' : 'var(--accent)', background: 'var(--bg)', border: `1px solid ${cliUpdateAvailable ? 'rgba(255,200,0,0.4)' : 'rgba(0,255,136,0.3)'}`, padding: '5px 10px', borderRadius: '5px', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          {cliUpdateAvailable ? '↑ UPDATE ↑' : 'CLI DOCS →'}
        </button>
      </div>

      {/* CLI Docs modal */}
      {showCliDocs && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px' }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '16px', padding: '24px', maxWidth: '560px', width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', letterSpacing: '1px' }}>CLI REFERENCE</div>
              <button onClick={() => setShowCliDocs(false)} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '16px', lineHeight: 1, padding: 0 }}>✕</button>
            </div>

            <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '16px', lineHeight: 1.6 }}>
              Run on any machine with Node.js 18+. The dashboard and desktop app detect it automatically on the same machine. Slots, daily limit, and private sharing stay in sync across all surfaces.
            </div>

            <div style={{ display: 'flex', gap: '6px', marginBottom: '20px' }}>
              {(['windows', 'mac', 'linux'] as const).map(os => (
                <button
                  key={os}
                  onClick={() => setCliDocTab(os)}
                  style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', padding: '5px 12px', borderRadius: '6px', border: `1px solid ${cliDocTab === os ? 'var(--accent)' : 'var(--border)'}`, background: cliDocTab === os ? 'rgba(0,255,136,0.1)' : 'var(--bg)', color: cliDocTab === os ? 'var(--accent)' : 'var(--muted)', cursor: 'pointer', letterSpacing: '0.5px', textTransform: 'uppercase' }}
                >
                  {os === 'windows' ? '🪟 Windows' : os === 'mac' ? '🍎 macOS' : '🐧 Linux'}
                </button>
              ))}
            </div>

            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '10px' }}>INSTALL</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
              <CliSection label="Run once without installing (recommended for first try)" cmd="npx @btcmaster1000/peermesh-provider" />
              <CliSection label="Install globally" cmd="npm install -g @btcmaster1000/peermesh-provider" />
              <CliSection label="Update to latest" cmd="npm install -g @btcmaster1000/peermesh-provider@latest" />
              {cliDocTab === 'windows' && (
                <>
                  <CliSection label="Install Node.js (winget)" cmd="winget install OpenJS.NodeJS" />
                  <CliSection label="Install Node.js (PowerShell)" cmd={`Invoke-WebRequest https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi -OutFile node.msi\nStart-Process msiexec -ArgumentList '/i node.msi /quiet' -Wait`} />
                </>
              )}
              {cliDocTab === 'mac' && (
                <>
                  <CliSection label="Install Node.js (Homebrew)" cmd="brew install node" />
                  <CliSection label="Install Node.js (curl)" cmd={`curl -fsSL https://nodejs.org/dist/v20.11.0/node-v20.11.0.pkg -o node.pkg\nsudo installer -pkg node.pkg -target /`} />
                </>
              )}
              {cliDocTab === 'linux' && (
                <>
                  <CliSection label="Install Node.js (Debian/Ubuntu)" cmd={`curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -\nsudo apt-get install -y nodejs`} />
                  <CliSection label="Install Node.js (RHEL/Fedora)" cmd={`curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -\nsudo dnf install -y nodejs`} />
                </>
              )}
            </div>

            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '10px' }}>BASIC USAGE</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
              <CliSection label="Start sharing (sign-in prompt on first run)" cmd="peermesh-provider" />
              <CliSection label="Show status, live slot count, and today's usage, then exit" cmd="peermesh-provider --status" />
              <CliSection label="Skip the provider terms prompt (scripts / CI)" cmd="peermesh-provider --serve" />
              <CliSection label="Print verbose debug logs to console" cmd="peermesh-provider --debug" />
              <CliSection label="Clear saved credentials and re-authenticate" cmd="peermesh-provider --reset" />
            </div>

            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '10px' }}>CONNECTION SLOTS</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
              <CliSection label="Run with 4 concurrent slots" cmd="peermesh-provider --slots 4" />
              <CliSection label="--slot is also accepted (alias)" cmd="peermesh-provider --slot 4" />
              <CliSection label="Run with 16 slots (high throughput server)" cmd="peermesh-provider --slots 16" />
              <div style={{ fontSize: '11px', color: 'var(--muted)', lineHeight: 1.6, padding: '8px 10px', background: 'var(--bg)', borderRadius: '7px', border: '1px solid var(--border)' }}>
                Each slot is an independent relay WebSocket. Slots 1–8 are safe for home connections. 9–16 for stable broadband. 17–32 for servers only. The dashboard and desktop app stay in sync – changing slots in one surface updates the other. Both <code style={{fontFamily:'var(--font-geist-mono)'}}>--slots</code> and <code style={{fontFamily:'var(--font-geist-mono)'}}>--slot</code> are accepted.
              </div>
            </div>

            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '10px' }}>DAILY BANDWIDTH LIMIT</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
              <CliSection label="Cap at 500 MB/day" cmd="peermesh-provider --limit 500" />
              <CliSection label="Cap at 2 GB/day" cmd="peermesh-provider --limit 2048" />
              <CliSection label="Remove the daily cap" cmd="peermesh-provider --no-limit" />
              <div style={{ fontSize: '11px', color: 'var(--muted)', lineHeight: 1.6, padding: '8px 10px', background: 'var(--bg)', borderRadius: '7px', border: '1px solid var(--border)' }}>
                When the limit is reached, sharing pauses automatically and resumes at midnight – the process stays running. The limit is also synced from the dashboard and desktop app.
              </div>
            </div>

            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '10px' }}>PRIVATE SHARING</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
              <CliSection label="Show private sharing status for all slots" cmd="peermesh-provider --private-status" />
              <CliSection label="Enable private sharing on slot 1 (default)" cmd="peermesh-provider --private-on" />
              <CliSection label="Enable private sharing on slot 2" cmd="peermesh-provider --private-on --private-slot 2" />
              <CliSection label="Enable private sharing on slot 3" cmd="peermesh-provider --private-on --private-slot 3" />
              <CliSection label="Disable private sharing on slot 1" cmd="peermesh-provider --private-off" />
              <CliSection label="Disable private sharing on slot 2" cmd="peermesh-provider --private-off --private-slot 2" />
              <CliSection label="Rotate the code on slot 1 (keep enabled)" cmd="peermesh-provider --private-refresh" />
              <CliSection label="Rotate the code on slot 2" cmd="peermesh-provider --private-refresh --private-slot 2" />
              <CliSection label="Enable slot 1 with 1-hour expiry" cmd="peermesh-provider --private-on --private-expiry 1" />
              <CliSection label="Enable slot 2 with 24-hour expiry" cmd="peermesh-provider --private-on --private-slot 2 --private-expiry 24" />
              <CliSection label="Enable slot 3 with 7-day expiry" cmd="peermesh-provider --private-on --private-slot 3 --private-expiry 168" />
              <CliSection label="Enable slot 1 with no expiry" cmd="peermesh-provider --private-on --private-expiry none" />
              <div style={{ fontSize: '11px', color: 'var(--muted)', lineHeight: 1.6, padding: '8px 10px', background: 'var(--bg)', borderRadius: '7px', border: '1px solid var(--border)' }}>
                <strong style={{ color: 'var(--text)', fontFamily: 'var(--font-geist-mono)', fontSize: '10px' }}>--private-slot N</strong> selects which slot to configure (1-based, matches the slot number shown in the dashboard). Omitting it defaults to slot 1. Each slot has its own independent code, enabled state, and expiry. Privacy changes apply immediately without disconnecting — the CLI/desktop automatically sync the new state. Codes and state sync with the dashboard and desktop app in real time.
              </div>
            </div>

            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '10px' }}>COMBINING FLAGS</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
              <CliSection label="4 slots, 1 GB/day cap, verbose logs" cmd="peermesh-provider --slots 4 --limit 1024 --debug" />
              <CliSection label="8 slots, slot 1 private with 24h expiry, no terms prompt" cmd="peermesh-provider --slots 8 --private-on --private-expiry 24 --serve" />
              <CliSection label="Enable slot 2 private, slot 3 private, check status" cmd={`peermesh-provider --private-on --private-slot 2 --private-expiry 168\npeermesh-provider --private-on --private-slot 3 --private-expiry 168\npeermesh-provider --private-status`} />
              <CliSection label="Check live status without starting" cmd="peermesh-provider --status" />
            </div>

            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '10px' }}>RUN AT STARTUP</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
              {cliDocTab === 'windows' && (
                <CliSection label="Register as a login startup task (PowerShell, run as admin)" cmd={`$action = New-ScheduledTaskAction -Execute "$(where.exe peermesh-provider)" -Argument "--serve"\n$trigger = New-ScheduledTaskTrigger -AtLogOn\nRegister-ScheduledTask -TaskName "PeerMesh" -Action $action -Trigger $trigger -RunLevel Highest -Force`} />
              )}
              {cliDocTab === 'mac' && (
                <CliSection label="Register as a launchd service" cmd={`cat > ~/Library/LaunchAgents/app.peermesh.provider.plist <<EOF\n<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>app.peermesh.provider</string>\n  <key>ProgramArguments</key><array>\n    <string>$(which peermesh-provider)</string>\n    <string>--serve</string>\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n</dict></plist>\nEOF\nlaunchctl load ~/Library/LaunchAgents/app.peermesh.provider.plist`} />
              )}
              {cliDocTab === 'linux' && (
                <CliSection label="Register as a systemd service" cmd={`sudo tee /etc/systemd/system/peermesh.service <<EOF\n[Unit]\nDescription=PeerMesh Provider\nAfter=network.target\n\n[Service]\nExecStart=$(which peermesh-provider) --serve\nRestart=always\nRestartSec=10\nUser=$USER\n\n[Install]\nWantedBy=multi-user.target\nEOF\nsudo systemctl enable --now peermesh.service`} />
              )}
            </div>

            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: 'var(--muted)', letterSpacing: '0.5px', marginBottom: '10px' }}>UNINSTALL</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <CliSection label="Remove the CLI" cmd="npm uninstall -g @btcmaster1000/peermesh-provider" />
              {cliDocTab === 'windows' && (
                <>
                  <CliSection label="Remove saved credentials (PowerShell)" cmd={`Remove-Item -Recurse -Force "$env:USERPROFILE\\.peermesh"`} />
                  <CliSection label="Remove saved credentials (cmd)" cmd={`rmdir /s /q "%USERPROFILE%\\.peermesh"`} />
                  <CliSection label="Remove startup task" cmd={`Unregister-ScheduledTask -TaskName "PeerMesh" -Confirm:$false`} />
                </>
              )}
              {cliDocTab === 'mac' && (
                <>
                  <CliSection label="Remove saved credentials" cmd="rm -rf ~/.peermesh" />
                  <CliSection label="Remove startup service" cmd={`launchctl unload ~/Library/LaunchAgents/app.peermesh.provider.plist\nrm ~/Library/LaunchAgents/app.peermesh.provider.plist`} />
                </>
              )}
              {cliDocTab === 'linux' && (
                <>
                  <CliSection label="Remove saved credentials" cmd="rm -rf ~/.peermesh" />
                  <CliSection label="Remove startup service" cmd={`sudo systemctl disable --now peermesh.service\nsudo rm /etc/systemd/system/peermesh.service`} />
                </>
              )}
            </div>

          </div>
        </div>
      )}

      {/* Provider disclosure modal */}
      {showDisclosure && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px' }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '16px', padding: '28px', maxWidth: '440px', width: '100%' }}>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', letterSpacing: '1px', marginBottom: '12px' }}>BEFORE YOU SHARE</div>
            <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '16px', lineHeight: 1.3 }}>What sharing your connection means</div>
            {([
              ['🌐', 'Your IP address will be used by other PeerMesh users to browse the web.'],
              ['📋', 'All sessions are logged with signed receipts. You can see what passed through in your session history.'],
              ['🚫', 'Blocked automatically: .onion sites, SMTP/mail servers, torrent trackers, and private network addresses.'],
              ['⚡', 'You can stop sharing at any time by toggling the switch off.'],
              ['💸', 'Sharing earns you free browsing credits on the free tier.'],
            ] as [string, string][]).map(([icon, text]) => (
              <div key={text} style={{ display: 'flex', gap: '12px', marginBottom: '12px', fontSize: '13px', color: 'var(--muted)', lineHeight: 1.5 }}>
                <span style={{ flexShrink: 0 }}>{icon}</span>
                <span>{text}</span>
              </div>
            ))}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '20px' }}>
              <button
                onClick={() => setShowDisclosure(false)}
                style={{ padding: '12px', background: 'none', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--muted)', cursor: 'pointer', fontFamily: 'var(--font-geist-mono)', fontSize: '11px' }}
              >
                CANCEL
              </button>
              <button
                onClick={async () => {
                  setShowDisclosure(false)
                  const { data: { session } } = await supabase.auth.getSession()
                  if (session) {
                    await supabase.from('profiles').update({ has_accepted_provider_terms: true }).eq('id', session.user.id)
                    setProfile(p => p ? { ...p, has_accepted_provider_terms: true } : p)
                  }
                  await startSharing()
                }}
                style={{ padding: '12px', background: 'var(--accent)', border: 'none', borderRadius: '8px', color: '#000', cursor: 'pointer', fontFamily: 'var(--font-geist-mono)', fontSize: '11px', fontWeight: 700 }}
              >
                I UNDERSTAND – SHARE
              </button>
            </div>
          </div>
        </div>
      )}
      {/* End desktop-only block */}
      </div>)}

    </main>
  )
}
