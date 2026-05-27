// popup.js - PeerMesh Chrome Extension
const API = 'https://peermesh-0unl.onrender.com'

// Countries - loaded from DB with pagination, error handling and retry
const COUNTRIES_PAGE_SIZE = 30
let countriesData = []
let countriesPage = 1
let countriesTotalPages = 1
let countriesLoading = false
let countriesError = false
let countriesSearch = ''
let countriesSearchTimer = null

async function loadCountries(page = 1, search = '') {
  countriesLoading = true
  countriesError = false
  render()
  try {
    const qs = new URLSearchParams({ page: String(page), limit: String(COUNTRIES_PAGE_SIZE) })
    if (search) qs.set('q', search)
    const res = await fetch(`${API}/api/countries?${qs}`)
    if (!res.ok) throw new Error('failed')
    const data = await res.json().catch(() => ({}))
    countriesData = data.countries ?? []
    countriesTotalPages = data.pages ?? 1
    countriesPage = page
    // Auto-select IP-detected country on first load
    // auto-select removed - let user choose their own country
  } catch {
    countriesError = true
  } finally {
    countriesLoading = false
    render()
  }
}

function getFlagForCountry(code) {
  const found = countriesData.find(c => c.code === code)
  return found?.flag ?? ''
}

function getHelperMismatchError(helper = state.helper) {
  const source = helper?.source === 'cli' ? 'CLI' : 'desktop app'
  return `This ${source} is signed in as a different user. Sign out of the ${source} first.`
}
const FREE_TIER_MESSAGE = 'FREE LAYER - Enable sharing above to connect publicly, or fund your USD wallet to browse without sharing.'
const DAILY_LIMIT_MIN_MB = 1024
const PRIVATE_ON_DEMAND_MAX_ATTEMPTS = 12

function withSharingHeaders(token, contentType = true) {
  const headers = {}
  if (contentType) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  headers['x-peermesh-actor'] = 'extension'
  return headers
}

let state = {
  user: null,
  session: null,
  isSharing: false,
  sharePending: false,
  shareToggling: false,
  connecting: false,
  disconnecting: false,
  helper: null,
  selectedCountry: null,
  peerCounts: {},
  loading: true,
  error: null,
  extId: null,
  supabaseToken: null,
  isOnline: navigator.onLine,
  showDisclosure: false,
  privateCodeInput: '',
  privateCodeRecent: [],
  privateShare: null,
  privateShares: [],
  selectedPrivateSlot: null,
  privateExpiryHours: 'none',
  privateShareSaving: false,
  privateShareAction: null,
  privateShareRestartRequired: false,
  slotUpdating: false,
  dailyLimitInput: '',
  dailyLimitSaving: false,
  slotLimits: {},
  slotDailyLimitInput: '',
  slotDailyLimitSaving: false,
  connectionType: 'public',
  profileSync: null,
  reconnectStatus: null,
  failClosed: false,
}

// Pending edits: user changes not yet saved. Polls skip overwriting these fields.
const PENDING_EDIT_TTL = 30_000
const _pendingEdits = {}
function setPendingEdit(key, value) { _pendingEdits[key] = { value, ts: Date.now() } }
function clearPendingEdit(key) { delete _pendingEdits[key] }
function getPendingEdit(key) {
  const entry = _pendingEdits[key]
  if (!entry) return null
  if (Date.now() - entry.ts > PENDING_EDIT_TTL) { delete _pendingEdits[key]; return null }
  return entry.value
}

const RESTORABLE_INPUT_IDS = new Set(['countrySearchInput', 'privateCodeInput', 'dailyLimitInput', 'slotDailyLimitInput'])
const PRIVATE_CODE_RECENT_TTL_MS = 30 * 24 * 60 * 60 * 1000
const PRIVATE_CODE_RECENT_MAX = 8

function normalizeRecentPrivateCodes(rows) {
  const cutoff = Date.now() - PRIVATE_CODE_RECENT_TTL_MS
  const seen = new Set()
  return (Array.isArray(rows) ? rows : [])
    .map(row => ({
      code: String(row?.code || '').replace(/\D/g, '').slice(0, 9),
      lastUsedAt: Number(row?.lastUsedAt || 0),
    }))
    .filter(row => row.code.length === 9 && row.lastUsedAt >= cutoff && !seen.has(row.code) && seen.add(row.code))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, PRIVATE_CODE_RECENT_MAX)
}

async function rememberPrivateCode(code) {
  const normalized = String(code || '').replace(/\D/g, '').slice(0, 9)
  if (normalized.length !== 9) return
  const next = normalizeRecentPrivateCodes([
    { code: normalized, lastUsedAt: Date.now() },
    ...state.privateCodeRecent.filter(row => row.code !== normalized),
  ])
  state.privateCodeRecent = next
  await chrome.storage.local.set({ privateCodeRecent: next })
}

async function clearRecentPrivateCodes() {
  state.privateCodeRecent = []
  await chrome.storage.local.set({ privateCodeRecent: [] })
  render()
}

function formatMbps(value) {
  const speed = Number(value)
  if (!Number.isFinite(speed) || speed <= 0) return '0.00 Mbps'
  return `${speed >= 10 ? speed.toFixed(1) : speed.toFixed(2)} Mbps`
}

