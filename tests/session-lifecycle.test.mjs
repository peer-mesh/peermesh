import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')

function readRepoFile(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

test('stale session cleanup uses relay activity, not fixed active-session age', () => {
  const sql = readRepoFile('supabase.sql')

  assert.match(sql, /last_activity_at timestamptz default now\(\)/)
  assert.match(sql, /status = 'active'[\s\S]+coalesce\(last_activity_at, started_at\) < now\(\) - interval '5 minutes'/)
  assert.doesNotMatch(sql, /status in \('pending', 'active', 'reconnecting'\)[\s\S]+started_at < now\(\) - interval '30 minutes'/)
})

test('relay heartbeats active DB sessions so healthy sessions persist', () => {
  const relay = readRepoFile('relay/relay.js')

  assert.match(relay, /function touchSessionActivity\(/)
  assert.match(relay, /lastActivityAt: new Date\(now\)\.toISOString\(\)/)
  assert.match(relay, /touchSessionActivity\(session, 'watchdog'\)/)
})

test('requester refresh remains reachable while relay socket is open', () => {
  const serviceWorker = readRepoFile('extension/background/service-worker.js')
  const openBranchIndex = serviceWorker.indexOf('relayWs && relayWs.readyState === WebSocket.OPEN')
  const refreshIndex = serviceWorker.indexOf('REQUESTER_SESSION_REFRESH_MS', openBranchIndex)
  const healthIndex = serviceWorker.indexOf('${CONTROL_PORT}/health', openBranchIndex)

  assert.notEqual(openBranchIndex, -1)
  assert.notEqual(refreshIndex, -1)
  assert.notEqual(healthIndex, -1)
  assert.ok(refreshIndex < healthIndex)
})
