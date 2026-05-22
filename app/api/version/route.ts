import { NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { join } from 'path'
import { DESKTOP_PLATFORM_EXT, findLatestDesktopVersionSync, type DesktopPlatform } from '@/lib/download-artifacts'

export const dynamic = 'force-dynamic'

function getLatestDesktopVersion(platform: DesktopPlatform): string | null {
  return findLatestDesktopVersionSync(join(process.cwd(), 'public'), DESKTOP_PLATFORM_EXT[platform])
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
  const desktopVersions = {
    win: getLatestDesktopVersion('win'),
    mac: getLatestDesktopVersion('mac'),
    linux: getLatestDesktopVersion('linux'),
  }
  const defaultDesktopVersion = desktopVersions.win ?? desktopVersions.mac ?? desktopVersions.linux

  return NextResponse.json({
    api: {
      version: 'v1',
      prefix: '/api',
      docs: '/developers/api-docs',
    },
    desktop: defaultDesktopVersion,
    downloads: {
      desktop: {
        win: desktopVersions.win ? { version: desktopVersions.win, url: '/api/desktop-download?platform=win' } : null,
        mac: desktopVersions.mac ? { version: desktopVersions.mac, url: '/api/desktop-download?platform=mac' } : null,
        linux: desktopVersions.linux ? { version: desktopVersions.linux, url: '/api/desktop-download?platform=linux' } : null,
      },
    },
    extension: getExtensionVersion(),
    cli: getCliVersion(),
  })
}