function getSessionRouteLabel(session = null) {
  const directState = String(session?.directState || session?.quality?.directState || '').toLowerCase()
  if (directState === 'direct') return 'DIRECT'
  if (directState === 'attempting_direct') return 'DIRECT SETUP'
  if (directState === 'relay') return 'RELAY'
  if (Number(session?.transportTier ?? session?.quality?.transportTier ?? 0) > 0) return 'DIRECT SETUP'
  return 'RELAY'
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function captureFocusedInput() {
  const el = document.activeElement
  if (!el || !RESTORABLE_INPUT_IDS.has(el.id)) return null
  return {
    id: el.id,
    selectionStart: typeof el.selectionStart === 'number' ? el.selectionStart : null,
    selectionEnd: typeof el.selectionEnd === 'number' ? el.selectionEnd : null,
  }
}

function restoreFocusedInput(snapshot) {
  if (!snapshot) return
  const el = document.getElementById(snapshot.id)
  if (!el) return
  el.focus()
  if (snapshot.selectionStart !== null && snapshot.selectionEnd !== null && typeof el.setSelectionRange === 'function') {
    const max = el.value.length
    el.setSelectionRange(Math.min(snapshot.selectionStart, max), Math.min(snapshot.selectionEnd, max))
  }
}

function captureScrollPosition() {
  const el = document.scrollingElement || document.documentElement || document.body
  return Number(el?.scrollTop ?? 0)
}

function restoreScrollPosition(scrollTop) {
  if (!Number.isFinite(scrollTop) || scrollTop <= 0) return
  requestAnimationFrame(() => {
    const el = document.scrollingElement || document.documentElement || document.body
    if (el) el.scrollTop = scrollTop
  })
}

window.addEventListener('online', () => { state.isOnline = true; render() })
window.addEventListener('offline', () => { state.isOnline = false; render() })

function helperOwnerMismatch(helper = state.helper, user = state.user) {
  return !!(helper?.available && user?.id && helper.userId && helper.userId !== user.id)
}

function ownedHelper(helper = state.helper, user = state.user) {
  return helperOwnerMismatch(helper, user) ? null : helper
}

function helperSharingActive(helper = ownedHelper()) {
  return !!helper?.running
}

function helperSharingPending(helper = ownedHelper()) {
  return !!(helper?.available && !helper?.running && helper?.shareEnabled)
}

function hasPaidAccess(user = state.user) {
  return Number(user?.walletBalanceUsd ?? 0) > 0 || Number(user?.contributionCreditsBytes ?? 0) > 0
}

function getUserSharingToken() {
  return state.user?.token || state.supabaseToken || null
}

function createDisabledPrivateShare(deviceId, baseDeviceId, slotIndex) {
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

function getSyncTimestamp(value) {
  if (!value) return 0
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

function preferLatestSync(current, candidate) {
  if (!candidate) return current ?? null
  if (!current) return candidate
  const currentTs = getSyncTimestamp(current.state_changed_at)
  const candidateTs = getSyncTimestamp(candidate.state_changed_at)
  if (candidateTs > currentTs) return candidate
  if (candidateTs < currentTs) return current
  return current
}

function formatSyncLabel(sync) {
  if (!sync?.state_changed_at) return ''
  const actor = sync.state_actor ? String(sync.state_actor).toUpperCase() : 'SYSTEM'
  return `Synced from ${actor} at ${new Date(sync.state_changed_at).toLocaleTimeString()}`
}

function sortPrivateShares(rows) {
  return [...rows].sort((a, b) => {
    if ((a.base_device_id || '') !== (b.base_device_id || '')) return (a.base_device_id || '').localeCompare(b.base_device_id || '')
    const aSlot = Number.isInteger(a.slot_index) ? a.slot_index : -1
    const bSlot = Number.isInteger(b.slot_index) ? b.slot_index : -1
    if (aSlot !== bSlot) return aSlot - bSlot
    return (a.device_id || '').localeCompare(b.device_id || '')
  })
}

function hasPrivateShareSlot(rows, baseDeviceId, slotIndex) {
  return rows.some((row) => row?.base_device_id === baseDeviceId && (row.slot_index === slotIndex || (slotIndex === 0 && row.device_id === baseDeviceId)))
}

function mergePrivateShares(rows, baseDeviceId, helper = ownedHelper()) {
  if (!baseDeviceId) return []

  const merged = new Map()
  const add = (row) => {
    if (row?.device_id) merged.set(row.device_id, preferLatestSync(merged.get(row.device_id), row) ?? row)
  }

  ;(rows || []).forEach(add)
  ;(helper?.privateShares || []).forEach((row) => {
    if (!row || row.base_device_id !== baseDeviceId) return
    add(row)
  })
  if (helper?.privateShare?.base_device_id === baseDeviceId) add(helper.privateShare)

  const configuredSlots = Math.max(1, helper?.slots?.configured ?? helper?.connectionSlots ?? 1)
  const baseShare = merged.get(baseDeviceId)
  const hasBaseShareWithCode = baseShare && !Number.isInteger(baseShare.slot_index) && baseShare.code
  const currentRows = () => [...merged.values()]
  for (let index = 0; index < configuredSlots; index++) {
    if (!hasPrivateShareSlot(currentRows(), baseDeviceId, index)) {
      const deviceId = `${baseDeviceId}_slot_${index}`
      // New slots always start clean - never inherit another slot's private share data
      merged.set(deviceId, createDisabledPrivateShare(deviceId, baseDeviceId, index))
    }
  }

  // Remove rows for slots beyond the current configured count to prevent stale
  // slot entries from a previous higher slot count showing in the dropdown.
  for (const [deviceId, row] of merged) {
    if (!Number.isInteger(row.slot_index)) continue
    if (row.base_device_id === baseDeviceId && row.slot_index >= configuredSlots) {
      merged.delete(deviceId)
    }
  }

  if (merged.size === 0) {
    const deviceId = `${baseDeviceId}_slot_0`
    merged.set(deviceId, createDisabledPrivateShare(deviceId, baseDeviceId, 0))
  }

  return sortPrivateShares([...merged.values()])
}

function selectPrivateShare(rows, deviceId, baseDeviceId) {
  if (!rows.length) return null
  if (deviceId) {
    const exact = rows.find((row) => row.device_id === deviceId)
    if (exact) return exact
  }
  if (baseDeviceId) {
    const exactBase = rows.find((row) => row.device_id === baseDeviceId)
    if (exactBase) return exactBase
    const slotZero = rows.find((row) => row.base_device_id === baseDeviceId && (row.slot_index === 0 || row.device_id === `${baseDeviceId}_slot_0`))
    if (slotZero) return slotZero
  }
  return rows[0] ?? null
}

function applyPrivateShareRows(rows, baseDeviceId, preferredDeviceId = null) {
  if (!baseDeviceId) {
    state.privateShare = null
    state.privateShares = []
    state.selectedPrivateSlot = null
    state.slotLimits = {}
    state.slotDailyLimitInput = ''
    state.slotDailyLimitSaving = false
    clearPendingEdit('expiryHours')
    clearPendingEdit('selectedSlotDeviceId')
    return
  }
  state.privateShares = mergePrivateShares(rows, baseDeviceId)
  const pendingSlot = getPendingEdit('selectedSlotDeviceId')
  const preferredSelection = pendingSlot || state.selectedPrivateSlot || preferredDeviceId
  state.privateShare = selectPrivateShare(state.privateShares, preferredSelection, baseDeviceId)
  state.selectedPrivateSlot = state.privateShare?.device_id ?? preferredSelection ?? null
  // Expiry is per-slot: always derive from the selected slot's own expires_at unless user has a pending edit
  if (!getPendingEdit('expiryHours')) {
    state.privateExpiryHours = getPrivateShareExpiryPreset(state.privateShare?.expires_at ?? null)
  }
  syncSlotDailyLimitInput()
}

function mapSlotLimits(rows = []) {
  const mapped = {}
  for (const row of rows) {
    if (!row?.device_id) continue
    mapped[row.device_id] = preferLatestSync(mapped[row.device_id], row) ?? row
  }
  return mapped
}

function syncSlotDailyLimitInput() {
  const pending = getPendingEdit('slotDailyLimitInput')
  if (pending !== null) {
    state.slotDailyLimitInput = pending
    return
  }
  const selectedDeviceId = state.selectedPrivateSlot || state.privateShare?.device_id || null
  const selected = selectedDeviceId ? state.slotLimits?.[selectedDeviceId] : null
  state.slotDailyLimitInput = selected?.daily_limit_mb != null ? String(selected.daily_limit_mb) : ''
}

function shouldPreserveAuthState() {
  const helper = ownedHelper()
  return !!(state.isSharing || (helper?.running || helper?.shareEnabled))
}

async function handleAuthFailure(status, { preserveWhileSharing = false } = {}) {
  if (status !== 401 && status !== 403) return false
  if (preserveWhileSharing && shouldPreserveAuthState()) return true
  await handleExpiredSession()
  return true
}

// Session expiry

async function handleExpiredSession() {
  stopPeerPolling()
  if (authPollInterval) { clearInterval(authPollInterval); authPollInterval = null }
  await chrome.runtime.sendMessage({ type: 'STOP_SHARING' }).catch(() => {})
  await chrome.runtime.sendMessage({ type: 'DISCONNECT' }).catch(() => {})
  state.user = null
  state.session = null
  state.isSharing = false
  state.sharePending = false
  state.helper = null
  state.supabaseToken = null
  state.dailyLimitInput = ''
  state.dailyLimitSaving = false
  state.slotLimits = {}
  state.slotDailyLimitInput = ''
  state.slotDailyLimitSaving = false
  state.privateShare = null
  state.privateShares = []
  state.selectedPrivateSlot = null
  await chrome.storage.local.clear()
  // Preserve extId so auth polling can resume
  const extId = state.extId
  await chrome.storage.local.set({ extId })
  render()
  startAuthPolling()
}

// Init

async function init() {
  const stored = await chrome.storage.local.get(['user', 'session', 'isSharing', 'helper', 'selectedCountry', 'privateCodeInput', 'privateCodeRecent', 'extId', 'supabaseToken', 'connectionType'])

  if (!stored.extId) {
    stored.extId = crypto.randomUUID()
    await chrome.storage.local.set({ extId: stored.extId })
  }
  state = { ...state, ...stored }
  state.privateCodeRecent = normalizeRecentPrivateCodes(stored.privateCodeRecent)
  if (state.privateCodeRecent.length !== (stored.privateCodeRecent || []).length) {
    await chrome.storage.local.set({ privateCodeRecent: state.privateCodeRecent })
  }
  if (state.user?.dailyLimitMb != null && !state.dailyLimitInput) {
    state.dailyLimitInput = String(state.user.dailyLimitMb)
  }

  try {
    const res = await fetch(`${API}/api/peers/available`)
    const data = await res.json()
    data.peers?.forEach(p => { state.peerCounts[p.country] = p.count })
  } catch {}

  if (state.user) {
    // Verify token is still valid before showing the dashboard
    try {
      const res = await fetch(`${API}/api/extension-auth?verify=1&userId=${state.user.id}`, {
        headers: { 'Authorization': `Bearer ${state.user.token}` },
      })
      if (await handleAuthFailure(res.status, { preserveWhileSharing: true })) {
        if (state.user) {
          state.loading = false
          render()
          renderLogPanel()
          await initLogPanel()
          await refreshRuntimeStatus()
          await loadPrivateShareState(ownedHelper()?.baseDeviceId ?? null)
          startPeerPolling()
        }
        return
      }
    } catch {} // offline - allow through with cached credentials
    // Fetch hasAcceptedProviderTerms from DB
    try {
      const res = await fetch(`${API}/api/user/sharing`, {
        headers: { 'Authorization': `Bearer ${getUserSharingToken()}` },
      })
      if (res.ok) {
        const data = await res.json()
        const previousProfileSync = state.profileSync
        const resolvedProfileSync = preferLatestSync(previousProfileSync, data.profile_sync ?? null)
        const shouldApplyProfileState = !previousProfileSync || resolvedProfileSync !== previousProfileSync || !data.profile_sync
        state.profileSync = resolvedProfileSync
        state.hasAcceptedProviderTerms = data.has_accepted_provider_terms ?? false
        if (shouldApplyProfileState) {
          state.user = {
            ...state.user,
            isPremium: data.is_premium ?? state.user.isPremium ?? false,
            role: data.role ?? state.user.role ?? 'client',
            walletBalanceUsd: data.wallet_balance_usd ?? state.user.walletBalanceUsd ?? 0,
            contributionCreditsBytes: data.contribution_credits_bytes ?? state.user.contributionCreditsBytes ?? 0,
            walletPendingPayoutUsd: data.wallet_pending_payout_usd ?? state.user.walletPendingPayoutUsd ?? 0,
            dailyLimitMb: data.daily_share_limit_mb ?? state.user.dailyLimitMb ?? null,
          }
        }
        if (!state.dailyLimitSaving && shouldApplyProfileState) {
          state.dailyLimitInput = state.user.dailyLimitMb != null ? String(state.user.dailyLimitMb) : ''
        }
      }
    } catch {}
    await refreshRuntimeStatus()
    await loadPrivateShareState(ownedHelper()?.baseDeviceId ?? null)
    startPeerPolling()
  }

  state.loading = false
  render()
  renderLogPanel()
  await initLogPanel()

  if (!state.user) startAuthPolling()
  // Load countries for the country picker
  loadCountries(1, '')
}

// Auth polling

let authPollInterval = null
let peerPollInterval = null
let statusPollInterval = null
let profilePollInterval = null

function stopPeerPolling() {
  if (peerPollInterval) { clearInterval(peerPollInterval); peerPollInterval = null }
  if (statusPollInterval) { clearInterval(statusPollInterval); statusPollInterval = null }
  if (profilePollInterval) { clearInterval(profilePollInterval); profilePollInterval = null }
}

async function refreshRuntimeStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' })
    if (!status) return
    state.session = status.session || null
    state.connectionType = status.connectionType || status.session?.connectionType || state.connectionType || 'public'
    state.helper = status.helper || null
    state.failClosed = !!status.failClosed
    const helper = ownedHelper(status.helper || null, state.user)
    state.isSharing = helperSharingActive(helper)
    state.sharePending = helperSharingPending(helper)
    if (helper?.available && /desktop/i.test(state.error || '')) state.error = null
    if (state.isSharing) state.privateShareRestartRequired = false
    const baseDeviceId = ownedHelper(status.helper || null, state.user)?.baseDeviceId ?? null
    if (baseDeviceId) applyPrivateShareRows(state.privateShares, baseDeviceId, state.selectedPrivateSlot)
    else applyPrivateShareRows([], null)
    await chrome.storage.local.set({
      session: state.session,
      isSharing: state.isSharing,
      helper: state.helper,
    })
  } catch {}
}

function getPrivateShareExpiryPreset(expiresAt) {
  if (!expiresAt) return 'none'
  const hours = Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 3600000))
  if (hours <= 2) return '1'
  if (hours <= 30) return '24'
  if (hours <= 24 * 8) return '168'
  return 'none'
}

async function loadPrivateShareState(baseDeviceId) {
  if (!state.user || !baseDeviceId || helperOwnerMismatch()) {
    applyPrivateShareRows([], null)
    return
  }
  try {
    const res = await fetch(`${API}/api/user/sharing?baseDeviceId=${encodeURIComponent(baseDeviceId)}`, {
      headers: { 'Authorization': `Bearer ${getUserSharingToken()}` },
    })
    if (await handleAuthFailure(res.status, { preserveWhileSharing: true })) return
    if (!res.ok) return
    const data = await res.json()
    state.slotLimits = mapSlotLimits([...(data.slot_limits ?? []), ...Object.values(state.slotLimits ?? {})])
    applyPrivateShareRows(data.private_shares ?? (data.private_share ? [data.private_share] : []), baseDeviceId, data.private_share?.device_id ?? null)
  } catch {}
}

async function savePrivateShareState(input) {
  if (helperOwnerMismatch()) {
    state.error = getHelperMismatchError()
    render()
    return
  }
  const baseDeviceId = state.helper?.baseDeviceId
  if (!state.user || !baseDeviceId) {
    state.error = 'A local sharing device is required to manage private sharing'
    render()
    return
  }
  state.privateShareAction = input.refresh === true ? 'refresh' : 'toggle'
  state.privateShareSaving = true
  state.error = null
  render()
  try {
    const previousEnabled = !!state.privateShare?.enabled
    const expiryHours = input.expiryHours === undefined
      ? undefined
      : (input.expiryHours === 'none' ? null : parseInt(input.expiryHours, 10))
    const res = await fetch(`${API}/api/user/sharing`, {
      method: 'POST',
      headers: withSharingHeaders(getUserSharingToken()),
      body: JSON.stringify({
        privateSharing: {
          deviceId: state.selectedPrivateSlot ?? baseDeviceId,
          baseDeviceId,
          enabled: input.enabled,
          refresh: input.refresh === true,
          expiryHours,
        },
      }),
    })
    const data = await res.json()
    if (await handleAuthFailure(res.status, { preserveWhileSharing: true })) return
    if (!res.ok || data.error) throw new Error(data.error || 'Could not update private sharing')
    state.slotLimits = mapSlotLimits([...(data.slot_limits ?? []), ...Object.values(state.slotLimits ?? {})])
    applyPrivateShareRows(data.private_shares ?? (data.private_share ? [data.private_share] : state.privateShares), baseDeviceId, data.private_share?.device_id ?? state.selectedPrivateSlot)
    if (input.expiryHours !== undefined && state.privateShare) {
      state.privateExpiryHours = input.expiryHours
      clearPendingEdit('expiryHours')
    }
    clearPendingEdit('selectedSlotDeviceId')
    const enabledChanged = input.enabled !== undefined && previousEnabled !== !!state.privateShare?.enabled
    if (enabledChanged && state.isSharing) {
      state.shareToggling = true
      render()
      await chrome.runtime.sendMessage({ type: 'STOP_SHARING' }).catch(() => {})
      state.isSharing = false
      state.privateShareRestartRequired = true
      await refreshRuntimeStatus()
      state.shareToggling = false
    }
  } catch (err) {
    state.error = err.message || 'Could not update private sharing'
  } finally {
    state.privateShareSaving = false
    state.privateShareAction = null
    render()
  }
}

