import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const hardwareClock = require('../desktop/hardware-clock.js')

test('Windows wake XML uses Task Scheduler schema and StartBoundary', () => {
  const wakeAt = new Date(2026, 4, 22, 6, 5, 9)
  const xml = hardwareClock.buildWindowsWakeTaskXml({
    wakeAt,
    executable: 'C:\\Program Files\\PeerMesh\\PeerMesh.exe',
    args: '--background',
  })

  assert.match(xml, /xmlns="http:\/\/schemas\.microsoft\.com\/windows\/2004\/02\/mit\/task"/)
  assert.match(xml, /<StartBoundary>2026-05-22T06:05:09<\/StartBoundary>/)
  assert.match(xml, /<WakeToRun>true<\/WakeToRun>/)
  assert.doesNotMatch(xml, /StartText/)
})

test('hardware wake rejects unsafe battery and near-past wake times', async () => {
  const now = new Date('2026-05-21T12:00:00.000Z')
  const lowBattery = await hardwareClock.scheduleHardwareWake({
    wakeAt: new Date('2026-05-21T12:10:00.000Z'),
    battery: { isPluggedIn: false, percentage: 20 },
    platform: 'win32',
    now,
    runProcess: async () => ({ stdout: '', stderr: '' }),
  })
  assert.equal(lowBattery.success, false)
  assert.match(lowBattery.error, /Battery safety threshold/)

  const tooSoon = await hardwareClock.scheduleHardwareWake({
    wakeAt: new Date('2026-05-21T12:01:00.000Z'),
    battery: { isPluggedIn: true, percentage: 100 },
    platform: 'win32',
    now,
    runProcess: async () => ({ stdout: '', stderr: '' }),
  })
  assert.equal(tooSoon.success, false)
  assert.match(tooSoon.error, /at least 2 minutes/)
})

test('Windows hardware wake registers a schtasks XML task', async () => {
  const calls = []
  const result = await hardwareClock.scheduleHardwareWake({
    wakeAt: new Date('2026-05-21T12:10:00.000Z'),
    battery: { isPluggedIn: true, percentage: 90 },
    platform: 'win32',
    now: new Date('2026-05-21T12:00:00.000Z'),
    launchTarget: { executable: 'PeerMesh.exe', args: '--background' },
    runProcess: async (command, args) => {
      calls.push({ command, args })
      return { stdout: '', stderr: '' }
    },
  })

  assert.equal(result.success, true)
  assert.equal(result.method, 'windows_task_scheduler_wake')
  assert.equal(calls.some(call => call.command === 'schtasks.exe' && call.args.includes('/Create')), true)
})

test('macOS and Linux wake commands use native OS power utilities', async () => {
  const macCalls = []
  const mac = await hardwareClock.scheduleHardwareWake({
    wakeAt: new Date('2026-05-21T12:10:00.000Z'),
    battery: { isPluggedIn: true, percentage: 90 },
    platform: 'darwin',
    now: new Date('2026-05-21T12:00:00.000Z'),
    runProcess: async (command, args) => {
      macCalls.push({ command, args })
      return { stdout: '', stderr: '' }
    },
  })
  assert.equal(mac.success, true)
  assert.equal(mac.method, 'mac_pmset_wakeorpoweron')
  assert.equal(macCalls[0].command, 'osascript')
  assert.match(macCalls[0].args.join(' '), /pmset schedule wakeorpoweron/)

  const linuxCalls = []
  const linux = await hardwareClock.scheduleHardwareWake({
    wakeAt: new Date('2026-05-21T12:10:00.000Z'),
    battery: { isPluggedIn: true, percentage: 90 },
    platform: 'linux',
    now: new Date('2026-05-21T12:00:00.000Z'),
    runProcess: async (command, args) => {
      linuxCalls.push({ command, args })
      return { stdout: '', stderr: '' }
    },
  })
  assert.equal(linux.success, true)
  assert.equal(linux.method, 'linux_rtcwake')
  assert.equal(linuxCalls[0].command, 'pkexec')
  assert.deepEqual(linuxCalls[0].args, ['rtcwake', '-m', 'no', '-s', '600'])
})

test('destructive shutdown helpers are explicit and inspectable', () => {
  assert.deepEqual(hardwareClock.buildWindowsDisableFastStartupArgs(), [
    'add',
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power',
    '/v',
    'HiberbootEnabled',
    '/t',
    'REG_DWORD',
    '/d',
    '0',
    '/f',
  ])

  const windowsShutdown = hardwareClock.buildShutdownArgs('win32', 10)
  assert.equal(windowsShutdown.command, 'shutdown.exe')
  assert.deepEqual(windowsShutdown.args.slice(0, 4), ['/s', '/t', '10', '/f'])
})
