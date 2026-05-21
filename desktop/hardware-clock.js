const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const HARDWARE_WAKE_TASK_NAME = 'PeerMesh Hardware Wake'
const MIN_WAKE_LEAD_SECONDS = 120
const MIN_UNPLUGGED_BATTERY_PERCENT = 35

function pad(value) {
  return String(value).padStart(2, '0')
}

function assertWakeDate(wakeAt, now = new Date()) {
  const date = wakeAt instanceof Date ? wakeAt : new Date(wakeAt)
  const time = date.getTime()
  if (!Number.isFinite(time)) throw new Error('Invalid wake time')
  const seconds = Math.floor((time - now.getTime()) / 1000)
  if (seconds <= MIN_WAKE_LEAD_SECONDS) {
    throw new Error('Wake time must be at least 2 minutes in the future.')
  }
  return { date, seconds }
}

function normalizeBatteryStatus(battery = {}) {
  const percentage = Number.parseInt(String(battery.percentage ?? 100), 10)
  return {
    isPluggedIn: battery.isPluggedIn !== false,
    percentage: Number.isFinite(percentage) ? Math.max(0, Math.min(100, percentage)) : 100,
  }
}

function assertBatterySafe(battery) {
  const normalized = normalizeBatteryStatus(battery)
  if (!normalized.isPluggedIn && normalized.percentage < MIN_UNPLUGGED_BATTERY_PERCENT) {
    throw new Error(`Battery safety threshold breached (${normalized.percentage}%). Aborting hardware wake setup.`)
  }
  return normalized
}