function startPeerPolling() {
  if (peerPollInterval) return
  peerPollInterval = setInterval(async () => {
    try {
      const res = await fetch(`${API}/api/peers/available`)
      const data = await res.json()
      const updated = {}
      data.peers?.forEach(p => { updated[p.country] = p.count })
      state.peerCounts = updated
      document.querySelectorAll('.country-btn').forEach(btn => {
        const count = state.peerCounts[btn.dataset.code] ?? 0
        btn.querySelector('.peers').textContent = count > 0 ? count + ' devices' : 'no devices'
        btn.classList.toggle('no-peers', count === 0)
      })
    } catch {}
  }, 30000)

  if (!statusPollInterval) {
    statusPollInterval = setInterval(async () => {
      const prevHelper = state.helper
      await refreshRuntimeStatus()
      await loadPrivateShareState(ownedHelper()?.baseDeviceId ?? null)
      const desktopSharing = !!(state.helper?.available && !helperOwnerMismatch() && (state.helper?.running || state.helper?.shareEnabled))
      // Detect unexpected stop: helper was starting (shareEnabled but not running), now fully stopped
      if (prevHelper?.shareEnabled && !prevHelper?.running && state.helper?.available && !state.helper?.running && !state.helper?.shareEnabled) {
        state.error = 'Sharing stopped unexpectedly. Your account may need phone verification. Check the desktop app for details.'
      }
      if (state.isSharing !== desktopSharing) {
        state.isSharing = desktopSharing
        await chrome.storage.local.set({ isSharing: desktopSharing })
      }
      render()
    }, 3000)
  }

  // Poll fresh profile stats from DB every 10s (matches dashboard refresh rate)
  if (!profilePollInterval) profilePollInterval = setInterval(async () => {
    const authToken = getUserSharingToken()
    if (!state.user || !authToken) return
    try {
      const res = await fetch(`${API}/api/user/sharing`, {
        headers: { 'Authorization': `Bearer ${authToken}` },
      })
      if (await handleAuthFailure(res.status, { preserveWhileSharing: true })) return
      if (!res.ok) return
      const data = await res.json()
      const previousProfileSync = state.profileSync
      const resolvedProfileSync = preferLatestSync(previousProfileSync, data.profile_sync ?? null)
      const shouldApplyProfileState = !previousProfileSync || resolvedProfileSync !== previousProfileSync || !data.profile_sync
      state.profileSync = resolvedProfileSync
      // dailyLimitMb is applied unconditionally — not gated by shouldApplyProfileState.
      // The sync timestamp comparison can silently drop the update if another surface
      // saved a limit and the server returns the same or older state_changed_at.
      if (data.daily_share_limit_mb !== undefined) {
        state.user = { ...state.user, dailyLimitMb: data.daily_share_limit_mb ?? null }
        if (!state.dailyLimitSaving && getPendingEdit('dailyLimitInput') === null) {
          state.dailyLimitInput = state.user.dailyLimitMb != null ? String(state.user.dailyLimitMb) : ''
        }
      }
      if (shouldApplyProfileState) {
        state.user = {
          ...state.user,
          totalShared: data.total_bytes_shared ?? state.user.totalShared,
          totalUsed: data.total_bytes_used ?? state.user.totalUsed,
          trustScore: data.trust_score ?? state.user.trustScore,
          isPremium: data.is_premium ?? state.user.isPremium ?? false,
          role: data.role ?? state.user.role ?? 'client',
          walletBalanceUsd: data.wallet_balance_usd ?? state.user.walletBalanceUsd ?? 0,
          contributionCreditsBytes: data.contribution_credits_bytes ?? state.user.contributionCreditsBytes ?? 0,
          walletPendingPayoutUsd: data.wallet_pending_payout_usd ?? state.user.walletPendingPayoutUsd ?? 0,
        }
      }
      if (data.has_accepted_provider_terms === true) state.hasAcceptedProviderTerms = true
      await chrome.storage.local.set({ user: state.user })
      document.querySelectorAll('.stat').forEach(el => {
        const lbl = el.querySelector('.lbl')?.textContent
        const val = el.querySelector('.val')
        if (!val) return
        if (lbl === 'SHARED') val.textContent = formatBytes(state.user.totalShared || 0)
        if (lbl === 'USED') val.textContent = formatBytes(state.user.totalUsed || 0)
        if (lbl === 'TRUST') val.textContent = String(state.user.trustScore || 50)
      })
    } catch {}
  }, 10000)
}

function startAuthPolling() {
  if (authPollInterval) { clearInterval(authPollInterval); authPollInterval = null }
  authPollInterval = setInterval(async () => {
    try {
      const res = await fetch(`${API}/api/extension-auth?ext_id=${state.extId}`)
      if (!res.ok) return
      const data = await res.json()
      if (data.user) {
        clearInterval(authPollInterval)
        authPollInterval = null
        state.user = data.user
        state.supabaseToken = data.user.supabaseToken ?? null
        state.hasAcceptedProviderTerms = data.user.hasAcceptedProviderTerms ?? false
        state.dailyLimitInput = data.user.dailyLimitMb != null ? String(data.user.dailyLimitMb) : ''
        state.loading = false
        await chrome.storage.local.set({ user: data.user, supabaseToken: state.supabaseToken, desktopToken: data.user.token })
        await refreshRuntimeStatus()
        await loadPrivateShareState(ownedHelper()?.baseDeviceId ?? null)
        render()
        startPeerPolling()
      }
    } catch {}
  }, 2000)
}

// Render

function render() {
  const app = document.getElementById('app')
  const focusedInput = captureFocusedInput()
  const scrollTop = captureScrollPosition()

  if (state.loading) {
    app.innerHTML = `<div class="loading"><div class="spinner"></div>LOADING...</div>`
    return
  }

  if (!state.user) {
    renderAuth(app)
    return
  }

  renderDashboard(app)
  restoreFocusedInput(focusedInput)
  restoreScrollPosition(scrollTop)
}

function renderAuth(app) {
  const offlineBanner = !state.isOnline
    ? `<div style="display:flex;align-items:center;gap:8px;background:rgba(255,170,0,0.08);border:1px solid rgba(255,170,0,0.35);border-radius:8px;padding:8px 12px;margin-bottom:12px;font-family:'Courier New',monospace;font-size:10px;color:#ffaa00">NO INTERNET - sign-in unavailable</div>`
    : ''
  app.innerHTML = `
    <div class="header">
      <span class="logo">PEERMESH</span>
    </div>
    <div class="auth-screen">
      <h2>Welcome</h2>
      <p>Sign in to start browsing.</p>
      ${offlineBanner}
      <div style="margin:20px 0;display:flex;align-items:center;justify-content:center;gap:8px;color:#666680;font-size:11px;font-family:'Courier New',monospace">
        <span style="display:inline-block;width:8px;height:8px;border:2px solid #1e1e2a;border-top-color:#00ff88;border-radius:50%;animation:spin 0.8s linear infinite"></span>
        WAITING FOR SIGN IN...
      </div>
      <button class="btn-primary" id="openDashboard" style="margin-top:4px" ${!state.isOnline ? 'disabled' : ''}>SIGN IN</button>
      <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
    </div>`

  document.getElementById('openDashboard').onclick = () => {
    chrome.tabs.create({ url: `${API}/extension?ext_id=${state.extId}` })
  }
}

