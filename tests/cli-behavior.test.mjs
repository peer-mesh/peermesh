import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(import.meta.dirname, '..')
const cliPath = join(repoRoot, 'cli', 'index.js')
const apiBase = 'https://peermesh-beta.vercel.app'

function makeHome(config = {}) {
  const home = mkdtempSync(join(tmpdir(), 'peermesh-cli-test-'))
  const configDir = join(home, '.peermesh')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'machine-identity.json'), JSON.stringify({
    baseDeviceId: 'pm_cli_test',
    updatedAt: '2026-05-16T00:00:00.000Z',
  }, null, 2))
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    baseDeviceId: 'pm_cli_test',
    deviceId: 'pm_cli_test',
    token: 'old-token',
    refreshToken: 'old-refresh',
    deviceSessionId: 'session-1',
    userId: 'user-1',
    username: 'alice',
    country: 'NG',
    connectionSlots: 1,
    privateShares: [],
    ...config,
  }, null, 2))
  return home
}

const defaultSharingResponse = {
  daily_share_limit_mb: 2048,
  total_bytes_today: 2048,
  has_accepted_provider_terms: true,
  profile_sync: { state_actor: 'dashboard', state_changed_at: '2026-05-16T01:02:03.000Z' },
  connection_slots: 3,
  connection_slots_sync: { state_actor: 'extension', state_changed_at: '2026-05-16T01:03:04.000Z' },
  private_shares: [
    {
      device_id: 'pm_cli_test_slot_1',
      base_device_id: 'pm_cli_test',
      slot_index: 1,
      code: 'PRIV222',
      enabled: true,
      active: true,
      expires_at: null,
      state_actor: 'dashboard',
      state_changed_at: '2026-05-16T01:04:05.000Z',
    },
  ],
}

function runCli(args, { home = makeHome(), mockFetch = true, sharingResponse = defaultSharingResponse, refreshResponse = { token: 'new-token', refreshToken: 'new-refresh', deviceSessionId: 'session-2' }, refreshStatus = 200 } = {}) {
  const sharingResponseJson = JSON.stringify(sharingResponse)
  const refreshResponseJson = JSON.stringify(refreshResponse)
  const preload = mockFetch
    ? `data:text/javascript,${encodeURIComponent(`
      const realFetch = globalThis.fetch.bind(globalThis);
      const json = (body, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
      globalThis.fetch = async (input, init = {}) => {
        const url = String(input?.url ?? input);
        if (url === 'https://registry.npmjs.org/@btcmaster1000/peermesh-provider/latest') {
          return json({ version: '1.0.57' });
        }
        if (url === '${apiBase}/api/extension-auth/refresh') {
          return json(${refreshResponseJson}, ${refreshStatus});
        }
        if (url.startsWith('${apiBase}/api/user/sharing')) {
          return json(${sharingResponseJson});
        }
        if (url.startsWith('http://127.0.0.1:')) throw new Error('control server unavailable in test');
        throw new Error('Unexpected fetch: ' + url);
      };
    `)}`
    : null
  const nodeArgs = preload ? ['--import', preload, cliPath, ...args] : [cliPath, ...args]
  return spawnSync(process.execPath, nodeArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      NO_COLOR: '1',
    },
    encoding: 'utf8',
    timeout: 15000,
  })
}

test('CLI --status prints synced profile, slot, and private sharing state', () => {
  const result = runCli(['--status'])

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /User:\s+alice/)
  assert.match(result.stdout, /Country:\s+NG/)
  assert.match(result.stdout, /Slots:\s+3/)
  assert.match(result.stdout, /Shared today:\s+2\.0KB/)
  assert.match(result.stdout, /Daily limit:\s+2048 MB/)
  assert.match(result.stdout, /Profile sync:\s+DASHBOARD @/)
  assert.match(result.stdout, /Slot sync:\s+EXTENSION @/)
  assert.match(result.stdout, /Slot 1: IDLE\s+req=0\s+served=0B\s+mode=PUBLIC\s+code=---------/)
  assert.match(result.stdout, /Slot 2: IDLE\s+req=0\s+served=0B\s+mode=PRIVATE\s+code=PRIV222\s+expiry=no expiry\s+sync=DASHBOARD @/)
  assert.doesNotMatch(result.stderr, /ReferenceError|nextPrivateShareCode/)
})

test('CLI --status trims private rows after remote slot count reduction', () => {
  const home = makeHome({
    connectionSlots: 2,
    privateShareDeviceId: 'pm_cli_test_slot_1',
    privateShares: [
      {
        device_id: 'pm_cli_test_slot_0',
        base_device_id: 'pm_cli_test',
        slot_index: 0,
        code: 'PRIV111',
        enabled: true,
        active: true,
        expires_at: null,
        state_actor: 'cli',
        state_changed_at: '2026-05-16T01:00:00.000Z',
      },
      {
        device_id: 'pm_cli_test_slot_1',
        base_device_id: 'pm_cli_test',
        slot_index: 1,
        code: 'STALE222',
        enabled: true,
        active: true,
        expires_at: null,
        state_actor: 'cli',
        state_changed_at: '2026-05-16T01:00:00.000Z',
      },
    ],
  })
  const result = runCli(['--status'], {
    home,
    sharingResponse: {
      ...defaultSharingResponse,
      connection_slots: 1,
      private_shares: [
        {
          device_id: 'pm_cli_test_slot_0',
          base_device_id: 'pm_cli_test',
          slot_index: 0,
          code: 'PRIV111',
          enabled: true,
          active: true,
          expires_at: null,
          state_actor: 'dashboard',
          state_changed_at: '2026-05-16T01:04:05.000Z',
        },
        {
          device_id: 'pm_cli_test_slot_1',
          base_device_id: 'pm_cli_test',
          slot_index: 1,
          code: 'STALE222',
          enabled: true,
          active: true,
          expires_at: null,
          state_actor: 'dashboard',
          state_changed_at: '2026-05-16T01:04:05.000Z',
        },
      ],
    },
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /Slots:\s+1/)
  assert.match(result.stdout, /Slot 1: IDLE\s+req=0\s+served=0B\s+mode=PRIVATE\s+code=PRIV111/)
  assert.doesNotMatch(result.stdout, /Slot 2/)
  assert.doesNotMatch(result.stdout, /STALE222/)
})

test('CLI status exits cleanly when refresh says device was revoked', () => {
  const result = runCli(['--status'], {
    refreshStatus: 403,
    refreshResponse: { revoked: true },
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /Sign in required/)
  assert.doesNotMatch(result.stderr + result.stdout, /TypeError|Cannot read properties|Assertion failed/)
})

test('CLI validates slot count before authentication', () => {
  const home = makeHome({ token: null, userId: null })
  const result = runCli(['--slots', '0'], { home, mockFetch: false })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /--slots must be an integer between 1 and 32/)
  assert.doesNotMatch(result.stdout, /Requesting sign-in code/)
})