function formatWindowsLocalDateTime(date) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function formatMacPmsetDate(date) {
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${String(date.getFullYear()).slice(-2)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function buildWindowsWakeTaskXml({ wakeAt, executable, args = '' }) {
  const startBoundary = formatWindowsLocalDateTime(wakeAt)
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>PeerMesh</Author>
    <Description>Wakes this PC so PeerMesh can start scheduled sharing.</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${xmlEscape(startBoundary)}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <WakeToRun>true</WakeToRun>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(executable)}</Command>
      ${args ? `<Arguments>${xmlEscape(args)}</Arguments>` : ''}
    </Exec>
  </Actions>
</Task>`
}

function runProcessDefault(command, args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch {}
      reject(new Error(`${command} timed out`))
    }, timeoutMs)

    child.stdout?.on('data', chunk => { stdout += chunk.toString() })
    child.stderr?.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error((stderr || stdout || `${command} exited ${code}`).trim()))
    })
  })
}

async function registerWindowsHardwareWakeTask({ wakeAt, launchTarget, runProcess = runProcessDefault }) {
  const xml = buildWindowsWakeTaskXml({
    wakeAt,
    executable: launchTarget.executable,
    args: launchTarget.args,
  })
  const xmlPath = path.join(os.tmpdir(), `peermesh-hardware-wake-${process.pid}.xml`)
  fs.writeFileSync(xmlPath, Buffer.from('\ufeff' + xml, 'utf16le'))
  try {
    await runProcess('schtasks.exe', ['/Delete', '/TN', HARDWARE_WAKE_TASK_NAME, '/F'], { timeoutMs: 10000 }).catch(() => {})
    await runProcess('schtasks.exe', ['/Create', '/TN', HARDWARE_WAKE_TASK_NAME, '/XML', xmlPath, '/F'], { timeoutMs: 15000 })
  } finally {
    try { fs.unlinkSync(xmlPath) } catch {}
  }
}

async function unregisterWindowsHardwareWakeTask({ runProcess = runProcessDefault } = {}) {
  await runProcess('schtasks.exe', ['/Delete', '/TN', HARDWARE_WAKE_TASK_NAME, '/F'], { timeoutMs: 10000 }).catch(() => {})
}

async function registerMacHardwareWake({ wakeAt, runProcess = runProcessDefault }) {
  const formatted = formatMacPmsetDate(wakeAt)
  const escaped = formatted.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  await runProcess('osascript', [
    '-e',
    `do shell script "pmset schedule wakeorpoweron \\"${escaped}\\"" with administrator privileges`,
  ], { timeoutMs: 30000 })
}

async function registerLinuxHardwareWake({ seconds, runProcess = runProcessDefault }) {
  const safeSeconds = Math.max(MIN_WAKE_LEAD_SECONDS + 1, Number.parseInt(String(seconds), 10))
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    await runProcess('rtcwake', ['-m', 'no', '-s', String(safeSeconds)], { timeoutMs: 15000 })
    return
  }

  await runProcess('pkexec', ['rtcwake', '-m', 'no', '-s', String(safeSeconds)], { timeoutMs: 30000 })
}

async function scheduleHardwareWake({
  wakeAt,
  battery,
  platform = process.platform,
  launchTarget = { executable: process.execPath, args: '' },
  runProcess = runProcessDefault,
  now = new Date(),
} = {}) {
  try {
    const { date, seconds } = assertWakeDate(wakeAt, now)
    const safeBattery = assertBatterySafe(battery)

    if (platform === 'win32') {
      await registerWindowsHardwareWakeTask({ wakeAt: date, launchTarget, runProcess })
      return { success: true, method: 'windows_task_scheduler_wake', wakeAt: date.toISOString(), battery: safeBattery }
    }

    if (platform === 'darwin') {
      await registerMacHardwareWake({ wakeAt: date, runProcess })
      return { success: true, method: 'mac_pmset_wakeorpoweron', wakeAt: date.toISOString(), battery: safeBattery }
    }

    if (platform === 'linux') {
      await registerLinuxHardwareWake({ seconds, runProcess })
      return { success: true, method: 'linux_rtcwake', wakeAt: date.toISOString(), battery: safeBattery }
    }

    throw new Error(`Unsupported operating system platform: ${platform}`)
  } catch (error) {
    return { success: false, method: platform || 'unknown', error: error.message || String(error) }
  }
}

function buildWindowsDisableFastStartupArgs() {
  return [
    'add',
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power',
    '/v',
    'HiberbootEnabled',
    '/t',
    'REG_DWORD',
    '/d',
    '0',
    '/f',
  ]
}

function buildShutdownArgs(platform = process.platform, graceSeconds = 300) {
  const safeGraceSeconds = Math.max(0, Math.min(3600, Number.parseInt(String(graceSeconds), 10) || 0))
  if (platform === 'win32') {
    return { command: 'shutdown.exe', args: ['/s', '/t', String(safeGraceSeconds), '/f', '/c', 'PeerMesh scheduled uptime window ended.'] }
  }
  if (platform === 'darwin') {
    return { command: 'osascript', args: ['-e', 'do shell script "shutdown -h now" with administrator privileges'] }
  }
  if (platform === 'linux') {
    return { command: 'pkexec', args: ['poweroff'] }
  }
  throw new Error(`Unsupported operating system platform: ${platform}`)
}

async function readBatteryStatus({ platform = process.platform, runProcess = runProcessDefault } = {}) {
  if (platform === 'linux') {
    const powerRoot = '/sys/class/power_supply'
    try {
      const entries = fs.readdirSync(powerRoot)
      const batteryName = entries.find(name => name.startsWith('BAT'))
      const acName = entries.find(name => /^(AC|ADP|ACAD)/i.test(name))
      const percentage = batteryName
        ? Number.parseInt(fs.readFileSync(path.join(powerRoot, batteryName, 'capacity'), 'utf8'), 10)
        : 100
      const online = acName
        ? fs.readFileSync(path.join(powerRoot, acName, 'online'), 'utf8').trim() === '1'
        : true
      return normalizeBatteryStatus({ isPluggedIn: online, percentage })
    } catch {
      return normalizeBatteryStatus({ isPluggedIn: true, percentage: 100 })
    }
  }

  if (platform === 'darwin') {
    try {
      const { stdout } = await runProcess('pmset', ['-g', 'batt'], { timeoutMs: 5000 })
      const plugged = /AC Power/i.test(stdout)
      const match = /(\d+)%/.exec(stdout)
      return normalizeBatteryStatus({ isPluggedIn: plugged, percentage: match ? Number.parseInt(match[1], 10) : 100 })
    } catch {
      return normalizeBatteryStatus({ isPluggedIn: true, percentage: 100 })
    }
  }

  if (platform === 'win32') {
    try {
      const { stdout } = await runProcess('powershell.exe', [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Battery | Select-Object -First 1 BatteryStatus,EstimatedChargeRemaining | ConvertTo-Json -Compress',
      ], { timeoutMs: 5000 })
      const data = stdout.trim() ? JSON.parse(stdout.trim()) : null
      if (!data) return normalizeBatteryStatus({ isPluggedIn: true, percentage: 100 })
      const status = Number.parseInt(String(data.BatteryStatus ?? ''), 10)
      return normalizeBatteryStatus({
        isPluggedIn: [2, 6, 7, 8, 9, 11].includes(status),
        percentage: data.EstimatedChargeRemaining ?? 100,
      })
    } catch {
      return normalizeBatteryStatus({ isPluggedIn: true, percentage: 100 })
    }
  }

  return normalizeBatteryStatus({ isPluggedIn: true, percentage: 100 })
}

module.exports = {
  HARDWARE_WAKE_TASK_NAME,
  MIN_WAKE_LEAD_SECONDS,
  MIN_UNPLUGGED_BATTERY_PERCENT,
  assertBatterySafe,
  assertWakeDate,
  buildShutdownArgs,
  buildWindowsDisableFastStartupArgs,
  buildWindowsWakeTaskXml,
  formatMacPmsetDate,
  formatWindowsLocalDateTime,
  readBatteryStatus,
  registerWindowsHardwareWakeTask,
  registerMacHardwareWake,
  registerLinuxHardwareWake,
  scheduleHardwareWake,
  unregisterWindowsHardwareWakeTask,
}