function renderDashboard(app) {
  const { session, isSharing, sharePending, selectedCountry, user, helper } = state
  const helperMismatch = helperOwnerMismatch(helper, user)
  const activeHelper = helperMismatch ? null : helper
  const helperReady = !!activeHelper?.available
  const helperBaseDeviceId = activeHelper?.baseDeviceId ?? null
  const standaloneHelper = activeHelper?.source === 'extension'
  const configuredSlots = activeHelper?.slots?.configured ?? activeHelper?.connectionSlots ?? 1
  const activeSlots = activeHelper?.slots?.active ?? 0
  const privateSlotCount = Math.min(configuredSlots, state.privateShares.filter(s => s?.enabled).length)
  const publicSlotCount = Math.max(0, configuredSlots - privateSlotCount)
  const slotModeSummary = `${publicSlotCount} public / ${privateSlotCount} private`
  const slotMax = standaloneHelper ? 1 : 32
  const slotDots = Array.from({ length: configuredSlots }, (_, index) => {
    const running = !!activeHelper?.slots?.statuses?.[index]?.running || index < activeSlots
    return `<span style="width:8px;height:8px;border-radius:999px;background:${running ? 'var(--accent)' : 'var(--border)'};box-shadow:${running ? '0 0 8px rgba(0,255,136,0.35)' : 'none'}"></span>`
  }).join('')
  const helperSource = standaloneHelper ? 'Extension' : activeHelper?.source === 'cli' ? 'CLI' : helperReady ? 'Desktop' : 'PeerMesh'
  const freeTierBlocked = !hasPaidAccess(user) && !isSharing
  const publicConnectBlocked = freeTierBlocked
  const helperLabel = helperMismatch
    ? 'Local desktop helper belongs to another user. Sign out there first.'
    : standaloneHelper
    ? (isSharing
      ? 'Extension standalone sharing active - single-slot web mode.'
      : 'Extension standalone ready - one slot. Desktop or CLI adds full-browser tunnels and up to 32 slots.')
    : sharePending
      ? 'Helper is starting sharing...'
    : helperReady
      ? (isSharing ? `${helperSource} sharing active - earning credits.` : `${helperSource} helper detected - ready to share.`)
      : 'Sharing is unavailable right now.'
  const selectedSlotDeviceId = state.selectedPrivateSlot || state.privateShare?.device_id || (helperBaseDeviceId ? `${helperBaseDeviceId}_slot_0` : null)
  const selectedSlotLimit = selectedSlotDeviceId ? state.slotLimits?.[selectedSlotDeviceId] : null
  const slotsSyncLabel = formatSyncLabel(activeHelper?.connectionSlotsSync ?? null)
  const profileSyncLabel = formatSyncLabel(state.profileSync)
  const privateShareSyncLabel = formatSyncLabel(state.privateShare)
  const slotLimitSyncLabel = formatSyncLabel(selectedSlotLimit)

  const offlineBanner = !state.isOnline
    ? `<div style="display:flex;align-items:center;gap:8px;background:rgba(255,170,0,0.08);border:1px solid rgba(255,170,0,0.35);border-radius:8px;padding:8px 12px;margin:0 16px 8px;font-family:'Courier New',monospace;font-size:10px;color:#ffaa00">NO INTERNET - features unavailable</div>`
    : ''
  const errorBanner = state.error
    ? `<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px;background:rgba(255,68,102,0.08);border:1px solid rgba(255,68,102,0.25);border-radius:8px;padding:8px 12px;margin:0 16px 8px;font-size:11px;color:#ff6060;line-height:1.5">
        <span>${state.error}</span>
        <span style="display:flex;gap:8px;align-items:center;flex-shrink:0">
          ${/desktop/i.test(state.error) ? `<button id="desktopInstallBtn" style="background:none;border:none;color:#00ff88;font-family:'Courier New',monospace;font-size:10px;cursor:pointer;padding:0">DOWNLOAD</button>` : ''}
          <button id="dismissErrorBtn" style="background:none;border:none;color:#666680;cursor:pointer;font-size:13px;line-height:1;padding:0">x</button>
        </span>
       </div>`
    : ''
  const reconnectBanner = state.reconnectStatus
    ? `<div style="display:flex;align-items:center;gap:8px;background:rgba(0,255,136,0.08);border:1px solid rgba(0,255,136,0.22);border-radius:8px;padding:8px 12px;margin:0 16px 8px;font-family:'Courier New',monospace;font-size:10px;color:#00ff88;line-height:1.5">
        <span style="width:10px;height:10px;border:2px solid rgba(0,255,136,0.25);border-top-color:#00ff88;border-radius:50%;animation:spin 0.7s linear infinite;display:inline-block;flex-shrink:0"></span>
        <span>${state.reconnectStatus}</span>
       </div>`
    : ''
  const blockedBanner = state.failClosed && !session
    ? `<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;background:rgba(255,170,0,0.08);border:1px solid rgba(255,170,0,0.28);border-radius:8px;padding:9px 12px;margin:0 16px 8px;font-size:11px;color:#ffaa00;line-height:1.5">
        <span>PeerMesh protection is blocking browser traffic. Use direct browsing only if you are done routing through PeerMesh.</span>
        <button id="unblockBrowserBtn" style="background:none;border:1px solid rgba(255,170,0,0.35);border-radius:6px;color:#ffaa00;font-family:'Courier New',monospace;font-size:10px;cursor:pointer;white-space:nowrap;padding:4px 7px">UNBLOCK</button>
       </div>`
    : ''

  app.innerHTML = `
    <div class="header">
      <span class="logo">PEERMESH</span>
      <div class="status-pill ${session ? 'connected' : ''}">
        <div class="status-dot"></div>
        ${session ? `VIA ${session.country}` : state.failClosed ? 'BLOCKED' : 'DISCONNECTED'}
      </div>
    </div>
    ${offlineBanner}
    ${reconnectBanner}
    ${blockedBanner}
    ${errorBanner}
    <div style="margin:0 16px 8px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:rgba(255,255,255,0.03);font-family:'Courier New',monospace;font-size:10px;color:var(--muted);line-height:1.5">
      Press <span style="color:var(--accent)">Ctrl + Shift + P</span> on any page to open the PeerMesh session panel with country, connection state, reconnect status, and provider speed.
    </div>

    ${session ? `
    <div class="section">
      <div class="session-card">
        <div class="via">Browsing via peer</div>
        <div class="country-display">${getFlagForCountry(session.country)} ${session.country}</div>
        <div style="margin-top:6px;display:inline-block;font-family:'Courier New',monospace;font-size:9px;padding:2px 7px;border-radius:4px;background:rgba(0,255,136,0.08);border:1px solid rgba(0,255,136,0.24);color:#00ff88">${getSessionRouteLabel(session)}</div>
        <div style="margin-top:6px;display:inline-block;font-family:'Courier New',monospace;font-size:9px;padding:2px 7px;border-radius:4px;background:${state.connectionType === 'private' ? 'rgba(0,255,136,0.12)' : 'rgba(255,255,255,0.05)'};border:1px solid ${state.connectionType === 'private' ? 'rgba(0,255,136,0.35)' : '#1e1e2a'};color:${state.connectionType === 'private' ? '#00ff88' : '#666680'}">${state.connectionType === 'private' ? '\uD83D\uDD12 PRIVATE' : '\uD83C\uDF10 PUBLIC'}</div>
        ${session.quality ? `<div style="margin-top:8px;font-family:'Courier New',monospace;font-size:10px;color:var(--muted)">Provider speed: <span style="color:var(--accent)">${formatMbps(session.quality.currentMbps)}</span> now · ${formatMbps(session.quality.avgMbps)} avg</div>` : ''}
      </div>
      <button class="connect-btn disconnect" id="disconnectBtn" ${state.disconnecting ? 'disabled' : ''}>
        ${state.disconnecting
          ? `<span style="display:inline-flex;align-items:center;gap:8px"><span style="width:10px;height:10px;border:2px solid rgba(255,68,102,0.3);border-top-color:#ff4466;border-radius:50%;animation:spin 0.7s linear infinite;display:inline-block"></span>DISCONNECTING...</span>`
          : 'DISCONNECT'}
      </button>
    </div>
    ` : `
    <div class="section">
      <div class="section-label">Browse as...</div>
      <input id="countrySearchInput" value="${countriesSearch}" placeholder="Search country..." style="width:100%;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:'Courier New',monospace;font-size:11px;margin-bottom:8px;box-sizing:border-box" />
      ${countriesLoading
        ? `<div style="display:flex;align-items:center;gap:8px;padding:12px;color:var(--muted);font-family:'Courier New',monospace;font-size:11px">
             <span style="display:inline-block;width:10px;height:10px;border:2px solid var(--border);border-top-color:#00ff88;border-radius:50%;animation:spin 0.7s linear infinite"></span>
             LOADING COUNTRIES...
           </div>`
        : countriesError
          ? `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px;background:rgba(255,68,102,0.08);border:1px solid rgba(255,68,102,0.25);border-radius:8px">
               <span style="color:#ff6060;font-size:11px">Could not load countries</span>
               <button id="retryCountriesBtn" style="background:none;border:none;color:#00ff88;font-family:'Courier New',monospace;font-size:10px;cursor:pointer">RETRY</button>
             </div>`
          : `<div class="country-grid" id="countryGrid" style="${state.connecting ? 'pointer-events:none;opacity:0.5' : ''}">
               ${countriesData.map(c => {
                 const count = state.peerCounts[c.code] ?? 0
                 return `
                 <button class="country-btn ${selectedCountry === c.code ? 'selected' : ''} ${count === 0 ? 'no-peers' : ''}"
                         data-code="${c.code}">
                   <span class="flag">${c.flag}</span>
                   <span class="name">${c.name}</span>
                   <span class="peers">${count > 0 ? count + ' devices' : 'no devices'}</span>
                 </button>`
               }).join('')}
             </div>
             ${countriesTotalPages > 1 ? `
             <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px">
               <button id="countriesPrevBtn" ${countriesPage <= 1 ? 'disabled' : ''} style="background:none;border:1px solid var(--border);color:${countriesPage <= 1 ? 'var(--muted)' : 'var(--text)'};border-radius:6px;padding:4px 10px;font-family:'Courier New',monospace;font-size:10px;cursor:${countriesPage <= 1 ? 'not-allowed' : 'pointer'}">&lt; PREV</button>
               <span style="font-family:'Courier New',monospace;font-size:10px;color:var(--muted)">${countriesPage} / ${countriesTotalPages}</span>
               <button id="countriesNextBtn" ${countriesPage >= countriesTotalPages ? 'disabled' : ''} style="background:none;border:1px solid var(--border);color:${countriesPage >= countriesTotalPages ? 'var(--muted)' : 'var(--text)'};border-radius:6px;padding:4px 10px;font-family:'Courier New',monospace;font-size:10px;cursor:${countriesPage >= countriesTotalPages ? 'not-allowed' : 'pointer'}">NEXT &gt;</button>
             </div>` : ''}`
      }
    </div>
    <div class="section">
      <div class="section-label">Private code</div>
      <div style="display:grid;grid-template-columns:1fr auto;gap:8px">
        <input id="privateCodeInput" value="${state.privateCodeInput || ''}" placeholder="9-digit code" inputmode="numeric" maxlength="9" style="padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:'Courier New',monospace;font-size:11px;letter-spacing:1px" />
        <button class="connect-btn" id="connectPrivateBtn" style="padding:0 12px" ${!state.privateCodeInput || !state.isOnline || state.connecting ? 'disabled' : ''}>
          ${state.connecting && state.privateCodeInput ? '...' : 'CODE'}
        </button>
      </div>
      ${state.privateCodeRecent.length > 0 ? `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px">
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${state.privateCodeRecent.map(row => `
              <button class="recent-private-code-btn" data-code="${row.code}" style="padding:4px 7px;background:rgba(0,255,136,0.06);border:1px solid rgba(0,255,136,0.18);border-radius:6px;color:var(--accent);font-family:'Courier New',monospace;font-size:10px;letter-spacing:0.8px;cursor:pointer">${row.code}</button>
            `).join('')}
          </div>
          <button id="clearRecentPrivateCodesBtn" style="background:none;border:none;color:var(--muted);font-family:'Courier New',monospace;font-size:9px;cursor:pointer;white-space:nowrap;padding:0">CLEAR</button>
        </div>` : ''}
      <div style="margin-top:6px;font-size:10px;color:var(--muted);line-height:1.5">Locks the session to one known device and its active slots only.</div>
    </div>
    <div class="section">
      <button class="connect-btn" id="connectBtn" ${!selectedCountry || !state.isOnline || state.connecting || publicConnectBlocked ? 'disabled' : ''}>
        ${state.connecting
          ? `<span style="display:inline-flex;align-items:center;gap:8px"><span style="width:10px;height:10px;border:2px solid rgba(0,0,0,0.2);border-top-color:#000;border-radius:50%;animation:spin 0.7s linear infinite;display:inline-block"></span>CONNECTING...</span>`
          : !state.isOnline ? 'NO INTERNET'
          : selectedCountry ? `CONNECT ${getFlagForCountry(selectedCountry)} ${selectedCountry}`
          : 'SELECT A COUNTRY'}
      </button>
      ${state.error && !state.session ? `
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px;margin-top:8px;padding:8px 10px;background:rgba(255,68,102,0.08);border:1px solid rgba(255,68,102,0.25);border-radius:8px;font-size:11px;color:#ff6060;line-height:1.5">
          <span>${state.error}</span>
          <span style="display:flex;gap:8px;align-items:center;flex-shrink:0">
            <button id="retryConnectBtn" style="background:none;border:none;color:#00ff88;font-family:'Courier New',monospace;font-size:10px;cursor:pointer;white-space:nowrap;padding:0">RETRY</button>
            ${state.failClosed ? `<button id="stopBlockedBtn" style="background:none;border:none;color:#666680;font-family:'Courier New',monospace;font-size:10px;cursor:pointer;white-space:nowrap;padding:0">STOP</button>` : ''}
          </span>
        </div>` : ''}
    </div>
    `}

    ${publicConnectBlocked && !session && selectedCountry
      ? `<div class="section" style="background:rgba(255,68,102,0.08);border-top:1px solid rgba(255,68,102,0.2);border-bottom:1px solid rgba(255,68,102,0.2);font-size:11px;color:#ff9090;line-height:1.5">
           <span style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:0.5px">FREE TIER - </span>${FREE_TIER_MESSAGE.replace('FREE TIER - ', '')}
         </div>`
      : ''}

    <div class="section">
      <div class="share-row">
        <div class="share-info">
          <h4>Share my connection</h4>
          <p>${isSharing ? 'Sharing active - earning credits' : helperLabel}</p>
          ${isSharing ? `<div style="margin-top:4px;display:inline-block;font-family:'Courier New',monospace;font-size:9px;padding:2px 7px;border-radius:4px;background:rgba(255,255,255,0.05);border:1px solid #1e1e2a;color:#666680">${slotModeSummary}</div>` : ''}
          ${state.user?.dailyLimitMb != null ? `<p style="font-size:10px;color:var(--muted);margin-top:2px">${formatBytes((state.user.dailyLimitMb ?? 0) * 1024 * 1024)} daily limit</p>` : ''}
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
              <div>
                <div style="font-family:'Courier New',monospace;font-size:9px;color:var(--muted);letter-spacing:0.5px">CONNECTION SLOTS</div>
                <div style="margin-top:4px;display:flex;align-items:center;gap:5px;flex-wrap:wrap">${slotDots}</div>
                <p style="font-size:10px;color:var(--muted);margin-top:6px">${state.slotUpdating ? 'Updating slot count...' : `${activeSlots} / ${configuredSlots} slots active - ${slotModeSummary}${activeHelper?.slots?.warning ? ` - ${activeHelper.slots.warning}` : ''}`}</p>
                ${!state.slotUpdating && slotsSyncLabel ? `<p style="font-size:10px;color:var(--muted);margin-top:4px;font-family:'Courier New',monospace">${slotsSyncLabel}</p>` : ''}
              </div>
              <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
                <button id="decrementSlotsBtn" style="width:28px;height:28px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:${configuredSlots <= 1 ? 'var(--muted)' : 'var(--text)'};cursor:${configuredSlots <= 1 || state.slotUpdating || !helperReady ? 'not-allowed' : 'pointer'};font-family:'Courier New',monospace;font-size:16px" ${configuredSlots <= 1 || state.slotUpdating || !helperReady ? 'disabled' : ''}>-</button>
                <div style="min-width:28px;text-align:center;font-family:'Courier New',monospace;font-size:12px;color:var(--text)">${state.slotUpdating ? '...' : configuredSlots}</div>
                <button id="incrementSlotsBtn" style="width:28px;height:28px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:${configuredSlots >= slotMax ? 'var(--muted)' : 'var(--text)'};cursor:${configuredSlots >= slotMax || state.slotUpdating || !helperReady ? 'not-allowed' : 'pointer'};font-family:'Courier New',monospace;font-size:16px" ${configuredSlots >= slotMax || state.slotUpdating || !helperReady ? 'disabled' : ''}>+</button>
              </div>
            </div>
          </div>
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
            <div style="font-family:'Courier New',monospace;font-size:9px;color:var(--muted);letter-spacing:0.5px;margin-bottom:6px">DAILY SHARE LIMIT</div>
            <div style="display:grid;grid-template-columns:1fr auto;gap:6px">
              <input id="dailyLimitInput" value="${state.dailyLimitInput || ''}" placeholder="1024+ MB" inputmode="numeric" style="padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:'Courier New',monospace;font-size:10px" ${state.dailyLimitSaving || helperMismatch ? 'disabled' : ''} />
              <button id="saveDailyLimitBtn" style="padding:0 10px;background:var(--accent);border:none;border-radius:8px;color:#000;font-family:'Courier New',monospace;font-size:10px;font-weight:700;cursor:${state.dailyLimitSaving || helperMismatch ? 'not-allowed' : 'pointer'}" ${state.dailyLimitSaving || helperMismatch ? 'disabled' : ''}>${state.dailyLimitSaving ? 'APPLYING...' : 'APPLY'}</button>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
              <button id="dailyLimit1gbBtn" style="padding:6px 8px;background:${user?.dailyLimitMb === 1024 ? 'var(--accent-dim)' : 'var(--bg)'};border:1px solid ${user?.dailyLimitMb === 1024 ? 'rgba(0,255,136,0.35)' : 'var(--border)'};border-radius:7px;color:${user?.dailyLimitMb === 1024 ? 'var(--accent)' : 'var(--text)'};font-family:'Courier New',monospace;font-size:9px;cursor:${state.dailyLimitSaving || helperMismatch ? 'not-allowed' : 'pointer'}" ${state.dailyLimitSaving || helperMismatch ? 'disabled' : ''}>1 GB</button>
              <button id="dailyLimit2gbBtn" style="padding:6px 8px;background:${user?.dailyLimitMb === 2048 ? 'var(--accent-dim)' : 'var(--bg)'};border:1px solid ${user?.dailyLimitMb === 2048 ? 'rgba(0,255,136,0.35)' : 'var(--border)'};border-radius:7px;color:${user?.dailyLimitMb === 2048 ? 'var(--accent)' : 'var(--text)'};font-family:'Courier New',monospace;font-size:9px;cursor:${state.dailyLimitSaving || helperMismatch ? 'not-allowed' : 'pointer'}" ${state.dailyLimitSaving || helperMismatch ? 'disabled' : ''}>2 GB</button>
              <button id="dailyLimit5gbBtn" style="padding:6px 8px;background:${user?.dailyLimitMb === 5120 ? 'var(--accent-dim)' : 'var(--bg)'};border:1px solid ${user?.dailyLimitMb === 5120 ? 'rgba(0,255,136,0.35)' : 'var(--border)'};border-radius:7px;color:${user?.dailyLimitMb === 5120 ? 'var(--accent)' : 'var(--text)'};font-family:'Courier New',monospace;font-size:9px;cursor:${state.dailyLimitSaving || helperMismatch ? 'not-allowed' : 'pointer'}" ${state.dailyLimitSaving || helperMismatch ? 'disabled' : ''}>5 GB</button>
              <button id="dailyLimitNoneBtn" style="padding:6px 8px;background:${user?.dailyLimitMb == null ? 'var(--accent-dim)' : 'var(--bg)'};border:1px solid ${user?.dailyLimitMb == null ? 'rgba(0,255,136,0.35)' : 'var(--border)'};border-radius:7px;color:${user?.dailyLimitMb == null ? 'var(--accent)' : 'var(--text)'};font-family:'Courier New',monospace;font-size:9px;cursor:${state.dailyLimitSaving || helperMismatch ? 'not-allowed' : 'pointer'}" ${state.dailyLimitSaving || helperMismatch ? 'disabled' : ''}>NO LIMIT</button>
            </div>
            <p style="font-size:10px;color:var(--muted);margin-top:6px">${state.dailyLimitSaving ? 'Updating daily limit...' : `${user?.dailyLimitMb != null ? `${user.dailyLimitMb} MB/day cap.` : 'No daily cap set.'} Minimum custom limit: 1024 MB.${profileSyncLabel ? ` ${profileSyncLabel}` : ''}`}</p>
          </div>
          ${standaloneHelper ? `<p style="font-size:10px;color:var(--muted);margin-top:4px">Desktop or CLI is optional, but unlocks multi-slot sharing and tunnel support.</p>` : ''}
        </div>
        ${state.shareToggling
          ? `<div style="width:44px;height:24px;border-radius:12px;background:var(--border);display:flex;align-items:center;justify-content:center;flex-shrink:0">
               <span style="width:10px;height:10px;border:2px solid rgba(255,255,255,0.2);border-top-color:#00ff88;border-radius:50%;animation:spin 0.7s linear infinite;display:inline-block"></span>
             </div>`
          : `<label class="toggle">
               <input type="checkbox" id="shareToggle" ${isSharing ? 'checked' : ''} ${!helperReady || !state.isOnline || helperMismatch || sharePending ? 'disabled style="opacity:0.4;cursor:not-allowed"' : ''}>
               <span class="toggle-slider"></span>
             </label>`
        }
      </div>
    </div>

    ${helperBaseDeviceId ? `
    <div class="section">
      <div class="share-info" style="margin-bottom:10px">
        <h4>Private sharing</h4>
        <p>${state.privateShare?.active ? 'Pinned to selected slot.' : 'Per-slot code for trusted requesters.'}</p>
        ${state.privateShareSaving ? `<p style="font-size:10px;color:var(--muted);margin-top:6px;font-family:'Courier New',monospace">Waiting for the database to confirm the latest private-share state...</p>` : (privateShareSyncLabel ? `<p style="font-size:10px;color:var(--muted);margin-top:6px;font-family:'Courier New',monospace">${privateShareSyncLabel}</p>` : '')}
      </div>
      ${state.privateShares.length > 1 ? `
      <select id="privateSlotSelect" style="width:100%;margin-bottom:8px;padding:7px 8px;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:6px;font-family:'Courier New',monospace;font-size:10px">
        ${state.privateShares.map((s, i) => {
          const label = Number.isInteger(s.slot_index) ? `Slot ${s.slot_index + 1}` : `Slot ${i + 1}`
          const badge = s.enabled ? (s.active ? ' [ACTIVE]' : ' [ON]') : ' [OFF]'
          return `<option value="${s.device_id}" ${s.device_id === state.selectedPrivateSlot ? 'selected' : ''}>${label}${badge}</option>`
        }).join('')}
      </select>` : ''}
      <div style="margin-bottom:8px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg)">
        <div style="font-family:'Courier New',monospace;font-size:9px;color:var(--muted);letter-spacing:0.5px;margin-bottom:6px">SLOT DAILY LIMIT</div>
        <div style="display:grid;grid-template-columns:1fr auto;gap:6px">
          <input id="slotDailyLimitInput" value="${state.slotDailyLimitInput || ''}" placeholder="1024+ MB" inputmode="numeric" style="padding:8px 10px;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:'Courier New',monospace;font-size:10px" ${state.slotDailyLimitSaving || helperMismatch ? 'disabled' : ''} />
          <button id="saveSlotDailyLimitBtn" style="padding:0 10px;background:var(--accent);border:none;border-radius:8px;color:#000;font-family:'Courier New',monospace;font-size:10px;font-weight:700;cursor:${state.slotDailyLimitSaving || helperMismatch ? 'not-allowed' : 'pointer'}" ${state.slotDailyLimitSaving || helperMismatch ? 'disabled' : ''}>${state.slotDailyLimitSaving ? 'APPLYING...' : 'APPLY'}</button>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
          <button id="slotLimit1gbBtn" style="padding:6px 8px;background:${selectedSlotLimit?.daily_limit_mb === 1024 ? 'var(--accent-dim)' : 'var(--surface)'};border:1px solid ${selectedSlotLimit?.daily_limit_mb === 1024 ? 'rgba(0,255,136,0.35)' : 'var(--border)'};border-radius:7px;color:${selectedSlotLimit?.daily_limit_mb === 1024 ? 'var(--accent)' : 'var(--text)'};font-family:'Courier New',monospace;font-size:9px;cursor:${state.slotDailyLimitSaving || helperMismatch ? 'not-allowed' : 'pointer'}" ${state.slotDailyLimitSaving || helperMismatch ? 'disabled' : ''}>1 GB</button>
          <button id="slotLimit2gbBtn" style="padding:6px 8px;background:${selectedSlotLimit?.daily_limit_mb === 2048 ? 'var(--accent-dim)' : 'var(--surface)'};border:1px solid ${selectedSlotLimit?.daily_limit_mb === 2048 ? 'rgba(0,255,136,0.35)' : 'var(--border)'};border-radius:7px;color:${selectedSlotLimit?.daily_limit_mb === 2048 ? 'var(--accent)' : 'var(--text)'};font-family:'Courier New',monospace;font-size:9px;cursor:${state.slotDailyLimitSaving || helperMismatch ? 'not-allowed' : 'pointer'}" ${state.slotDailyLimitSaving || helperMismatch ? 'disabled' : ''}>2 GB</button>
          <button id="slotLimit5gbBtn" style="padding:6px 8px;background:${selectedSlotLimit?.daily_limit_mb === 5120 ? 'var(--accent-dim)' : 'var(--surface)'};border:1px solid ${selectedSlotLimit?.daily_limit_mb === 5120 ? 'rgba(0,255,136,0.35)' : 'var(--border)'};border-radius:7px;color:${selectedSlotLimit?.daily_limit_mb === 5120 ? 'var(--accent)' : 'var(--text)'};font-family:'Courier New',monospace;font-size:9px;cursor:${state.slotDailyLimitSaving || helperMismatch ? 'not-allowed' : 'pointer'}" ${state.slotDailyLimitSaving || helperMismatch ? 'disabled' : ''}>5 GB</button>
          <button id="slotLimitNoneBtn" style="padding:6px 8px;background:${selectedSlotLimit?.daily_limit_mb == null ? 'var(--accent-dim)' : 'var(--surface)'};border:1px solid ${selectedSlotLimit?.daily_limit_mb == null ? 'rgba(0,255,136,0.35)' : 'var(--border)'};border-radius:7px;color:${selectedSlotLimit?.daily_limit_mb == null ? 'var(--accent)' : 'var(--text)'};font-family:'Courier New',monospace;font-size:9px;cursor:${state.slotDailyLimitSaving || helperMismatch ? 'not-allowed' : 'pointer'}" ${state.slotDailyLimitSaving || helperMismatch ? 'disabled' : ''}>NO LIMIT</button>
        </div>
        <p style="font-size:10px;color:var(--muted);margin-top:6px">${state.slotDailyLimitSaving ? 'Updating slot limit...' : `${selectedSlotLimit?.daily_limit_mb != null ? `${selectedSlotLimit.daily_limit_mb} MB/day on selected slot.` : 'No slot cap on selected slot.'}${slotLimitSyncLabel ? ` ${slotLimitSyncLabel}` : ''}`}</p>
      </div>
      <div style="display:grid;grid-template-columns:1fr auto;gap:8px;margin-bottom:8px">
        <div style="padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;font-family:'Courier New',monospace;font-size:13px;letter-spacing:2px;color:${state.privateShare?.code ? 'var(--accent)' : 'var(--muted)'}">${state.privateShare?.code || 'CODE OFF'}</div>
        <button id="copyPrivateCodeBtn" style="padding:0 10px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:'Courier New',monospace;font-size:10px;cursor:${state.privateShare?.code ? 'pointer' : 'not-allowed'}" ${!state.privateShare?.code ? 'disabled' : ''}>COPY</button>
      </div>
      <div style="display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap">
        <select id="privateExpirySelect" style="background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-family:'Courier New',monospace;font-size:10px;cursor:pointer">
          <option value="none" ${state.privateExpiryHours === 'none' ? 'selected' : ''}>No expiry</option>
          <option value="1" ${state.privateExpiryHours === '1' ? 'selected' : ''}>1 hour</option>
          <option value="24" ${state.privateExpiryHours === '24' ? 'selected' : ''}>24 hours</option>
          <option value="168" ${state.privateExpiryHours === '168' ? 'selected' : ''}>7 days</option>
        </select>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="togglePrivateShareBtn" style="padding:7px 10px;background:${state.privateShare?.enabled ? 'transparent' : 'var(--accent)'};border:1px solid ${state.privateShare?.enabled ? 'var(--border)' : 'var(--accent)'};border-radius:7px;color:${state.privateShare?.enabled ? 'var(--text)' : '#000'};font-family:'Courier New',monospace;font-size:10px;cursor:${state.privateShareSaving ? 'not-allowed' : 'pointer'}" ${state.privateShareSaving ? 'disabled' : ''}>${state.privateShareSaving && state.privateShareAction !== 'refresh' ? 'SAVING...' : (state.privateShare?.enabled ? 'DISABLE' : 'ENABLE')}</button>
          <button id="refreshPrivateShareBtn" style="padding:7px 10px;background:transparent;border:1px solid var(--border);border-radius:7px;color:var(--text);font-family:'Courier New',monospace;font-size:10px;cursor:${state.privateShareSaving ? 'not-allowed' : 'pointer'}" ${state.privateShareSaving ? 'disabled' : ''}>${state.privateShareSaving && state.privateShareAction === 'refresh' ? 'REFRESHING...' : 'REFRESH'}</button>
        </div>
      </div>
      ${state.privateShareSaving ? `<div style="margin-top:8px;font-size:10px;color:var(--muted)">Updating private sharing...</div>` : ''}
      ${state.privateShare?.expires_at ? `<div style="margin-top:8px;font-size:10px;color:var(--muted)">Expires ${new Date(state.privateShare.expires_at).toLocaleString()}</div>` : ''}
      ${state.privateShareRestartRequired && !isSharing ? `<div style="margin-top:8px;font-size:10px;color:#ffaa00;background:rgba(255,170,0,0.08);border:1px solid rgba(255,170,0,0.25);border-radius:7px;padding:7px 9px;line-height:1.5">Sharing was stopped. Start sharing again to apply the new privacy setting.</div>` : ''}
    </div>` : ''}

    <div class="stats">
      <div class="stat">
        <span class="val">${isSharing && state.helper?.stats?.bytesServed > 0 ? formatBytes(state.helper.stats.bytesServed) : formatBytes(user.totalShared || 0)}</span>
        <span class="lbl">SHARED</span>
      </div>
      <div class="stat">
        <span class="val">${formatBytes(user.totalUsed || 0)}</span>
        <span class="lbl">USED</span>
      </div>
      <div class="stat">
        <span class="val">${user.trustScore || 50}</span>
        <span class="lbl">TRUST</span>
      </div>
    </div>

    <div style="padding:0 16px 12px;display:flex;justify-content:space-between;align-items:center">
      <span style="font-size:10px;color:var(--muted)">${user.username || user.email || ''}</span>
      <button id="signOutBtn" style="background:none;border:none;color:var(--muted);font-size:10px;cursor:pointer;font-family:'Courier New',monospace">SIGN OUT</button>
    </div>`

  if (!helperReady) {
    const shareSection = app.querySelector('.share-info')?.closest('.section')
    if (shareSection) {
      const helperNotice = document.createElement('div')
      helperNotice.style.cssText = 'font-size:11px;color:#ff6060;padding:6px 0 2px'
      helperNotice.innerHTML = helperMismatch
        ? getHelperMismatchError(helper)
        : 'Sharing is not ready yet. <a id="installHelperBtn" href="#" style="color:#00ff88;font-family:\'Courier New\',monospace;font-size:11px;text-decoration:underline">INSTALL DESKTOP</a> or run <code style="font-family:\'Courier New\',monospace;font-size:10px;color:#00ff88">npx peermesh-provider</code> for multi-slot tunnel sharing.'
      shareSection.appendChild(helperNotice)
    }
    const toggle = document.getElementById('shareToggle')
    if (toggle) { toggle.disabled = true; toggle.style.opacity = '0.4'; toggle.style.cursor = 'not-allowed' }
  }

  document.getElementById('dismissErrorBtn')?.addEventListener('click', () => { state.error = null; render() })
  document.getElementById('desktopInstallBtn')?.addEventListener('click', () => {
    chrome.tabs.create({ url: `${API}/api/desktop-download` })
  })
  document.getElementById('retryConnectBtn')?.addEventListener('click', () => { state.error = null; connectSession() })
  document.getElementById('stopBlockedBtn')?.addEventListener('click', disconnectSession)
  document.getElementById('unblockBrowserBtn')?.addEventListener('click', unblockBrowser)
  document.getElementById('retryCountriesBtn')?.addEventListener('click', () => loadCountries(countriesPage, countriesSearch))
  document.getElementById('countriesPrevBtn')?.addEventListener('click', () => loadCountries(countriesPage - 1, countriesSearch))
  document.getElementById('countriesNextBtn')?.addEventListener('click', () => loadCountries(countriesPage + 1, countriesSearch))
  document.getElementById('countrySearchInput')?.addEventListener('input', (e) => {
    countriesSearch = e.target.value
    clearTimeout(countriesSearchTimer)
    countriesSearchTimer = setTimeout(() => loadCountries(1, countriesSearch), 300)
  })
  document.querySelectorAll('.country-btn').forEach(btn => {
    btn.onclick = () => {
      state.selectedCountry = state.selectedCountry === btn.dataset.code ? null : btn.dataset.code
      state.privateCodeInput = ''
      state.error = null
      chrome.storage.local.set({ selectedCountry: state.selectedCountry, privateCodeInput: '' })
      render()
    }
  })

  document.getElementById('privateCodeInput')?.addEventListener('input', (e) => {
    state.privateCodeInput = e.target.value.replace(/\D/g, '').slice(0, 9)
    e.target.value = state.privateCodeInput
    setPendingEdit('privateCodeInput', state.privateCodeInput)
    state.error = null
    chrome.storage.local.set({ privateCodeInput: state.privateCodeInput })
    const btn = document.getElementById('connectPrivateBtn')
    if (btn) btn.disabled = !state.privateCodeInput || !state.isOnline || state.connecting
  })
  document.querySelectorAll('.recent-private-code-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.privateCodeInput = btn.dataset.code || ''
      state.selectedCountry = null
      state.error = null
      chrome.storage.local.set({ privateCodeInput: state.privateCodeInput, selectedCountry: null })
      render()
    })
  })
  document.getElementById('clearRecentPrivateCodesBtn')?.addEventListener('click', clearRecentPrivateCodes)
  document.getElementById('connectBtn')?.addEventListener('click', connectSession)
  document.getElementById('connectPrivateBtn')?.addEventListener('click', connectSession)
  document.getElementById('disconnectBtn')?.addEventListener('click', disconnectSession)
  document.getElementById('shareToggle')?.addEventListener('change', e => toggleSharing(e.target.checked))
  document.getElementById('signOutBtn')?.addEventListener('click', signOut)
  document.getElementById('installHelperBtn')?.addEventListener('click', (e) => {
    e.preventDefault()
    chrome.tabs.create({ url: `${API}/api/desktop-download` })
  })
  document.getElementById('copyPrivateCodeBtn')?.addEventListener('click', () => {
    if (state.privateShare?.code) navigator.clipboard.writeText(state.privateShare.code).catch(() => {})
  })
  document.getElementById('privateSlotSelect')?.addEventListener('change', (e) => {
    state.selectedPrivateSlot = e.target.value
    state.privateShare = selectPrivateShare(state.privateShares, e.target.value, ownedHelper()?.baseDeviceId ?? null)
    // Per-slot expiry: update from the newly selected slot's own expires_at
    state.privateExpiryHours = getPrivateShareExpiryPreset(state.privateShare?.expires_at ?? null)
    setPendingEdit('selectedSlotDeviceId', e.target.value)
    clearPendingEdit('expiryHours')
    syncSlotDailyLimitInput()
    render()
  })
  document.getElementById('privateExpirySelect')?.addEventListener('change', (e) => {
    state.privateExpiryHours = e.target.value
    setPendingEdit('expiryHours', e.target.value)
  })
  document.getElementById('togglePrivateShareBtn')?.addEventListener('click', () => {
    savePrivateShareState({ enabled: !(state.privateShare?.enabled ?? false), expiryHours: state.privateExpiryHours })
  })
  document.getElementById('refreshPrivateShareBtn')?.addEventListener('click', () => {
    savePrivateShareState({ enabled: true, refresh: true, expiryHours: state.privateExpiryHours })
  })
  document.getElementById('decrementSlotsBtn')?.addEventListener('click', () => {
    updateConnectionSlots(configuredSlots - 1)
  })
  document.getElementById('incrementSlotsBtn')?.addEventListener('click', () => {
    updateConnectionSlots(configuredSlots + 1)
  })
  document.getElementById('dailyLimitInput')?.addEventListener('input', (e) => {
    state.dailyLimitInput = e.target.value.replace(/\D/g, '')
    e.target.value = state.dailyLimitInput
    setPendingEdit('dailyLimitInput', state.dailyLimitInput)
    state.error = null
  })
  document.getElementById('dailyLimitInput')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const raw = (e.target.value || '').trim()
    clearPendingEdit('dailyLimitInput')
    void saveDailyLimit(raw ? parseInt(raw, 10) : null)
  })
  document.getElementById('saveDailyLimitBtn')?.addEventListener('click', () => {
    const raw = (document.getElementById('dailyLimitInput')?.value || '').trim()
    clearPendingEdit('dailyLimitInput')
    void saveDailyLimit(raw ? parseInt(raw, 10) : null)
  })
  document.getElementById('dailyLimit1gbBtn')?.addEventListener('click', () => {
    state.dailyLimitInput = '1024'
    clearPendingEdit('dailyLimitInput')
    void saveDailyLimit(1024)
  })
  document.getElementById('dailyLimit2gbBtn')?.addEventListener('click', () => {
    state.dailyLimitInput = '2048'
    clearPendingEdit('dailyLimitInput')
    void saveDailyLimit(2048)
  })
  document.getElementById('dailyLimit5gbBtn')?.addEventListener('click', () => {
    state.dailyLimitInput = '5120'
    clearPendingEdit('dailyLimitInput')
    void saveDailyLimit(5120)
  })
  document.getElementById('dailyLimitNoneBtn')?.addEventListener('click', () => {
    state.dailyLimitInput = ''
    clearPendingEdit('dailyLimitInput')
    void saveDailyLimit(null)
  })
  document.getElementById('slotDailyLimitInput')?.addEventListener('input', (e) => {
    state.slotDailyLimitInput = e.target.value.replace(/\D/g, '')
    e.target.value = state.slotDailyLimitInput
    setPendingEdit('slotDailyLimitInput', state.slotDailyLimitInput)
    state.error = null
  })
  document.getElementById('slotDailyLimitInput')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const raw = (e.target.value || '').trim()
    clearPendingEdit('slotDailyLimitInput')
    void saveSlotDailyLimit(raw ? parseInt(raw, 10) : null)
  })
  document.getElementById('saveSlotDailyLimitBtn')?.addEventListener('click', () => {
    const raw = (document.getElementById('slotDailyLimitInput')?.value || '').trim()
    clearPendingEdit('slotDailyLimitInput')
    void saveSlotDailyLimit(raw ? parseInt(raw, 10) : null)
  })
  document.getElementById('slotLimit1gbBtn')?.addEventListener('click', () => {
    state.slotDailyLimitInput = '1024'
    clearPendingEdit('slotDailyLimitInput')
    void saveSlotDailyLimit(1024)
  })
  document.getElementById('slotLimit2gbBtn')?.addEventListener('click', () => {
    state.slotDailyLimitInput = '2048'
    clearPendingEdit('slotDailyLimitInput')
    void saveSlotDailyLimit(2048)
  })
  document.getElementById('slotLimit5gbBtn')?.addEventListener('click', () => {
    state.slotDailyLimitInput = '5120'
    clearPendingEdit('slotDailyLimitInput')
    void saveSlotDailyLimit(5120)
  })
  document.getElementById('slotLimitNoneBtn')?.addEventListener('click', () => {
    state.slotDailyLimitInput = ''
    clearPendingEdit('slotDailyLimitInput')
    void saveSlotDailyLimit(null)
  })

  // Disclosure modal
  if (state.showDisclosure) {
    const overlay = document.createElement('div')
    overlay.id = 'pm-disclosure'
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.82);display:flex;align-items:center;justify-content:center;z-index:999;padding:16px'
    overlay.innerHTML = `
      <div style="background:#13131a;border:1px solid #1e1e2a;border-radius:14px;padding:22px;max-width:320px;width:100%">
        <div style="font-family:'Courier New',monospace;font-size:10px;color:#00ff88;letter-spacing:1px;margin-bottom:10px">BEFORE YOU SHARE</div>
        <div style="font-size:14px;font-weight:600;margin-bottom:14px;line-height:1.3">What sharing your connection means</div>
        ${[
          ['WEB', 'Your IP address will be used by other PeerMesh users to browse the web.'],
          ['LOCK', 'All sessions are logged with signed receipts.'],
          ['BLOCK', 'Blocked: .onion sites, SMTP/IMAP/POP3 hosts, torrents, private IPs.'],
          ['STOP', 'You can stop sharing at any time.'],
          ['CREDITS', 'Sharing earns you free browsing credits.'],
        ].map(([icon, text]) => `
          <div style="display:flex;gap:10px;margin-bottom:10px;font-size:12px;color:#666680;line-height:1.5">
            <span style="flex-shrink:0">${icon}</span><span>${text}</span>
          </div>`).join('')}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:16px">
          <button id="pm-disclose-cancel" style="padding:10px;background:none;border:1px solid #1e1e2a;border-radius:8px;color:#666680;cursor:pointer;font-family:'Courier New',monospace;font-size:10px">CANCEL</button>
          <button id="pm-disclose-accept" style="padding:10px;background:#00ff88;border:none;border-radius:8px;color:#000;cursor:pointer;font-family:'Courier New',monospace;font-size:10px;font-weight:700">I UNDERSTAND - SHARE</button>
        </div>
      </div>`
    document.body.appendChild(overlay)
    document.getElementById('pm-disclose-cancel').onclick = () => {
      state.showDisclosure = false
      // Uncheck the toggle visually
      const toggle = document.getElementById('shareToggle')
      if (toggle) toggle.checked = false
      overlay.remove()
    }
    document.getElementById('pm-disclose-accept').onclick = async () => {
      state.showDisclosure = false
      state.hasAcceptedProviderTerms = true
      try {
        await fetch(`${API}/api/user/sharing`, {
          method: 'POST',
          headers: withSharingHeaders(state.supabaseToken || state.user?.token),
          body: JSON.stringify({ acceptProviderTerms: true }),
        })
      } catch {}
      overlay.remove()
      toggleSharing(true)
    }
  }
}

