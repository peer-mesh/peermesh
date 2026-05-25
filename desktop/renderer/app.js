const api = window.peermesh || {}

const startupBusy = {
  launchOnStartup: false,
  autoShareOnLaunch: false,
  preventSleepWhileSharing: false,
  sharingSchedule: false,
  scheduleWakeEnabled: false,
  onDemandWake: false,
  privateOnDemandStart: false,
}

const startupPending = {
  scheduleWakeEnabled: null,
}

let devicePollInterval = null
let deviceFlowActive = false
let signingIn = false
let togglingShare = false // 'idle' | 'starting' | 'stopping'
let _shareState = 'idle'
function setShareState(s) { _shareState = s; togglingShare = s !== 'idle' }
let privateShare = null
let privateShares = []
let privateShareDeviceId = null
let privateShareSelectionLocked = false
let privateShareSaving = false
let privateShareAction = null
let privateShareExpiry = 'none'
let slotLimits = {}
let slotDailyLimitInput = ''
let slotDailyLimitSaving = false
let dailyLimitSaving = false
let sharingScheduleSaving = false
let slotUpdating = false
let lastPrivateShareLoadAt = 0
let desktopUpdateBusy = false
const PRIVATE_SHARE_REFRESH_TTL = 2500

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

function invoke(name, ...args) {
  const fn = api[name]
  if (typeof fn !== 'function') return Promise.resolve(null)
  return fn(...args)
}

function getBrowserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
  } catch {
    return 'local'
  }
}

function normalizeScheduleTime(value, fallback = '00:00') {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim())
  if (!match) return fallback
  const hours = parseInt(match[1], 10)
  const minutes = parseInt(match[2], 10)
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return fallback
  }
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function normalizeSharingSchedule(schedule = {}) {
  return {
    enabled: schedule.enabled === true,
    startTime: normalizeScheduleTime(schedule.startTime),
    endTime: normalizeScheduleTime(schedule.endTime),
    timezone: String(schedule.timezone || getBrowserTimeZone()).trim() || getBrowserTimeZone(),
    active: schedule.active === true,
    alwaysOn: schedule.alwaysOn === true || (schedule.enabled === true && normalizeScheduleTime(schedule.startTime) === normalizeScheduleTime(schedule.endTime)),
  }
}

function setVersion(version) {
  if (!version) return
  const tag = document.getElementById('version-tag')
  if (tag) tag.textContent = `v${version}`
}

// Set version immediately on load
setVersion(api.version)

function setToggleVisual(element, { on = false, loading = false, disabled = false } = {}) {
  if (!element) return
  const classes = ['toggle']
  if (on) classes.push('on')
  if (loading) classes.push('loading')
  element.className = classes.join(' ')
  element.disabled = disabled || loading
  const row = element.closest('.toggle-row')
  if (row) row.classList.toggle('disabled', !!element.disabled)
  element.setAttribute('aria-disabled', element.disabled ? 'true' : 'false')
}

function setOffline(isOffline) {
  const authBanner = document.getElementById('offline-banner')
  const mainBanner = document.getElementById('main-offline-banner')
  const display = isOffline ? 'flex' : 'none'
  if (authBanner) authBanner.style.display = display
  if (mainBanner) mainBanner.style.display = display
  const btn = document.getElementById('btn-open-browser')
  if (btn && document.getElementById('auth-screen').classList.contains('active')) {
    btn.disabled = isOffline
    btn.textContent = isOffline ? 'NO INTERNET' : 'SIGN IN WITH BROWSER'
  }
}

window.addEventListener('online', () => setOffline(false))
window.addEventListener('offline', () => setOffline(true))

function showMainError(message) {
  const el = document.getElementById('main-error')
  const text = document.getElementById('main-error-text')
  if (!el || !text) return
  text.textContent = message
  el.style.display = 'block'
}

function clearMainError() {
  const el = document.getElementById('main-error')
  if (el) el.style.display = 'none'
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function formatDailyLimit(limitMb) {
  if (limitMb == null) return 'No limit set.'
  if (limitMb >= 1024) return `${(limitMb / 1024).toFixed(limitMb % 1024 === 0 ? 0 : 1)} GB/day cap`
  return `${limitMb} MB/day cap`
}

function getFlagForCountry(code) {
  if (!code || typeof code !== 'string' || code.length !== 2) return '🌍'
  const upper = code.toUpperCase()
  const codePointA = 127462 - 65
  const flag = String.fromCodePoint(
    codePointA + upper.charCodeAt(0),
    codePointA + upper.charCodeAt(1)
  )
  return flag
}

function showScreen(id) {
  const loading = document.getElementById('loading-screen')
  if (loading) loading.style.display = 'none'
  document.querySelectorAll('.screen').forEach((screen) => screen.classList.remove('active'))
  const active = document.getElementById(id)
  if (active) active.classList.add('active')
  setOffline(!navigator.onLine)
}

function getPrivateShareExpiryPreset(expiresAt) {
  if (!expiresAt) return 'none'
  const hours = Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 3600000))
  if (hours <= 2) return '1'
  if (hours <= 30) return '24'
  if (hours <= 24 * 8) return '168'
  return 'none'
}

function getPrivateShareRows(state = window.__lastPeerMeshState || null) {
  const merged = mergePrivateShareRows(
    Array.isArray(privateShares) ? privateShares : [],
    Array.isArray(state?.privateShares) ? state.privateShares : [],
    privateShare ? [privateShare] : [],
    state?.privateShare ? [state.privateShare] : [],
  )
  const baseDeviceId = state?.baseDeviceId ?? state?.config?.baseDeviceId ?? null
  const configuredSlots = Math.max(1, state?.slots?.configured ?? state?.connectionSlots ?? 1)
  if (!baseDeviceId) return merged

  const next = new Map()
  // Only include rows that belong to a valid slot index for this base device
  for (const row of merged) {
    const match = row.device_id?.match(/^(.+)_slot_(\d+)$/)
    if (match && match[1] === baseDeviceId) {
      if (parseInt(match[2], 10) >= configuredSlots) continue // drop stale slots
    }
    next.set(row.device_id, row)
  }

  for (let index = 0; index < configuredSlots; index++) {
    const slotDeviceId = `${baseDeviceId}_slot_${index}`
    if (next.has(slotDeviceId)) continue
    next.set(slotDeviceId, {
      device_id: slotDeviceId,
      base_device_id: baseDeviceId,
      slot_index: index,
      code: '',
      enabled: false,
      expires_at: null,
      active: false,
      state_actor: null,
      state_changed_at: null,
    })
  }

  return sortPrivateShares([...next.values()])
}

function getPrivateShareLabel(row, fallbackIndex = 0) {
  if (!row) return `Slot ${fallbackIndex + 1}`
  if (Number.isInteger(row.slot_index) && row.slot_index >= 0) return `Slot ${row.slot_index + 1}`
  if (row.device_id) return row.device_id.slice(0, 8)
  return `Slot ${fallbackIndex + 1}`
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
  if (!sync?.state_changed_at) return null
  const actor = sync.state_actor ? String(sync.state_actor).toUpperCase() : 'SYSTEM'
  return `Synced from ${actor} at ${new Date(sync.state_changed_at).toLocaleTimeString()}`
}

function sortPrivateShares(rows = []) {
  return [...rows].sort((a, b) => {
    if ((a.base_device_id || '') !== (b.base_device_id || '')) return (a.base_device_id || '').localeCompare(b.base_device_id || '')
    const aSlot = Number.isInteger(a.slot_index) ? a.slot_index : -1
    const bSlot = Number.isInteger(b.slot_index) ? b.slot_index : -1
    if (aSlot !== bSlot) return aSlot - bSlot
    return (a.device_id || '').localeCompare(b.device_id || '')
  })
}

function mergePrivateShareRows(...sources) {
  const merged = new Map()
  for (const source of sources) {
    for (const row of source || []) {
      if (!row?.device_id) continue
      merged.set(row.device_id, preferLatestSync(merged.get(row.device_id), row) ?? row)
    }
  }
  return sortPrivateShares([...merged.values()])
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
  const selected = privateShareDeviceId ? slotLimits[privateShareDeviceId] : null
  slotDailyLimitInput = selected?.daily_limit_mb != null ? String(selected.daily_limit_mb) : ''
}

