import { NextResponse } from 'next/server'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

function compareVersions(a: string, b: string): number {
  const aParts = a.split(/[.-]/).map(part => Number.parseInt(part, 10) || 0)
  const bParts = b.split(/[.-]/).map(part => Number.parseInt(part, 10) || 0)
  const length = Math.max(aParts.length, bParts.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (aParts[index] ?? 0) - (bParts[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function getLatestDesktopVersion(): string | null {
  try {
    const files = readdirSync(join(process.cwd(), 'public'))
    const versions = files
      .map(file => file.match(/^PeerMesh-Setup_(.+)\.exe$/)?.[1] ?? null)
      .filter((version): version is string => !!version)
    if (!versions.length) return null
    versions.sort(compareVersions).reverse()
    return versions[0] ?? null
  } catch { return null }
}

function getExtensionVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'extension', 'manifest.json'), 'utf-8'))
    return manifest.version ?? '1.0.0'
  } catch { return '1.0.0' }
}

function getCliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'cli', 'package.json'), 'utf-8'))
    return pkg.version ?? '1.0.0'
  } catch { return '1.0.0' }
}

export async function GET() {
  return NextResponse.json({
    api: {
      version: 'v1',
      prefix: '/api',
      docs: '/developers/api-docs',
    },
    desktop: getLatestDesktopVersion(),
    extension: getExtensionVersion(),
    cli: getCliVersion(),
  })
}