// Actions

async function requireDesktopForBrowsing() {
  const status = await chrome.runtime.sendMessage({ type: 'GET_DESKTOP_REQUIRED_STATUS' }).catch(() => null)
  if (status?.available) {
    if (/desktop/i.test(state.error || '')) state.error = null
    return true
  }
  state.error = 'PeerMesh Desktop is starting or unavailable. Keep the desktop app installed and retry in a few seconds.'
  state.reconnectStatus = null
  render()
  return false
}

async function createSessionWithOnDemandRetry({ authToken, isPrivateConnect, privateCode }) {
  let lastQueuedMessage = null
  const attempts = isPrivateConnect ? PRIVATE_ON_DEMAND_MAX_ATTEMPTS : 1
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const res = await fetch(`${API}/api/session/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify(isPrivateConnect ? { privateCode } : { country: state.selectedCountry }),
    })

    const data = await res.json()
    if (await handleAuthFailure(res.status, { preserveWhileSharing: true })) {
      state.connecting = false
      return { aborted: true }
    }
    if ((!res.ok || data.error) && data.nextStep) {
      chrome.tabs.create({ url: `${API}${data.nextStep}` }).catch(() => {})
    }
    if (!res.ok || data.error) {
      if (isPrivateConnect && data.onDemandStartQueued && attempt < attempts - 1) {
        lastQueuedMessage = data.error ?? 'Private provider is starting. Retrying...'
        state.reconnectStatus = data.providerReachable
          ? 'Private provider is reachable. Starting sharing and retrying...'
          : 'Private on-demand start queued. Waiting for the provider to come online...'
        state.error = null
        render()
        const retryMs = Math.max(3000, Math.min(30000, Number(data.retryAfterSeconds ?? 5) * 1000))
        await sleep(retryMs)
        continue
      }
      throw new Error(data.error ?? `Server error (${res.status})`)
    }
    return { data }
  }
  throw new Error(lastQueuedMessage ?? 'Private provider did not come online in time. Try again shortly.')
}

async function connectSession() {
  const privateCode = (state.privateCodeInput || '').trim()
  // Country selected = public mode; clear any stale private code
  if (state.selectedCountry && privateCode) {
    state.privateCodeInput = ''
    chrome.storage.local.set({ privateCodeInput: '' })
  }
  const isPrivateConnect = !state.selectedCountry && !!privateCode
  if ((!state.selectedCountry && !privateCode) || !state.user || state.connecting) return

  if (!state.isOnline) {
    state.error = 'No internet connection - check your network and try again'
    render()
    return
  }

  if (!await requireDesktopForBrowsing()) return

  state.connecting = true
  state.error = null
  state.reconnectStatus = null
  render()

  let preparedFailClosedReconnect = false
  try {
    if (state.failClosed) {
      const prepared = await chrome.runtime.sendMessage({ type: 'PREPARE_RECONNECT' }).catch(() => null)
      preparedFailClosedReconnect = !!prepared?.cleared
    }
    // Always prefer the long-lived desktop token for relay auth.
    // supabaseToken is a short-lived Supabase JWT (1h) that may be stale in storage.
    const authToken = state.user.token || state.supabaseToken
    const created = await createSessionWithOnDemandRetry({ authToken, isPrivateConnect, privateCode })
    if (created?.aborted) {
      if (preparedFailClosedReconnect) {
        await chrome.runtime.sendMessage({ type: 'RESTORE_FAIL_CLOSED', reason: 'PeerMesh reconnect was interrupted' }).catch(() => {})
      }
      return
    }
    const data = created.data

    const response = await chrome.runtime.sendMessage({
      type: 'CONNECT',
      relayEndpoint: data.relayEndpoint,
      relayFallbackList: data.relayFallbackList ?? [data.relayEndpoint],
      country: data.country ?? state.selectedCountry,
      userId: state.user.id,
      dbSessionId: data.sessionId,
      preferredProviderUserId: data.preferredProviderUserId ?? null,
      privateProviderUserId: data.privateProviderUserId ?? null,
      privateBaseDeviceId: data.privateBaseDeviceId ?? null,
      privateCode: isPrivateConnect ? privateCode : null,
      connectionType: isPrivateConnect ? 'private' : 'public',
      token: authToken,
    })

    if (!response?.success) throw new Error(response?.error || 'Connection failed')

    state.session = { id: data.sessionId, country: data.country ?? state.selectedCountry, relayEndpoint: data.relayEndpoint }
    state.connectionType = isPrivateConnect ? 'private' : 'public'
    state.failClosed = false
    state.reconnectStatus = null
    if (isPrivateConnect) await rememberPrivateCode(privateCode)
    await chrome.storage.local.set({ session: state.session, connectionType: state.connectionType })
  } catch (err) {
    state.error = err.message === 'Failed to fetch' ? 'Network error - could not reach server' : err.message
    if (preparedFailClosedReconnect && !state.session) {
      await chrome.runtime.sendMessage({ type: 'RESTORE_FAIL_CLOSED', reason: state.error }).catch(() => {})
    }
  } finally {
    state.connecting = false
    render()
  }
}

async function disconnectSession() {
  if (state.disconnecting) return
  state.disconnecting = true
  render()

  await chrome.runtime.sendMessage({ type: 'DISCONNECT' }).catch(() => {})
  if (state.session) {
    try {
      await fetch(`${API}/api/session/end`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${state.supabaseToken || state.user?.token}`,
        },
        body: JSON.stringify({ sessionId: state.session.id }),
      })
    } catch {}
  }

  state.session = null
  state.connectionType = 'public'
  state.failClosed = false
  state.reconnectStatus = null
  state.disconnecting = false
  await chrome.storage.local.set({ session: null, connectionType: 'public' })
  render()
}

