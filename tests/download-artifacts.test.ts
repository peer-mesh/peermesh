import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareVersions,
  findLatestDesktopInstallerFile,
  getDesktopInstallerVersion,
} from '../lib/download-artifacts.ts'

test('compares dotted desktop versions numerically', () => {
  assert.equal(compareVersions('1.0.100', '1.0.99') > 0, true)
  assert.equal(compareVersions('1.10.0', '1.2.9') > 0, true)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
})

test('finds latest desktop installer by semantic version instead of filename sort', () => {
  const files = [
    'PeerMesh-Setup_1.0.9.exe',
    'PeerMesh-Setup_1.0.100.exe',
    'PeerMesh-Setup_1.0.31.exe',
    'PeerMesh-Setup_1.0.99.dmg',
  ]

  const latest = findLatestDesktopInstallerFile(files, '.exe')
  assert.equal(latest, 'PeerMesh-Setup_1.0.100.exe')
  assert.equal(getDesktopInstallerVersion(latest ?? '', '.exe'), '1.0.100')
})