function renderPrivateShare() {
  const codeEl = document.getElementById('private-share-code')
  const copyBtn = document.getElementById('copy-private-share')
  const copyLinkBtn = document.getElementById('copy-private-link')
  const refreshBtn = document.getElementById('refresh-private-share')
  const toggleBtn = document.getElementById('toggle-private-share')
  const expiryEl = document.getElementById('private-share-expiry')
  const deviceSelect = document.getElementById('private-share-device')
  const statusEl = document.getElementById('private-share-status')
  const slotLimitInput = document.getElementById('slot-daily-limit-input')
  const slotLimitSaveBtn = document.getElementById('slot-daily-limit-save')
  const slotLimitStatusEl = document.getElementById('slot-daily-limit-status')
  const state = window.__lastPeerMeshState || null
  const signedIn = !!state?.config?.userId
  const rows = getPrivateShareRows(state)
  const slotLimitPresets = [
    { id: 'slot-daily-limit-1gb', value: 1024 },
    { id: 'slot-daily-limit-2gb', value: 2048 },
    { id: 'slot-daily-limit-5gb', value: 5120 },
  ]
  const slotLimitNoneBtn = document.getElementById('slot-daily-limit-none')

  // Only reset selection when there is genuinely no selection yet — not on every render
  if (!privateShareDeviceId) {
    privateShareDeviceId = rows[0]?.device_id ?? privateShare?.device_id ?? null
  } else if (rows.length > 0 && !rows.some(row => row.device_id === privateShareDeviceId)) {
    // Selected slot no longer exists (e.g. slot count reduced) — fall back gracefully
    privateShareDeviceId = rows[0]?.device_id ?? null
    privateShareSelectionLocked = false
  }
  privateShare = rows.find(row => row.device_id === privateShareDeviceId) ?? rows[0] ?? privateShare
  syncSlotDailyLimitInput()

  if (codeEl) codeEl.textContent = privateShare?.code ?? '---------'
  // Expiry is per-slot: use the selected slot's actual expires_at unless user has a pending edit
  const slotExpiry = getPendingEdit('expiryHours')
    ? privateShareExpiry
    : getPrivateShareExpiryPreset(privateShare?.expires_at ?? null)
  if (expiryEl) expiryEl.value = slotExpiry
  if (deviceSelect) {
    deviceSelect.innerHTML = rows.length > 0
      ? rows.map((row, index) => {
          const label = getPrivateShareLabel(row, index)
          const selected = row.device_id === privateShareDeviceId ? 'selected' : ''
          const status = row.enabled ? (row.active ? 'ACTIVE' : 'ENABLED') : 'DISABLED'
          return `<option value="${row.device_id}" ${selected}>${label} - ${status}</option>`
        }).join('')
      : '<option value="">No slots available</option>'
    deviceSelect.disabled = !signedIn || privateShareSaving || slotDailyLimitSaving || rows.length === 0
    deviceSelect.value = privateShareDeviceId ?? ''
  }

  if (copyBtn) copyBtn.disabled = !signedIn || !privateShare?.code || privateShareSaving
  if (copyLinkBtn) copyLinkBtn.disabled = !signedIn || !privateShare?.code || privateShareSaving
  if (refreshBtn) {
    refreshBtn.disabled = !signedIn || privateShareSaving
    refreshBtn.textContent = privateShareSaving && privateShareAction === 'refresh' ? 'REFRESHING...' : 'REFRESH CODE'
  }
  if (toggleBtn) {
    toggleBtn.disabled = !signedIn || privateShareSaving
    toggleBtn.textContent = privateShareSaving && privateShareAction !== 'refresh'
      ? 'SAVING...'
      : ((privateShare?.enabled ?? false) ? 'DISABLE PRIVATE' : 'ENABLE PRIVATE')
  }
  const currentSlotLimit = privateShareDeviceId ? slotLimits[privateShareDeviceId]?.daily_limit_mb ?? null : null
  if (slotLimitInput) {
    if (document.activeElement !== slotLimitInput) {
      slotLimitInput.value = slotDailyLimitInput
    }
    slotLimitInput.disabled = !signedIn || slotDailyLimitSaving || !privateShareDeviceId
  }
  if (slotLimitSaveBtn) {
    slotLimitSaveBtn.disabled = !signedIn || slotDailyLimitSaving || !privateShareDeviceId
    slotLimitSaveBtn.textContent = slotDailyLimitSaving ? 'APPLYING...' : 'APPLY'
  }
  if (slotLimitNoneBtn) {
    slotLimitNoneBtn.disabled = !signedIn || slotDailyLimitSaving || !privateShareDeviceId
    slotLimitNoneBtn.style.borderColor = currentSlotLimit == null ? 'rgba(0,255,136,0.45)' : 'var(--border)'
    slotLimitNoneBtn.style.color = currentSlotLimit == null ? 'var(--accent)' : 'var(--text)'
    slotLimitNoneBtn.style.background = currentSlotLimit == null ? 'var(--accent-dim)' : 'transparent'
  }
  slotLimitPresets.forEach(({ id, value }) => {
    const button = document.getElementById(id)
    if (!button) return
    button.disabled = !signedIn || slotDailyLimitSaving || !privateShareDeviceId
    button.style.borderColor = currentSlotLimit === value ? 'rgba(0,255,136,0.45)' : 'var(--border)'
    button.style.color = currentSlotLimit === value ? 'var(--accent)' : 'var(--text)'
    button.style.background = currentSlotLimit === value ? 'var(--accent-dim)' : 'transparent'
  })

  if (slotLimitStatusEl) {
    const slotLimitSyncLabel = formatSyncLabel(privateShareDeviceId ? slotLimits[privateShareDeviceId] : null)
    if (!signedIn) {
      slotLimitStatusEl.textContent = 'Sign in to manage per-slot limits.'
    } else if (!privateShareDeviceId) {
      slotLimitStatusEl.textContent = 'Select a slot to configure a per-slot limit.'
    } else if (slotDailyLimitSaving) {
      slotLimitStatusEl.textContent = 'Updating slot limit...'
    } else {
      const baseStatus = currentSlotLimit != null
        ? `${getPrivateShareLabel(privateShare)} capped at ${currentSlotLimit} MB/day.`
        : `No per-slot cap on ${getPrivateShareLabel(privateShare)}.`
      slotLimitStatusEl.textContent = slotLimitSyncLabel ? `${baseStatus} ${slotLimitSyncLabel}` : baseStatus
    }
  }

  if (!statusEl) return
  if (!signedIn) {
    statusEl.textContent = 'Sign in to manage private sharing.'
    return
  }
  if (privateShareSaving) {
    statusEl.textContent = privateShareAction === 'refresh' ? 'Refreshing private code...' : 'Updating private sharing...'
    return
  }

  const mode = (privateShare?.enabled ?? false)
    ? (privateShare?.active ? 'ACTIVE' : 'ENABLED - waiting for expiry refresh')
    : 'DISABLED'
  const expires = privateShare?.expires_at
    ? ` Expires ${new Date(privateShare.expires_at).toLocaleString()}.`
    : ' No expiry.'
  const syncLabel = formatSyncLabel(privateShare)
  statusEl.textContent = `${getPrivateShareLabel(privateShare)} is ${mode}.${expires}${syncLabel ? ` ${syncLabel}` : ''}`
}

async function loadPrivateShare(force = false) {
  const now = Date.now()
  if (!force && now - lastPrivateShareLoadAt < PRIVATE_SHARE_REFRESH_TTL) return
  lastPrivateShareLoadAt = now
  const result = await invoke('getPrivateShare')
  if (!result?.success) return
  const nextShares = mergePrivateShareRows(privateShares, Array.isArray(result.privateShares) ? result.privateShares : [])
  privateShares = nextShares
  slotLimits = mapSlotLimits([...(result.slotLimits ?? []), ...Object.values(slotLimits)])
  const pendingSlot = getPendingEdit('selectedSlotDeviceId')
  const preferredDeviceId = (pendingSlot || privateShareSelectionLocked)
    ? (pendingSlot || privateShareDeviceId)
    : (result.privateShareDeviceId ?? privateShareDeviceId)
  if (preferredDeviceId && nextShares.some(row => row.device_id === preferredDeviceId)) {
    privateShareDeviceId = preferredDeviceId
  } else {
    privateShareDeviceId = result.privateShare?.device_id ?? nextShares[0]?.device_id ?? null
    privateShareSelectionLocked = false
    clearPendingEdit('selectedSlotDeviceId')
  }
  privateShare = preferLatestSync(
    nextShares.find(row => row.device_id === privateShareDeviceId) ?? nextShares[0] ?? null,
    result.privateShare ?? null,
  )
  if (!getPendingEdit('expiryHours')) {
    privateShareExpiry = result.expiryPreset ?? getPrivateShareExpiryPreset(privateShare?.expires_at ?? null)
  }
  syncSlotDailyLimitInput()
  renderPrivateShare()
}

async function savePrivateShare(payload) {
  if (privateShareSaving) return
  privateShareAction = payload?.refresh ? 'refresh' : 'toggle'
  privateShareSaving = true
  clearMainError()
  renderPrivateShare()
  try {
    const result = await invoke('updatePrivateShare', {
      ...payload,
      deviceId: payload?.deviceId ?? privateShareDeviceId ?? privateShare?.device_id ?? privateShares[0]?.device_id ?? null,
    })
    if (!result?.success) throw new Error(result?.error || 'Could not update private sharing')
    privateShares = mergePrivateShareRows(privateShares, Array.isArray(result.privateShares) ? result.privateShares : [])
    slotLimits = mapSlotLimits([...(result.slotLimits ?? []), ...Object.values(slotLimits)])
    // Keep selection on the slot that was just saved
    const savedDeviceId = payload?.deviceId ?? privateShareDeviceId ?? result.privateShareDeviceId ?? result.privateShare?.device_id ?? null
    if (savedDeviceId) {
      privateShareDeviceId = savedDeviceId
      privateShareSelectionLocked = true
    }
    privateShare = preferLatestSync(
      privateShares.find(row => row.device_id === privateShareDeviceId) ?? privateShare,
      result.privateShare ?? null,
    )
    privateShareExpiry = result.expiryPreset ?? getPrivateShareExpiryPreset(privateShare?.expires_at ?? null)
    clearPendingEdit('expiryHours')
    clearPendingEdit('selectedSlotDeviceId')
    syncSlotDailyLimitInput()
    await pollState()
  } catch (error) {
    showMainError(error?.message || 'Could not update private sharing')
  } finally {
    privateShareSaving = false
    privateShareAction = null
    renderPrivateShare()
  }
}