async function unblockBrowser() {
  if (state.disconnecting) return
  state.disconnecting = true
  state.error = null
  render()

  const response = await chrome.runtime.sendMessage({ type: 'UNBLOCK_BROWSER' }).catch(() => null)
  if (!response?.success) {
    await chrome.runtime.sendMessage({ type: 'DISCONNECT' }).catch(() => {})
  }

  state.session = null
  state.connectionType = 'public'
  state.failClosed = false
  state.reconnectStatus = null
  state.disconnecting = false
  await chrome.storage.local.set({ session: null, connectionType: 'public' })
  render()
}

async function toggleSharing(on) {
  if (state.shareToggling) return
  if (helperOwnerMismatch()) {
    state.error = getHelperMismatchError()
    render()
    return
  }

  // First-time share - show disclosure modal
  if (on && !state.hasAcceptedProviderTerms) {
    state.showDisclosure = true
    render()
    return
  }

  state.shareToggling = true
  render()

  if (on && !state.isOnline) {
    state.error = 'No internet connection - sharing requires an active network'
    state.shareToggling = false
    render()
    return
  }

  if (on && !ownedHelper()?.available) {
    await refreshRuntimeStatus()
    if (!ownedHelper()?.available) {
      state.error = 'Sharing is unavailable right now - retry in a few seconds'
      state.shareToggling = false
      render()
      return
    }
  }

  const previous = state.isSharing
  state.isSharing = on
  state.sharePending = false
  render()

  const response = await chrome.runtime.sendMessage({
    type: on ? 'START_SHARING' : 'STOP_SHARING',
    country: state.user?.country_code || state.user?.country,
    userId: state.user?.id,
    token: state.user?.token,
    supabaseToken: state.supabaseToken,
    desktopToken: state.user?.token,
    trust: state.user?.trustScore || state.user?.trust_score || 50,
  })

  if (!response?.success) {
    state.isSharing = previous
    state.sharePending = false
    state.helper = response?.helper || state.helper
    state.shareToggling = false
    state.error = response?.error === 'Failed to fetch'
      ? 'Network error - could not reach the sharing service'
      : (response?.error || 'Sharing could not be started')
    render()
    return
  }

  state.error = null
  state.isSharing = false
  if (on) state.privateShareRestartRequired = false
  state.helper = response.helper || state.helper
  await chrome.storage.local.set({ isSharing: on, helper: state.helper })

  try {
    await fetch(`${API}/api/user/sharing`, {
      method: 'POST',
      headers: withSharingHeaders(state.supabaseToken || state.user?.token),
      body: JSON.stringify({ isSharing: on }),
    })
  } catch {}

  await refreshRuntimeStatus()
  state.shareToggling = false
  render()
}

async function updateConnectionSlots(slots) {
  if (state.slotUpdating) return
  if (helperOwnerMismatch()) {
    state.error = getHelperMismatchError()
    render()
    return
  }

  const helperReady = !!ownedHelper()?.available
  if (!helperReady) {
    state.error = 'A local desktop or CLI helper is required to change connection slots'
    render()
    return
  }

  const slotMax = ownedHelper()?.source === 'extension' ? 1 : 32
  const nextSlots = Math.max(1, Math.min(slotMax, parseInt(String(slots), 10) || 1))
  const currentSlots = ownedHelper()?.slots?.configured ?? ownedHelper()?.connectionSlots ?? 1
  if (nextSlots === currentSlots) return

  state.slotUpdating = true
  state.error = null
  render()

  try {
    const response = await chrome.runtime.sendMessage({ type: 'SET_CONNECTION_SLOTS', slots: nextSlots })
    if (!response?.success) throw new Error(response?.error || 'Could not update connection slots')
    state.helper = response.helper || state.helper
    await chrome.storage.local.set({ helper: state.helper })
    await refreshRuntimeStatus()
    await loadPrivateShareState(ownedHelper()?.baseDeviceId ?? null)
  } catch (err) {
    state.error = err.message || 'Could not update connection slots'
  } finally {
    state.slotUpdating = false
    render()
  }
}