function getSlotWarning(slots) {
  if (slots > 16) return 'Very high resource usage - recommended for servers or dedicated machines only.'
  if (slots > 8) return 'High resource usage - ensure a stable connection.'
  return null
}

function renderSlots(configured, slots) {
  const dots = document.getElementById('slots-dots')
  const summary = document.getElementById('slots-summary')
  const warning = document.getElementById('slots-warning')
  const slotValue = document.getElementById('slots-value')
  const decrementBtn = document.getElementById('slots-decrement')
  const incrementBtn = document.getElementById('slots-increment')
  if (!dots || !summary || !warning || !slotValue || !decrementBtn || !incrementBtn) return

  slotValue.textContent = slotUpdating ? '...' : String(configured)
  decrementBtn.disabled = slotUpdating || configured <= 1
  incrementBtn.disabled = slotUpdating || configured >= 32
  dots.innerHTML = ''

  const statuses = slots?.statuses ?? []
  const active = slots?.active ?? statuses.filter((slot) => slot.running).length
  for (let i = 0; i < configured; i += 1) {
    const dot = document.createElement('span')
    const s = statuses[i]
    dot.className = `slot-dot${s?.running ? ' on' : ''}${s?.privateEnabled ? ' private' : ''}`
    dot.title = s?.running ? `Slot ${i + 1} active (${s.privateEnabled ? 'private' : 'public'})` : `Slot ${i + 1} idle`
    dots.appendChild(dot)
  }

  const slotSyncLabel = formatSyncLabel(window.__lastPeerMeshState?.connectionSlotsSync ?? null)
  summary.textContent = slotUpdating
    ? 'Applying slot change...'
    : `${active} / ${configured} slots active${slotSyncLabel ? ` - ${slotSyncLabel}` : ''}`
  const warningText = getSlotWarning(configured)
  warning.textContent = warningText ?? ''
  warning.style.display = warningText ? 'block' : 'none'
}

function renderDailyLimit(state) {
  const config = state?.config ?? {}
  const input = document.getElementById('daily-limit-input')
  const saveBtn = document.getElementById('daily-limit-save')
  const status = document.getElementById('daily-limit-status')
  const presetButtons = [
    { id: 'daily-limit-1gb', value: 1024 },
    { id: 'daily-limit-2gb', value: 2048 },
    { id: 'daily-limit-5gb', value: 5120 },
  ]
  const noneBtn = document.getElementById('daily-limit-none')
  const signedIn = !!config.userId
  const currentLimit = config.dailyShareLimitMb ?? null

  if (input) {
    if (document.activeElement !== input) {
      input.value = currentLimit != null ? String(currentLimit) : ''
    }
    input.disabled = !signedIn || dailyLimitSaving
  }
  if (saveBtn) {
    saveBtn.disabled = !signedIn || dailyLimitSaving
    saveBtn.textContent = dailyLimitSaving ? 'SAVING...' : 'APPLY'
  }
  if (noneBtn) noneBtn.disabled = !signedIn || dailyLimitSaving

  presetButtons.forEach(({ id, value }) => {
    const button = document.getElementById(id)
    if (!button) return
    button.disabled = !signedIn || dailyLimitSaving
    button.style.borderColor = currentLimit === value ? 'rgba(0,255,136,0.45)' : 'var(--border)'
    button.style.color = currentLimit === value ? 'var(--accent)' : 'var(--text)'
    button.style.background = currentLimit === value ? 'var(--accent-dim)' : 'transparent'
  })

  if (noneBtn) {
    noneBtn.style.borderColor = currentLimit == null ? 'rgba(0,255,136,0.45)' : 'var(--border)'
    noneBtn.style.color = currentLimit == null ? 'var(--accent)' : 'var(--text)'
    noneBtn.style.background = currentLimit == null ? 'var(--accent-dim)' : 'transparent'
  }

  if (!status) return
  if (!signedIn) {
    status.textContent = 'Sign in to manage your daily share limit.'
    return
  }
  if (dailyLimitSaving) {
    status.textContent = 'Updating daily limit...'
    return
  }
  const syncLabel = formatSyncLabel(state?.profileSync ?? null)
  status.textContent = `${formatDailyLimit(currentLimit)} Minimum custom limit: 1024 MB.${syncLabel ? ` ${syncLabel}` : ''}`
}

function renderDesktopUpdate(state) {
  const update = state?.desktopUpdate ?? null
  const desc = document.getElementById('desktop-update-desc')
  const status = document.getElementById('desktop-update-status')
  const checkBtn = document.getElementById('desktop-update-check')
  const downloadBtn = document.getElementById('desktop-update-download')
  const currentVersion = state?.version ?? api.version ?? ''
  const latestVersion = update?.latestVersion ?? null
  const updateAvailable = update?.updateAvailable === true

  if (desc) {
    desc.textContent = updateAvailable
      ? `Latest installer is v${latestVersion}. Current desktop is v${currentVersion}.`
      : 'Check for the latest PeerMesh desktop installer.'
  }
  if (status) {
    if (desktopUpdateBusy) status.textContent = 'Checking for update...'
    else if (update?.error) status.textContent = `Update check failed: ${update.error}`
    else if (updateAvailable) status.textContent = `Update available: v${latestVersion}. Download it, then run the installer.`
    else if (latestVersion) status.textContent = `You are on the latest desktop version (${currentVersion}).`
    else status.textContent = 'Not checked yet.'
  }
  if (checkBtn) {
    checkBtn.disabled = desktopUpdateBusy
    checkBtn.textContent = desktopUpdateBusy ? 'CHECKING...' : 'CHECK'
  }
  if (downloadBtn) {
    downloadBtn.disabled = desktopUpdateBusy
    downloadBtn.textContent = updateAvailable ? 'DOWNLOAD UPDATE' : 'DOWNLOAD LATEST'
  }
}