async function saveDailyLimit(limitMb) {
  if (state.dailyLimitSaving) return
  if (helperOwnerMismatch()) {
    state.error = getHelperMismatchError()
    render()
    return
  }
  if (limitMb !== null && (!Number.isInteger(limitMb) || limitMb < DAILY_LIMIT_MIN_MB)) {
    state.error = `Minimum daily limit is ${DAILY_LIMIT_MIN_MB} MB (1 GB)`
    render()
    return
  }

  state.dailyLimitSaving = true
  state.error = null
  render()

  try {
    const res = await fetch(`${API}/api/user/sharing`, {
      method: 'POST',
      headers: withSharingHeaders(state.supabaseToken || state.user?.token),
      body: JSON.stringify({ dailyLimitMb: limitMb }),
    })
    const data = await res.json().catch(() => ({}))
    if (await handleAuthFailure(res.status, { preserveWhileSharing: true })) return
    if (!res.ok || data.error) throw new Error(data.error || 'Could not update daily limit')

    state.profileSync = preferLatestSync(state.profileSync, data.profile_sync ?? null)
    state.user = {
      ...state.user,
      dailyLimitMb: data.daily_share_limit_mb ?? null,
    }
    state.dailyLimitInput = state.user.dailyLimitMb != null ? String(state.user.dailyLimitMb) : ''
    clearPendingEdit('dailyLimitInput')
    await chrome.storage.local.set({ user: state.user })
  } catch (err) {
    state.error = err.message || 'Could not update daily limit'
  } finally {
    state.dailyLimitSaving = false
    render()
  }
}

async function saveSlotDailyLimit(limitMb) {
  if (state.slotDailyLimitSaving) return
  if (helperOwnerMismatch()) {
    state.error = getHelperMismatchError()
    render()
    return
  }
  if (limitMb !== null && (!Number.isInteger(limitMb) || limitMb < DAILY_LIMIT_MIN_MB)) {
    state.error = `Minimum slot limit is ${DAILY_LIMIT_MIN_MB} MB (1 GB)`
    render()
    return
  }

  const baseDeviceId = ownedHelper()?.baseDeviceId
  const slotDeviceId = state.selectedPrivateSlot || state.privateShare?.device_id || (baseDeviceId ? `${baseDeviceId}_slot_0` : null)
  if (!baseDeviceId || !slotDeviceId) {
    state.error = 'Select a slot first to set a per-slot limit'
    render()
    return
  }

  state.slotDailyLimitSaving = true
  state.error = null
  render()

  try {
    const res = await fetch(`${API}/api/user/sharing`, {
      method: 'POST',
      headers: withSharingHeaders(state.supabaseToken || state.user?.token),
      body: JSON.stringify({
        slotDailyLimitMb: limitMb,
        slotDeviceId,
        baseDeviceId,
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (await handleAuthFailure(res.status, { preserveWhileSharing: true })) return
    if (!res.ok || data.error) throw new Error(data.error || 'Could not update slot daily limit')

    state.slotLimits = mapSlotLimits([...(data.slot_limits ?? []), ...Object.values(state.slotLimits ?? {})])
    clearPendingEdit('slotDailyLimitInput')
    syncSlotDailyLimitInput()
  } catch (err) {
    state.error = err.message || 'Could not update slot daily limit'
  } finally {
    state.slotDailyLimitSaving = false
    render()
  }
}

async function signOut() {
  if (!confirm('Sign out of PeerMesh?')) return
  stopPeerPolling()
  if (authPollInterval) { clearInterval(authPollInterval); authPollInterval = null }
  if (state.isSharing) {
    await chrome.runtime.sendMessage({ type: 'STOP_SHARING' }).catch(() => {})
  }
  await disconnectSession()
  // Revoke device_codes on server so desktop and CLI are also signed out
  const revokeToken = getUserSharingToken()
  if (state.user?.id && revokeToken) {
    try {
      await fetch(`${API}/api/extension-auth/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${revokeToken}` },
        body: JSON.stringify({ userId: state.user.id }),
      })
    } catch {}
  }
  state.user = null
  state.session = null
  state.isSharing = false
  state.sharePending = false
  state.helper = null
  state.dailyLimitInput = ''
  state.dailyLimitSaving = false
  state.slotLimits = {}
  state.slotDailyLimitInput = ''
  state.slotDailyLimitSaving = false
  state.privateShare = null
  state.privateShares = []
  state.selectedPrivateSlot = null
  await chrome.storage.local.clear()
  // Preserve extId so auth polling can resume
  await chrome.storage.local.set({ extId: state.extId })
  render()
  startAuthPolling()
}

// Helpers

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`
}

// Debug log panel

const logEntries = []

function appendLog(entry) {
  logEntries.push(entry)
  if (logEntries.length > 200) logEntries.shift()
  const panel = document.getElementById('pm-log-body')
  if (!panel) return
  const line = document.createElement('div')
  line.style.cssText = `color:${entry.level === 'error' ? '#ff6060' : entry.level === 'warn' ? '#ffaa00' : '#aaa'};margin:1px 0;word-break:break-all`
  line.textContent = `${entry.ts} ${entry.msg}`
  panel.appendChild(line)
  panel.scrollTop = panel.scrollHeight
}

async function initLogPanel() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_LOGS' })
    if (res?.logs) res.logs.forEach(appendLog)
  } catch {}
}

// Message listener

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'LOG') appendLog(msg.entry)

  if (msg.type === 'AUTH_SUCCESS') {
    state.user = msg.user
    chrome.storage.local.set({ user: msg.user })
    render()
  }

  // Relay found a new provider transparently - update sessionId, no UI disruption
  if (msg.type === 'SESSION_RECONNECTED') {
    if (state.session) {
      state.session = { ...state.session, id: msg.sessionId }
      chrome.storage.local.set({ session: state.session })
    }
    state.failClosed = false
    state.reconnectStatus = null
    render()
    // Brief visual pulse on the status pill so user knows a switch happened
    const pill = document.querySelector('.status-pill')
    if (pill) {
      pill.style.opacity = '0.4'
      setTimeout(() => { pill.style.opacity = '1' }, 600)
    }
  }

  if (msg.type === 'SESSION_RECONNECTING') {
    state.failClosed = true
    state.reconnectStatus = msg.reason || 'Provider reconnecting. Traffic is blocked until PeerMesh resumes.'
    state.error = null
    render()
  }

  if (msg.type === 'SESSION_QUALITY') {
    if (state.session) {
      const currentId = state.session.id || state.session.sessionId
      if (!msg.sessionId || !currentId || currentId === msg.sessionId) {
        state.session = { ...state.session, quality: msg.quality }
        chrome.storage.local.set({ session: state.session })
        render()
      }
    }
  }

  // Provider dropped and relay gave up finding a replacement
  if (msg.type === 'SESSION_ENDED') {
    state.session = null
    state.failClosed = true
    state.reconnectStatus = 'Traffic is blocked until PeerMesh reconnects or you disconnect.'
    state.error = msg.reason
      ? `Connection lost - ${msg.reason}. Retry to reconnect.`
      : 'Connection lost - your peer disconnected. Retry to reconnect.'
    chrome.storage.local.set({ session: null })
    render()
  }
})

function renderLogPanel() {
  const existing = document.getElementById('pm-log-panel')
  if (existing) return
  const panel = document.createElement('div')
  panel.id = 'pm-log-panel'
  panel.innerHTML = `
    <div id="pm-log-toggle" style="padding:6px 16px;font-size:10px;color:#444;cursor:pointer;font-family:'Courier New',monospace;display:flex;justify-content:space-between;border-top:1px solid #1a1a2a">
      <span>DEBUG LOGS</span><span id="pm-log-arrow">v</span>
    </div>
    <div id="pm-log-body" style="display:none;max-height:160px;overflow-y:auto;padding:4px 16px 8px;font-size:10px;font-family:'Courier New',monospace;background:#050508"></div>
    <div style="padding:2px 16px 8px;display:flex;gap:6px">
      <button id="pm-log-copy" style="background:none;border:1px solid #222;color:#555;font-size:9px;font-family:'Courier New',monospace;cursor:pointer;padding:2px 8px;border-radius:3px">COPY</button>
      <button id="pm-log-clear" style="background:none;border:1px solid #222;color:#555;font-size:9px;font-family:'Courier New',monospace;cursor:pointer;padding:2px 8px;border-radius:3px">CLEAR</button>
    </div>`
  document.body.appendChild(panel)

  logEntries.forEach(e => {
    const line = document.createElement('div')
    line.style.cssText = `color:${e.level === 'error' ? '#ff6060' : e.level === 'warn' ? '#ffaa00' : '#aaa'};margin:1px 0;word-break:break-all`
    line.textContent = `${e.ts} ${e.msg}`
    document.getElementById('pm-log-body').appendChild(line)
  })

  let open = false
  document.getElementById('pm-log-toggle').onclick = () => {
    open = !open
    document.getElementById('pm-log-body').style.display = open ? 'block' : 'none'
    document.getElementById('pm-log-arrow').textContent = open ? '^' : 'v'
    if (open) document.getElementById('pm-log-body').scrollTop = document.getElementById('pm-log-body').scrollHeight
  }
  document.getElementById('pm-log-copy').onclick = () => {
    const text = logEntries.map(e => `${e.ts} [${e.level}] ${e.msg}`).join('\n')
    navigator.clipboard.writeText(text).catch(() => {})
  }
  document.getElementById('pm-log-clear').onclick = () => {
    logEntries.length = 0
    document.getElementById('pm-log-body').innerHTML = ''
  }
}

init()