function renderStartupPreferences(state) {
  const config = state?.config ?? {}
  const launchToggle = document.getElementById('launch-startup-toggle')
  const autoShareToggle = document.getElementById('auto-share-toggle')
  const preventSleepToggle = document.getElementById('prevent-sleep-toggle')
  const scheduleToggle = document.getElementById('sharing-schedule-toggle')
  const scheduleWakeToggle = document.getElementById('schedule-wake-toggle')
  const onDemandWakeToggle = document.getElementById('on-demand-wake-toggle')
  const privateOnDemandStartToggle = document.getElementById('private-on-demand-start-toggle')
  const launchDesc = document.getElementById('launch-startup-desc')
  const autoShareDesc = document.getElementById('auto-share-desc')
  const preventSleepDesc = document.getElementById('prevent-sleep-desc')
  const scheduleDesc = document.getElementById('sharing-schedule-desc')
  const scheduleWakeDesc = document.getElementById('schedule-wake-desc')
  const onDemandWakeDesc = document.getElementById('on-demand-wake-desc')
  const privateOnDemandStartDesc = document.getElementById('private-on-demand-start-desc')
  const scheduleControls = document.getElementById('sharing-schedule-controls')
  const scheduleStart = document.getElementById('sharing-schedule-start')
  const scheduleEnd = document.getElementById('sharing-schedule-end')
  const scheduleTimezone = document.getElementById('sharing-schedule-timezone')
  const scheduleSave = document.getElementById('sharing-schedule-save')
  const note = document.getElementById('startup-note')
  const signedIn = !!config.userId
  const accepted = !!config.hasAcceptedProviderTerms
  const isCurrentlySharing = !!state?.running || !!state?.shareEnabled
  const schedule = normalizeSharingSchedule(state?.sharingSchedule ?? config.sharingSchedule)
  const osWake = state?.osWake ?? { enabled: !!config.scheduleWakeEnabled, supported: false, platform: 'unknown', status: null }
  const launchEnabled = !!config.launchOnStartup
  const autoShareReady = signedIn && accepted && launchEnabled
  const scheduleWakeReady = signedIn && schedule.enabled && autoShareReady && osWake.supported
  const onDemandWakeReady = signedIn && !!config.allowPrivateOnDemandStart

  setToggleVisual(launchToggle, {
    on: launchEnabled,
    loading: startupBusy.launchOnStartup,
    disabled: startupBusy.launchOnStartup,
  })
  setToggleVisual(autoShareToggle, {
    on: !!config.autoShareOnLaunch,
    loading: startupBusy.autoShareOnLaunch,
    disabled: !autoShareReady || startupBusy.autoShareOnLaunch,
  })
  setToggleVisual(preventSleepToggle, {
    on: !!config.preventSleepWhileSharing,
    loading: startupBusy.preventSleepWhileSharing,
    disabled: !signedIn || startupBusy.preventSleepWhileSharing,
  })
  setToggleVisual(scheduleToggle, {
    on: !!schedule.enabled,
    loading: startupBusy.sharingSchedule || sharingScheduleSaving,
    disabled: !signedIn || startupBusy.sharingSchedule || sharingScheduleSaving,
  })
  setToggleVisual(scheduleWakeToggle, {
    on: startupBusy.scheduleWakeEnabled && startupPending.scheduleWakeEnabled !== null
      ? startupPending.scheduleWakeEnabled
      : !!osWake.enabled,
    loading: startupBusy.scheduleWakeEnabled,
    disabled: !scheduleWakeReady || startupBusy.scheduleWakeEnabled,
  })
  setToggleVisual(onDemandWakeToggle, {
    on: !!config.allowOnDemandWake,
    loading: startupBusy.onDemandWake,
    disabled: !onDemandWakeReady || startupBusy.onDemandWake,
  })
  setToggleVisual(privateOnDemandStartToggle, {
    on: !!config.allowPrivateOnDemandStart,
    loading: startupBusy.privateOnDemandStart,
    disabled: !signedIn || startupBusy.privateOnDemandStart,
  })

  if (scheduleControls) scheduleControls.style.display = schedule.enabled ? 'block' : 'none'
  if (scheduleStart && document.activeElement !== scheduleStart) scheduleStart.value = schedule.startTime
  if (scheduleEnd && document.activeElement !== scheduleEnd) scheduleEnd.value = schedule.endTime
  if (scheduleTimezone && document.activeElement !== scheduleTimezone) scheduleTimezone.value = schedule.timezone
  if (scheduleSave) {
    scheduleSave.disabled = !signedIn || sharingScheduleSaving
    scheduleSave.textContent = sharingScheduleSaving ? 'Saving...' : 'Save schedule'
  }

  if (launchDesc) {
    launchDesc.textContent = config.launchOnStartup
      ? 'PeerMesh will launch quietly in the tray when your PC starts.'
      : 'Keep launch disabled if you only want to open PeerMesh manually.'
  }

  if (autoShareDesc) {
    if (!signedIn) {
      autoShareDesc.textContent = 'Sign in before enabling automatic sharing.'
    } else if (!config.launchOnStartup) {
      autoShareDesc.textContent = 'Enable launch on startup first so PeerMesh can start automatically.'
    } else if (!accepted) {
      autoShareDesc.textContent = 'Turn sharing on once and accept the disclosure before enabling this.'
    } else if (config.autoShareOnLaunch) {
      autoShareDesc.textContent = 'When PeerMesh launches, sharing will start automatically for this signed-in account.'
    } else {
      autoShareDesc.textContent = 'Requires prior disclosure acceptance. Sharing stays manual until you enable this.'
    }
  }

  if (preventSleepDesc) {
    if (!signedIn) {
      preventSleepDesc.textContent = 'Sign in before enabling provider uptime protection.'
    } else if (config.preventSleepWhileSharing && state?.preventSleepWhileSharingActive) {
      preventSleepDesc.textContent = 'PeerMesh is keeping the provider runtime awake while sharing is enabled.'
    } else if (config.preventSleepWhileSharing) {
      preventSleepDesc.textContent = 'The runtime will stay awake when sharing starts.'
    } else {
      preventSleepDesc.textContent = 'Allow the laptop to sleep normally when the OS decides.'
    }
  }

  if (scheduleDesc) {
    if (!signedIn) {
      scheduleDesc.textContent = 'Sign in before enabling scheduled sharing.'
    } else if (!schedule.enabled) {
      scheduleDesc.textContent = schedule.alwaysOn
        ? 'Disabled. Enable this to use the default always-on 00:00-00:00 window.'
        : 'Disabled. Manual sharing and auto-start settings still work.'
    } else if (schedule.alwaysOn) {
      scheduleDesc.textContent = 'Always-on mode: PeerMesh shares whenever this device is on and signed in.'
    } else if (schedule.active) {
      scheduleDesc.textContent = `Active now. Sharing window ${schedule.startTime}-${schedule.endTime} (${schedule.timezone}).`
    } else {
      scheduleDesc.textContent = `Waiting for ${schedule.startTime}-${schedule.endTime} (${schedule.timezone}).`
    }
  }

  if (scheduleWakeDesc) {
    if (!signedIn) {
      scheduleWakeDesc.textContent = 'Sign in before enabling OS wake.'
    } else if (!schedule.enabled) {
      scheduleWakeDesc.textContent = 'Enable scheduled sharing first.'
    } else if (!config.launchOnStartup) {
      scheduleWakeDesc.textContent = 'Enable launch on startup first so wake has an app to start.'
    } else if (!config.autoShareOnLaunch) {
      scheduleWakeDesc.textContent = 'Enable start sharing on launch first so wake resumes provider sharing.'
    } else if (!osWake.supported) {
      scheduleWakeDesc.textContent = 'Automatic wake setup is not supported on this OS.'
    } else if (osWake.enabled && osWake.status?.error) {
      scheduleWakeDesc.textContent = osWake.status.error
    } else if (osWake.enabled) {
      const nextWake = osWake.status?.nextWakeAt ? ` Next wake: ${new Date(osWake.status.nextWakeAt).toLocaleString()}.` : ''
      scheduleWakeDesc.textContent = `PeerMesh registered an OS wake event for this schedule.${nextWake}`
    } else {
      scheduleWakeDesc.textContent = 'Optional: create an OS wake event for the schedule start time.'
    }
  }

  if (onDemandWakeDesc) {
    if (!signedIn) {
      onDemandWakeDesc.textContent = 'Sign in before allowing requester wake calls.'
    } else if (!config.allowPrivateOnDemandStart) {
      onDemandWakeDesc.textContent = 'Enable private on-demand start first. Wake is only useful when a requester may also start sharing.'
    } else if (config.allowOnDemandWake) {
      onDemandWakeDesc.textContent = 'Known private-code requesters can queue wake/start requests for this provider.'
    } else {
      onDemandWakeDesc.textContent = 'Off by default. Private requesters can only start this provider while PeerMesh is already reachable.'
    }
  }

  if (privateOnDemandStartDesc) {
    if (!signedIn) {
      privateOnDemandStartDesc.textContent = 'Sign in before allowing private on-demand start.'
    } else if (config.allowPrivateOnDemandStart) {
      privateOnDemandStartDesc.textContent = 'Known private-code requesters can start sharing when PeerMesh is running but idle.'
    } else {
      privateOnDemandStartDesc.textContent = 'Off by default. Private-code requesters cannot start sharing on this provider.'
    }
  }

  if (note) {
    note.textContent = config.launchOnStartup
      ? 'Launch on startup hides the window and starts PeerMesh in the tray.'
      : 'These settings apply to this desktop only.'
  }
}

function resetAuthUI() {
  const codeEl = document.getElementById('device-code-display')
  const codeHint = document.getElementById('code-hint')
  const codeWaiting = document.getElementById('code-waiting')
  const codePlaceholder = document.getElementById('code-placeholder')
  const errEl = document.getElementById('auth-error')
  const btn = document.getElementById('btn-open-browser')
  const copyBtn = document.getElementById('btn-copy-code')
  const statusEl = document.getElementById('auth-status')

  if (codeEl) {
    codeEl.style.display = 'none'
    codeEl.textContent = ''
  }
  if (codeHint) codeHint.style.display = 'none'
  if (codeWaiting) codeWaiting.style.display = 'none'
  if (codePlaceholder) codePlaceholder.style.display = 'block'
  if (copyBtn) {
    copyBtn.style.display = 'none'
    copyBtn.onclick = null
  }
  if (errEl) errEl.style.display = 'none'
  if (statusEl) statusEl.textContent = 'Click the button above to sign in'
  if (btn) {
    btn.disabled = false
    btn.textContent = 'SIGN IN WITH BROWSER'
  }
}

function stopDevicePoll() {
  if (devicePollInterval) {
    clearInterval(devicePollInterval)
    devicePollInterval = null
  }
  deviceFlowActive = false
}

let _deviceFlowStartedAt = 0

async function startDeviceFlow() {
  if (typeof api.requestDeviceCode !== 'function') return
  if (signingIn) return
  // If a flow is active but the code was never shown and it's been >15s, restart it
  const codeEl = document.getElementById('device-code-display')
  const codeVisible = codeEl && codeEl.style.display !== 'none' && codeEl.textContent
  if (deviceFlowActive && (codeVisible || Date.now() - _deviceFlowStartedAt < 15000)) return
  if (deviceFlowActive) stopDevicePoll()
  deviceFlowActive = true
  _deviceFlowStartedAt = Date.now()
  const codeHint = document.getElementById('code-hint')
  const codeWaiting = document.getElementById('code-waiting')
  const codePlaceholder = document.getElementById('code-placeholder')
  const errEl = document.getElementById('auth-error')
  const btn = document.getElementById('btn-open-browser')
  const copyBtn = document.getElementById('btn-copy-code')
  const errorText = document.getElementById('auth-error-text')

  if (errEl) errEl.style.display = 'none'
  if (codeEl) {
    codeEl.style.display = 'none'
    codeEl.textContent = ''
  }
  if (codeHint) codeHint.style.display = 'none'
  if (codePlaceholder) codePlaceholder.style.display = 'none'
  if (codeWaiting) codeWaiting.style.display = 'flex'
  if (btn) {
    btn.disabled = true
    btn.textContent = 'OPENING BROWSER...'
  }

  if (!navigator.onLine) {
    if (errorText) errorText.textContent = 'No internet connection - check your network and try again'
    if (errEl) errEl.style.display = 'block'
    if (codeWaiting) codeWaiting.style.display = 'none'
    if (btn) {
      btn.disabled = true
      btn.textContent = 'NO INTERNET'
    }
    deviceFlowActive = false
    return
  }

  const result = await Promise.race([
    invoke('requestDeviceCode'),
    new Promise(resolve => setTimeout(() => resolve({ error: 'Request timed out - check your connection' }), 12000)),
  ])
  if (!result || result.error) {
    if (errorText) errorText.textContent = result?.error || 'Could not reach server'
    if (errEl) errEl.style.display = 'block'
    if (codeWaiting) codeWaiting.style.display = 'none'
    if (btn) {
      btn.disabled = false
      btn.textContent = 'TRY AGAIN'
    }
    deviceFlowActive = false
    return
  }

  const { device_code: deviceCode, user_code: userCode, verification_uri: verificationUri, interval = 3 } = result

  if (codeWaiting) codeWaiting.style.display = 'none'
  if (codeEl) {
    codeEl.textContent = userCode
    codeEl.style.display = 'block'
  }
  if (codeHint) codeHint.style.display = 'block'
  if (copyBtn) {
    copyBtn.style.display = 'inline-block'
    copyBtn.onclick = async () => {
      const authUrl = `${verificationUri}?activate=1&code=${encodeURIComponent(userCode)}`
      try { await navigator.clipboard.writeText(userCode) } catch {}
      copyBtn.textContent = 'COPIED!'
      copyBtn.style.color = 'var(--accent)'
      copyBtn.style.borderColor = 'var(--accent)'
      await invoke('openAuth', authUrl)
      setTimeout(() => {
        copyBtn.textContent = 'COPY CODE'
        copyBtn.style.color = 'var(--text)'
        copyBtn.style.borderColor = ''
      }, 2000)
    }
  }
  if (btn) {
    btn.disabled = false
    btn.textContent = 'OPEN BROWSER AGAIN'
  }



  stopDevicePoll()
  deviceFlowActive = true
  devicePollInterval = setInterval(async () => {
    const poll = await invoke('pollDeviceCode', deviceCode)
    if (!poll) return

    if (poll.status === 'approved' && poll.user) {
      stopDevicePoll()
      resetAuthUI()
      const waiting = document.getElementById('code-waiting')
      if (waiting) {
        waiting.style.display = 'flex'
        waiting.innerHTML = '<span style="display:inline-block;width:10px;height:10px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite"></span> SIGNING IN...'
      }
      signingIn = true
      const signInResult = await invoke('signIn', {
        token: poll.user.token,
        refreshToken: poll.user.refreshToken,
        deviceSessionId: poll.user.deviceSessionId,
        userId: poll.user.id,
        country: poll.user.country || 'RW',
        trust: poll.user.trustScore || 50,
      })
      if (signInResult?.success === false) {
        signingIn = false
        if (errorText) errorText.textContent = signInResult.error || 'Sign-in failed - please try again'
        if (errEl) errEl.style.display = 'block'
        if (btn) {
          btn.disabled = false
          btn.textContent = 'SIGN IN WITH BROWSER'
        }
        if (waiting) waiting.style.display = 'none'
        return
      }
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 600))
        const state = await pollState()
        if (state?.running) break
      }
      await pollState()
      signingIn = false
    } else if (poll.status === 'denied') {
      stopDevicePoll()
      if (codeEl) codeEl.style.display = 'none'
      if (codeHint) codeHint.style.display = 'none'
      if (errorText) errorText.textContent = 'Sign-in was denied. Click below to try again.'
      if (errEl) errEl.style.display = 'block'
      if (btn) {
        btn.disabled = false
        btn.textContent = 'SIGN IN WITH BROWSER'
      }
    } else if (poll.status === 'expired') {
      stopDevicePoll()
      if (codeEl) codeEl.style.display = 'none'
      if (codeHint) codeHint.style.display = 'none'
      if (copyBtn) copyBtn.style.display = 'none'
      if (errorText) errorText.textContent = 'Code expired - click below to get a new one.'
      if (errEl) errEl.style.display = 'block'
      const statusEl = document.getElementById('auth-status')
      if (statusEl) statusEl.textContent = ''
      if (btn) {
        btn.disabled = false
        btn.textContent = 'GET NEW CODE'
      }
    }
  }, interval * 1000)
}

function showDisclosureModal() {
  if (document.getElementById('pm-disclosure')) return
  const overlay = document.createElement('div')
  overlay.id = 'pm-disclosure'
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.82);display:flex;align-items:center;justify-content:center;z-index:999;padding:16px'
  overlay.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;max-width:320px;width:100%">
      <div style="font-family:'Courier New',monospace;font-size:10px;color:var(--accent);letter-spacing:1px;margin-bottom:10px">BEFORE YOU SHARE</div>
      <div style="font-size:14px;font-weight:600;margin-bottom:14px;line-height:1.3">What sharing your connection means</div>
      <div style="display:flex;gap:10px;margin-bottom:10px;font-size:12px;color:var(--muted);line-height:1.5"><span>1.</span><span>Your IP address will be used by other PeerMesh users to browse the web.</span></div>
      <div style="display:flex;gap:10px;margin-bottom:10px;font-size:12px;color:var(--muted);line-height:1.5"><span>2.</span><span>All sessions are logged with signed receipts.</span></div>
      <div style="display:flex;gap:10px;margin-bottom:10px;font-size:12px;color:var(--muted);line-height:1.5"><span>3.</span><span>Blocked: .onion sites, SMTP/mail, torrents, private IPs.</span></div>
      <div style="display:flex;gap:10px;margin-bottom:10px;font-size:12px;color:var(--muted);line-height:1.5"><span>4.</span><span>You can stop sharing at any time.</span></div>
      <div style="display:flex;gap:10px;margin-bottom:10px;font-size:12px;color:var(--muted);line-height:1.5"><span>5.</span><span>Sharing earns you free browsing credits.</span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:16px">
        <button id="pm-disclose-cancel" style="padding:10px;background:none;border:1px solid var(--border);border-radius:8px;color:var(--muted);cursor:pointer;font-family:'Courier New',monospace;font-size:10px">CANCEL</button>
        <button id="pm-disclose-accept" style="padding:10px;background:var(--accent);border:none;border-radius:8px;color:#000;cursor:pointer;font-family:'Courier New',monospace;font-size:10px;font-weight:700">I UNDERSTAND - SHARE</button>
      </div>
    </div>`
  document.body.appendChild(overlay)
  document.getElementById('pm-disclose-cancel').onclick = () => overlay.remove()
  document.getElementById('pm-disclose-accept').onclick = async () => {
    overlay.remove()
    await invoke('acceptProviderTerms')
    await doToggleSharing(false)
  }
}

async function doToggleSharing(isSharing) {
  if (togglingShare) return
  setShareState(isSharing ? 'stopping' : 'starting')
  clearMainError()

  const toggle = document.getElementById('share-toggle')
  const label = document.getElementById('status-label')
  const dot = document.getElementById('status-dot')
  const card = document.getElementById('status-card')
  const desc = document.getElementById('toggle-desc')

  setToggleVisual(toggle, { loading: true })
  if (label) {
    label.textContent = isSharing ? 'STOPPING...' : 'STARTING...'
    label.style.color = 'var(--muted)'
  }
  if (dot) {
    dot.className = 'status-dot'
    dot.style.cssText = 'animation:spin 0.7s linear infinite;background:transparent;border:2px solid var(--border);border-top-color:var(--accent)'
  }
  if (card) card.className = 'status-card'
  if (desc) desc.textContent = 'Please wait...'

  try {
    try {
      if (isSharing) {
        await Promise.allSettled([
          fetch('http://127.0.0.1:7654/native/share/stop', { method: 'POST', signal: AbortSignal.timeout(2000) }),
          fetch('http://127.0.0.1:7656/native/share/stop', { method: 'POST', signal: AbortSignal.timeout(2000) }),
        ])
      } else {
        const result = await invoke('toggleSharing')
        if (result?.error) showMainError(result.error)
      }
    } catch {
      showMainError('Could not toggle sharing - please try again')
    } finally {
      if (dot) dot.style.cssText = ''
    }

    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      let state = null
      try {
        state = await pollState()
      } catch {}
      if (!state) continue
      const shouldBreak = !isSharing
        ? (state.running || state.peerRunning)
        : (!state.running && !state.peerRunning)
      if (shouldBreak) break
    }
  } finally {
    setShareState('idle')
    try {
      await pollState()
    } catch {}
  }
}

function updateUI(state) {
  window.__lastPeerMeshState = state
  privateShares = mergePrivateShareRows(privateShares, Array.isArray(state?.privateShares) ? state.privateShares : [])
  const running = !!state?.running
  const config = state?.config ?? {}
  const stats = state?.stats ?? { requestsHandled: 0, bytesServed: 0 }

  if (!config.userId) {
    privateShare = null
    privateShares = []
    privateShareDeviceId = null
    privateShareSelectionLocked = false
    slotLimits = {}
    slotDailyLimitInput = ''
    renderPrivateShare()
    renderStartupPreferences(state)
    renderDesktopUpdate(state)
    renderDailyLimit(state)
    showScreen('auth-screen')
    return
  }

  showScreen('main-screen')

  const dot = document.getElementById('status-dot')
  const label = document.getElementById('status-label')
  const country = document.getElementById('status-country')
  const statsEl = document.getElementById('status-stats')
  const card = document.getElementById('status-card')
  const peerBanner = document.getElementById('peer-active-banner')
  const peerSharing = !!state.peerRunning
  const starting = !!state?.shareEnabled && !running && !peerSharing
  const desktopSlots = state.slots
  const peerSlots = state.peerSlots
  const configuredSlots = state.connectionSlots ?? config.connectionSlots ?? 1
  const desktopPrivateShareActive = !!state.privateShareActive
  const peerPrivateShareActive = !!state.peerPrivateShareActive
  const displayStats = (peerSharing && state.peerStats) ? state.peerStats : stats
  const displaySlots = peerSharing
    ? (peerSlots ?? { configured: state.peerConnectionSlots ?? 1, active: 0, statuses: [] })
    : (desktopSlots ?? { configured: configuredSlots, active: 0, statuses: [] })

  const slotStatuses = desktopSlots?.statuses ?? []
  const privateSlotCount = desktopSlots?.privateCount ?? slotStatuses.filter(s => s.privateActive).length
  const publicSlotCount = configuredSlots - privateSlotCount
  const privateBadge = running
    ? (privateSlotCount === configuredSlots ? ' [ALL PRIVATE]'
      : privateSlotCount > 0 ? ` [${publicSlotCount} public, ${privateSlotCount} private]`
      : ' [PUBLIC]')
    : (desktopPrivateShareActive ? ' [PRIVATE]' : ' [PUBLIC]')

  if (state.privateShare !== undefined) {
    privateShare = preferLatestSync(privateShare, state.privateShare ?? null)
    if (!getPendingEdit('expiryHours')) {
      privateShareExpiry = getPrivateShareExpiryPreset(privateShare?.expires_at ?? null)
    }
  }
  if (!getPendingEdit('selectedSlotDeviceId') && !privateShareSelectionLocked) {
    if (state?.privateShareDeviceId) privateShareDeviceId = state.privateShareDeviceId
    else if (state?.privateShare?.device_id) privateShareDeviceId = state.privateShare.device_id
  }

  // Trim cached privateShares to the current configured slot count so the
  // private sharing dropdown never shows more slots than are actually configured.
  const currentConfiguredSlots = state?.slots?.configured ?? state?.connectionSlots ?? 1
  const currentBaseDeviceId = state?.baseDeviceId ?? state?.config?.baseDeviceId ?? null
  if (currentBaseDeviceId) {
    privateShares = privateShares.filter(row => {
      const match = row.device_id?.match(/^(.+)_slot_(\d+)$/)
      if (!match) return true
      if (match[1] !== currentBaseDeviceId) return true
      return parseInt(match[2], 10) < currentConfiguredSlots
    })
    // If the currently selected slot was trimmed away, reset selection
    if (privateShareDeviceId && !privateShares.some(row => row.device_id === privateShareDeviceId)) {
      privateShareDeviceId = privateShares[0]?.device_id ?? null
      privateShareSelectionLocked = false
      clearPendingEdit('selectedSlotDeviceId')
    }
  }

  renderPrivateShare()
  renderStartupPreferences(state)
  renderDesktopUpdate(state)
  renderDailyLimit(state)
  renderSlots(displaySlots.configured ?? configuredSlots, displaySlots)

  document.getElementById('stat-requests').textContent = String(displayStats.requestsHandled ?? 0)
  document.getElementById('stat-bytes').textContent = formatBytes(displayStats.bytesServed ?? 0)
  document.getElementById('stat-slots').textContent = `${displaySlots.active ?? 0} / ${displaySlots.configured ?? configuredSlots}`
  document.getElementById('user-label').textContent = config.userId ? `ID: ${config.userId.slice(0, 8)}` : ''

  if (!togglingShare) {
    if (running) {
      if (dot) {
        dot.className = 'status-dot on'
        dot.style.cssText = ''
      }
      if (label) {
        label.textContent = `SHARING - ${config.country} (${configuredSlots} slots)${privateBadge}`
        label.style.color = 'var(--accent)'
      }
      if (country) country.textContent = getFlagForCountry(config.country)
      if (statsEl) {
        statsEl.textContent = `${desktopSlots?.active ?? 0} / ${desktopSlots?.configured ?? configuredSlots} slots active - ${stats.requestsHandled} requests - ${formatBytes(stats.bytesServed)} served`
      }
      if (card) card.className = 'status-card active'
      if (peerBanner) peerBanner.style.display = 'none'
    } else if (peerSharing) {
      const privateBadge = peerPrivateShareActive ? ' [PRIVATE]' : ' [PUBLIC]'
      const peerConfigured = state.peerConnectionSlots ?? peerSlots?.configured ?? 1
      const peerActive = peerSlots?.active ?? 0
      if (dot) {
        dot.className = 'status-dot on'
        dot.style.cssText = ''
      }
      if (label) {
        label.textContent = `CLI IS SHARING${privateBadge}`
        label.style.color = 'var(--accent)'
      }
      if (country) country.textContent = ''
      if (statsEl) {
        statsEl.textContent = state.peerStats
          ? `${peerActive} / ${peerConfigured} slots active - ${state.peerStats.requestsHandled ?? 0} requests - ${formatBytes(state.peerStats.bytesServed ?? 0)} served`
          : 'CLI provider running on this machine'
      }
      if (card) card.className = 'status-card active'
      if (peerBanner) peerBanner.style.display = 'none'
    } else if (starting) {
      if (dot) {
        dot.className = 'status-dot'
        dot.style.cssText = 'animation:spin 0.7s linear infinite;background:transparent;border:2px solid var(--border);border-top-color:var(--accent)'
      }
      if (label) {
        label.textContent = `STARTING - ${config.country} (${configuredSlots} slots)`
        label.style.color = 'var(--muted)'
      }
      if (country) country.textContent = ''
      if (statsEl) statsEl.textContent = `Connecting ${configuredSlots} slot${configuredSlots === 1 ? '' : 's'}...`
      if (card) card.className = 'status-card'
      if (peerBanner) peerBanner.style.display = 'none'
    } else {
      if (dot) {
        dot.className = 'status-dot'
        dot.style.cssText = ''
      }
      if (label) {
        label.textContent = 'NOT SHARING'
        label.style.color = 'var(--muted)'
      }
      if (country) country.textContent = ''
      if (statsEl) statsEl.textContent = 'Toggle below to start sharing'
      if (card) card.className = 'status-card'
      if (peerBanner) peerBanner.style.display = 'none'
    }
  }

  setToggleVisual(document.getElementById('share-toggle'), {
    on: running || peerSharing,
    loading: togglingShare,
  })

  document.getElementById('toggle-desc').textContent = running
    ? 'Sharing active - earning credits'
    : peerSharing
      ? 'CLI is sharing'
      : _shareState === 'starting'
        ? 'Starting...'
        : _shareState === 'stopping'
          ? 'Stopping...'
          : starting
            ? 'Starting local sharing...'
            : 'Help others browse. Stay free.'
}

async function pollState() {
  const state = await invoke('getState')
  if (!state) return null
  if (state.version) setVersion(state.version)

  try {
    const response = await fetch('http://127.0.0.1:7656/native/state', { signal: AbortSignal.timeout(800) })
    if (response.ok) {
      const cli = await response.json()
      state.peerRunning = !!cli.running
      state.peerStats = cli.stats
      state.peerSlots = cli.slots
      state.peerConnectionSlots = cli.connectionSlots
      state.peerPrivateShareActive = !!cli.privateShareActive
    } else {
      state.peerRunning = false
    }
  } catch {
    state.peerRunning = false
  }

  updateUI(state)
  loadPrivateShare(false).catch(() => {})
  return state
}

async function updateStartupPreference(key, enabled) {
  const toggleId = key === 'launchOnStartup'
    ? 'setLaunchOnStartup'
    : key === 'preventSleepWhileSharing'
      ? 'setPreventSleepWhileSharing'
      : 'setAutoShareOnLaunch'
  startupBusy[key] = true
  renderStartupPreferences(window.__lastPeerMeshState || null)
  clearMainError()
  try {
    const result = await invoke(toggleId, enabled)
    if (!result?.success) throw new Error(result?.error || 'Could not update startup preference')
    await pollState()
  } catch (error) {
    showMainError(error?.message || 'Could not update startup preference')
  } finally {
    startupBusy[key] = false
    renderStartupPreferences(window.__lastPeerMeshState || null)
  }
}

async function updateSharingSchedule(patch) {
  const current = normalizeSharingSchedule(window.__lastPeerMeshState?.sharingSchedule ?? window.__lastPeerMeshState?.config?.sharingSchedule)
  const next = normalizeSharingSchedule({ ...current, ...patch })
  sharingScheduleSaving = true
  startupBusy.sharingSchedule = true
  renderStartupPreferences(window.__lastPeerMeshState || null)
  clearMainError()
  try {
    const result = await invoke('setSharingSchedule', next)
    if (!result?.success) throw new Error(result?.error || 'Could not update sharing schedule')
    await pollState()
  } catch (error) {
    showMainError(error?.message || 'Could not update sharing schedule')
  } finally {
    sharingScheduleSaving = false
    startupBusy.sharingSchedule = false
    renderStartupPreferences(window.__lastPeerMeshState || null)
  }
}

async function updateScheduleWake(enabled) {
  startupBusy.scheduleWakeEnabled = true
  startupPending.scheduleWakeEnabled = !!enabled
  renderStartupPreferences(window.__lastPeerMeshState || null)
  clearMainError()
  try {
    const result = await invoke('setScheduleWakeEnabled', enabled)
    if (!result?.success) throw new Error(result?.error || 'Could not update OS wake setting')
    await pollState()
  } catch (error) {
    showMainError(error?.message || 'Could not update OS wake setting')
  } finally {
    startupBusy.scheduleWakeEnabled = false
    startupPending.scheduleWakeEnabled = null
    renderStartupPreferences(window.__lastPeerMeshState || null)
  }
}

async function updateOnDemandWake(enabled) {
  startupBusy.onDemandWake = true
  renderStartupPreferences(window.__lastPeerMeshState || null)
  clearMainError()
  try {
    const result = await invoke('setOnDemandWakeEnabled', enabled)
    if (!result?.success) throw new Error(result?.error || 'Could not update on-demand wake setting')
    await pollState()
  } catch (error) {
    showMainError(error?.message || 'Could not update on-demand wake setting')
  } finally {
    startupBusy.onDemandWake = false
    renderStartupPreferences(window.__lastPeerMeshState || null)
  }
}

async function checkDesktopUpdate() {
  desktopUpdateBusy = true
  renderDesktopUpdate(window.__lastPeerMeshState || null)
  clearMainError()
  try {
    const result = await invoke('checkDesktopUpdate')
    if (!result?.success) throw new Error(result?.error || 'Could not check for update')
    if (window.__lastPeerMeshState) window.__lastPeerMeshState.desktopUpdate = result.update
    renderDesktopUpdate(window.__lastPeerMeshState || null)
  } catch (error) {
    showMainError(error?.message || 'Could not check for update')
  } finally {
    desktopUpdateBusy = false
    renderDesktopUpdate(window.__lastPeerMeshState || null)
  }
}

async function downloadDesktopUpdate() {
  desktopUpdateBusy = true
  renderDesktopUpdate(window.__lastPeerMeshState || null)
  clearMainError()
  try {
    const result = await invoke('downloadDesktopUpdate')
    if (!result?.success) throw new Error(result?.error || 'Could not open update download')
    if (window.__lastPeerMeshState) window.__lastPeerMeshState.desktopUpdate = result.update
  } catch (error) {
    showMainError(error?.message || 'Could not open update download')
  } finally {
    desktopUpdateBusy = false
    renderDesktopUpdate(window.__lastPeerMeshState || null)
  }
}

async function updatePrivateOnDemandStart(enabled) {
  startupBusy.privateOnDemandStart = true
  renderStartupPreferences(window.__lastPeerMeshState || null)
  clearMainError()
  try {
    const result = await invoke('setPrivateOnDemandStartEnabled', enabled)
    if (!result?.success) throw new Error(result?.error || 'Could not update private on-demand start setting')
    await pollState()
  } catch (error) {
    showMainError(error?.message || 'Could not update private on-demand start setting')
  } finally {
    startupBusy.privateOnDemandStart = false
    renderStartupPreferences(window.__lastPeerMeshState || null)
  }
}

document.getElementById('btn-open-browser').addEventListener('click', () => {
  stopDevicePoll()
  deviceFlowActive = false
  const btn = document.getElementById('btn-open-browser')
  if (btn) {
    btn.dataset.autoOpen = 'true'
    btn.disabled = true
    btn.textContent = 'GETTING CODE...'
  }
  const codeWaiting = document.getElementById('code-waiting')
  if (codeWaiting) {
    codeWaiting.style.display = 'flex'
    codeWaiting.innerHTML = '<span style="display:inline-block;width:10px;height:10px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite"></span> GETTING CODE...'
  }
  const statusEl = document.getElementById('auth-status')
  if (statusEl) {
    statusEl.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite"></span> WAITING FOR SIGN IN...'
  }
  startDeviceFlow()
})

document.getElementById('share-toggle').addEventListener('click', async () => {
  if (!navigator.onLine) {
    showMainError('No internet connection - sharing requires an active network')
    return
  }

  clearMainError()
  const state = await pollState() || await invoke('getState')
  const isSharing = !!(state?.running || state?.peerRunning)
  const isStarting = !isSharing && !!state?.shareEnabled

  // Already in the process of starting — ignore the click
  if (isStarting) return

  if (!isSharing) {
    let accepted = !!state?.config?.hasAcceptedProviderTerms
    if (!accepted) {
      const result = await invoke('acceptProviderTerms', { checkOnly: true })
      accepted = result?.accepted === true
    }
    if (!accepted) {
      showDisclosureModal()
      return
    }
  }

  await doToggleSharing(isSharing)
})

document.getElementById('launch-startup-toggle').addEventListener('click', async () => {
  const current = !!window.__lastPeerMeshState?.config?.launchOnStartup
  await updateStartupPreference('launchOnStartup', !current)
})

document.getElementById('auto-share-toggle').addEventListener('click', async () => {
  const current = !!window.__lastPeerMeshState?.config?.autoShareOnLaunch
  await updateStartupPreference('autoShareOnLaunch', !current)
})

document.getElementById('prevent-sleep-toggle').addEventListener('click', async () => {
  const current = !!window.__lastPeerMeshState?.config?.preventSleepWhileSharing
  await updateStartupPreference('preventSleepWhileSharing', !current)
})

document.getElementById('sharing-schedule-toggle').addEventListener('click', async () => {
  const current = normalizeSharingSchedule(window.__lastPeerMeshState?.sharingSchedule ?? window.__lastPeerMeshState?.config?.sharingSchedule)
  await updateSharingSchedule({ enabled: !current.enabled })
})

document.getElementById('sharing-schedule-save').addEventListener('click', async () => {
  const current = normalizeSharingSchedule(window.__lastPeerMeshState?.sharingSchedule ?? window.__lastPeerMeshState?.config?.sharingSchedule)
  await updateSharingSchedule({
    enabled: current.enabled,
    startTime: document.getElementById('sharing-schedule-start')?.value || current.startTime,
    endTime: document.getElementById('sharing-schedule-end')?.value || current.endTime,
    timezone: document.getElementById('sharing-schedule-timezone')?.value || current.timezone,
  })
})

document.getElementById('schedule-wake-toggle').addEventListener('click', async () => {
  const current = !!window.__lastPeerMeshState?.osWake?.enabled
  await updateScheduleWake(!current)
})

document.getElementById('on-demand-wake-toggle').addEventListener('click', async () => {
  const current = !!window.__lastPeerMeshState?.config?.allowOnDemandWake
  await updateOnDemandWake(!current)
})

document.getElementById('private-on-demand-start-toggle').addEventListener('click', async () => {
  const current = !!window.__lastPeerMeshState?.config?.allowPrivateOnDemandStart
  await updatePrivateOnDemandStart(!current)
})

document.getElementById('btn-dashboard').addEventListener('click', async () => {
  await invoke('openDashboard')
})

document.getElementById('desktop-update-check').addEventListener('click', checkDesktopUpdate)

document.getElementById('desktop-update-download').addEventListener('click', downloadDesktopUpdate)

document.getElementById('btn-signout').addEventListener('click', async () => {
  if (!confirm('Sign out of PeerMesh?')) return
  const btn = document.getElementById('btn-signout')
  if (btn) { btn.disabled = true; btn.textContent = 'Signing out...' }
  stopDevicePoll()
  resetAuthUI()
  await invoke('signOut')
  privateShare = null
  privateShares = []
  privateShareDeviceId = null
  privateShareSelectionLocked = false
  privateShareExpiry = 'none'
  clearPendingEdit('expiryHours')
  clearPendingEdit('selectedSlotDeviceId')
  slotLimits = {}
  slotDailyLimitInput = ''
  renderPrivateShare()
  await pollState()
  if (btn) { btn.disabled = false; btn.textContent = 'Sign out' }
  // Show auth screen but do NOT auto-open browser — user must click sign in
  const openBtn = document.getElementById('btn-open-browser')
  if (openBtn) openBtn.dataset.autoOpen = 'false'
})

document.getElementById('private-share-device').addEventListener('change', (event) => {
  privateShareDeviceId = event.target.value || null
  privateShareSelectionLocked = !!privateShareDeviceId
  setPendingEdit('selectedSlotDeviceId', privateShareDeviceId)
  const rows = getPrivateShareRows(window.__lastPeerMeshState || null)
  privateShare = rows.find(row => row.device_id === privateShareDeviceId) ?? rows[0] ?? null
  privateShareExpiry = getPrivateShareExpiryPreset(privateShare?.expires_at ?? null)
  clearPendingEdit('expiryHours')
  syncSlotDailyLimitInput()
  renderPrivateShare()
})

document.getElementById('copy-private-share').addEventListener('click', async () => {
  if (!privateShare?.code) return
  try {
    await navigator.clipboard.writeText(privateShare.code)
    const btn = document.getElementById('copy-private-share')
    const previous = btn.textContent
    btn.textContent = 'COPIED'
    setTimeout(() => { btn.textContent = previous }, 1500)
  } catch {}
})

document.getElementById('copy-private-link').addEventListener('click', async () => {
  if (!privateShare?.code) return
  const baseUrl = String(api.appBaseUrl || 'https://peermesh-0unl.onrender.com').replace(/\/$/, '')
  const link = `${baseUrl}/dashboard?privateCode=${encodeURIComponent(privateShare.code)}`
  try {
    await navigator.clipboard.writeText(link)
    const btn = document.getElementById('copy-private-link')
    const previous = btn.textContent
    btn.textContent = 'COPIED'
    setTimeout(() => { btn.textContent = previous }, 1500)
  } catch {
    showMainError('Could not copy private link')
  }
})

document.getElementById('private-share-expiry').addEventListener('change', async (event) => {
  privateShareExpiry = event.target.value
  setPendingEdit('expiryHours', event.target.value)
  renderPrivateShare()
  if (privateShare?.enabled && !privateShareSaving) {
    await savePrivateShare({ enabled: true, expiryHours: privateShareExpiry })
  }
})

document.getElementById('refresh-private-share').addEventListener('click', async () => {
  await savePrivateShare({ enabled: true, refresh: true, expiryHours: privateShareExpiry })
})

document.getElementById('toggle-private-share').addEventListener('click', async () => {
  const nextEnabled = !(privateShare?.enabled ?? false)
  await savePrivateShare({ enabled: nextEnabled, expiryHours: privateShareExpiry })
})

async function updateConnectionSlots(slots) {
  const nextSlots = Math.max(1, Math.min(32, parseInt(String(slots), 10) || 1))
  if (slotUpdating) return
  slotUpdating = true
  clearMainError()
  renderSlots(parseInt(document.getElementById('slots-value')?.textContent || String(nextSlots), 10) || nextSlots, window.__lastPeerMeshState?.slots)
  try {
    await invoke('setConnectionSlots', nextSlots)
    await pollState()
    await loadPrivateShare(true)
  } catch {
    showMainError('Could not update connection slots')
  } finally {
    slotUpdating = false
    renderSlots(window.__lastPeerMeshState?.slots?.configured ?? nextSlots, window.__lastPeerMeshState?.slots)
  }
}

async function saveDailyLimit(limitMb) {
  if (dailyLimitSaving) return
  dailyLimitSaving = true
  clearMainError()
  renderDailyLimit(window.__lastPeerMeshState || null)
  try {
    const result = await invoke('setDailyShareLimit', limitMb)
    if (!result?.success) throw new Error(result?.error || 'Could not update daily limit')
    await pollState()
  } catch (error) {
    showMainError(error?.message || 'Could not update daily limit')
  } finally {
    dailyLimitSaving = false
    renderDailyLimit(window.__lastPeerMeshState || null)
  }
}

async function saveSlotDailyLimit(limitMb) {
  if (slotDailyLimitSaving) return
  slotDailyLimitSaving = true
  clearMainError()
  renderPrivateShare()
  try {
    const result = await invoke('setSlotDailyLimit', {
      limitMb,
      deviceId: privateShareDeviceId ?? privateShare?.device_id ?? null,
      baseDeviceId: window.__lastPeerMeshState?.baseDeviceId ?? window.__lastPeerMeshState?.config?.baseDeviceId ?? null,
    })
    if (!result?.success) throw new Error(result?.error || 'Could not update slot daily limit')
    slotLimits = mapSlotLimits(result.slotLimits ?? Object.values(slotLimits))
    syncSlotDailyLimitInput()
    await pollState()
  } catch (error) {
    showMainError(error?.message || 'Could not update slot daily limit')
  } finally {
    slotDailyLimitSaving = false
    renderPrivateShare()
  }
}

document.getElementById('slots-decrement').addEventListener('click', async () => {
  const current = parseInt(document.getElementById('slots-value').textContent || '1', 10)
  await updateConnectionSlots(current - 1)
})

document.getElementById('slots-increment').addEventListener('click', async () => {
  const current = parseInt(document.getElementById('slots-value').textContent || '1', 10)
  await updateConnectionSlots(current + 1)
})

document.getElementById('daily-limit-save').addEventListener('click', async () => {
  const input = document.getElementById('daily-limit-input')
  const raw = input?.value?.trim() || ''
  const nextLimit = raw ? parseInt(raw, 10) : null
  await saveDailyLimit(nextLimit)
})

document.getElementById('daily-limit-input').addEventListener('input', (event) => {
  event.target.value = event.target.value.replace(/\D/g, '')
})

document.getElementById('daily-limit-input').addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter') return
  event.preventDefault()
  const raw = event.target.value.trim()
  const nextLimit = raw ? parseInt(raw, 10) : null
  await saveDailyLimit(nextLimit)
})

document.getElementById('daily-limit-none').addEventListener('click', async () => {
  const input = document.getElementById('daily-limit-input')
  if (input) input.value = ''
  await saveDailyLimit(null)
})

document.getElementById('daily-limit-1gb').addEventListener('click', async () => {
  const input = document.getElementById('daily-limit-input')
  if (input) input.value = '1024'
  await saveDailyLimit(1024)
})

document.getElementById('daily-limit-2gb').addEventListener('click', async () => {
  const input = document.getElementById('daily-limit-input')
  if (input) input.value = '2048'
  await saveDailyLimit(2048)
})

document.getElementById('daily-limit-5gb').addEventListener('click', async () => {
  const input = document.getElementById('daily-limit-input')
  if (input) input.value = '5120'
  await saveDailyLimit(5120)
})

document.getElementById('slot-daily-limit-input').addEventListener('input', (event) => {
  slotDailyLimitInput = event.target.value.replace(/\D/g, '')
})

document.getElementById('slot-daily-limit-input').addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter') return
  event.preventDefault()
  const raw = event.target.value.trim()
  const nextLimit = raw ? parseInt(raw, 10) : null
  await saveSlotDailyLimit(nextLimit)
})

document.getElementById('slot-daily-limit-save').addEventListener('click', async () => {
  const input = document.getElementById('slot-daily-limit-input')
  const raw = input?.value?.trim() || ''
  const nextLimit = raw ? parseInt(raw, 10) : null
  await saveSlotDailyLimit(nextLimit)
})

document.getElementById('slot-daily-limit-none').addEventListener('click', async () => {
  const input = document.getElementById('slot-daily-limit-input')
  if (input) input.value = ''
  slotDailyLimitInput = ''
  await saveSlotDailyLimit(null)
})

document.getElementById('slot-daily-limit-1gb').addEventListener('click', async () => {
  const input = document.getElementById('slot-daily-limit-input')
  if (input) input.value = '1024'
  slotDailyLimitInput = '1024'
  await saveSlotDailyLimit(1024)
})

document.getElementById('slot-daily-limit-2gb').addEventListener('click', async () => {
  const input = document.getElementById('slot-daily-limit-input')
  if (input) input.value = '2048'
  slotDailyLimitInput = '2048'
  await saveSlotDailyLimit(2048)
})

document.getElementById('slot-daily-limit-5gb').addEventListener('click', async () => {
  const input = document.getElementById('slot-daily-limit-input')
  if (input) input.value = '5120'
  slotDailyLimitInput = '5120'
  await saveSlotDailyLimit(5120)
})

setInterval(() => {
  pollState().catch(() => {})
}, 2000)

if (window.peermesh?.onSharingError) {
  window.peermesh.onSharingError((message) => {
    showMainError(message)
    pollState().catch(() => {})
  })
}

setOffline(!navigator.onLine)
renderPrivateShare()
renderStartupPreferences(null)
renderDesktopUpdate(null)
renderDailyLimit(null)

const openBtn = document.getElementById('btn-open-browser')
if (openBtn) openBtn.dataset.autoOpen = 'false'

pollState().then((state) => {
  // loading screen is hidden by showScreen() inside updateUI/pollState
  // If pollState failed entirely, fall back to auth screen
  if (!state) {
    const loading = document.getElementById('loading-screen')
    if (loading) loading.style.display = 'none'
    showScreen('auth-screen')
  }
  if (!state?.config?.userId) {
    // Show auth screen passively — do NOT auto-start device flow
    const codeWaiting = document.getElementById('code-waiting')
    if (codeWaiting) codeWaiting.style.display = 'none'
    const codePlaceholder = document.getElementById('code-placeholder')
    if (codePlaceholder) codePlaceholder.style.display = 'block'
    const statusEl = document.getElementById('auth-status')
    if (statusEl) statusEl.textContent = 'Click the button above to sign in'
  }
}).catch(() => {
  const loading = document.getElementById('loading-screen')
  if (loading) loading.style.display = 'none'
  showScreen('auth-screen')
})

// Keep auth screen passive until the user clicks sign in.
window.addEventListener('focus', () => {
  const authScreen = document.getElementById('auth-screen')
  if (!authScreen?.classList.contains('active')) return
})
