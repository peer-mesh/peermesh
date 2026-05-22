import { readdirSync } from 'fs'
import { readdir } from 'fs/promises'

export type DesktopPlatform = 'win' | 'mac' | 'linux'

export const DESKTOP_PLATFORM_EXT: Record<DesktopPlatform, string> = {
  win: '.exe',
  mac: '.dmg',
  linux: '.AppImage',
}

export function compareVersions(a: string, b: string): number {
  const aParts = a.split(/[.-]/).map(part => Number.parseInt(part, 10) || 0)
  const bParts = b.split(/[.-]/).map(part => Number.parseInt(part, 10) || 0)
  const length = Math.max(aParts.length, bParts.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (aParts[index] ?? 0) - (bParts[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function getDesktopInstallerVersion(file: string, ext?: string): string | null {
  const escapedExt = ext ? ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '\\.(exe|dmg|AppImage)'
  const match = new RegExp(`^PeerMesh-Setup_(.+)${escapedExt}$`).exec(file)
  return match?.[1] ?? null
}

export function findLatestDesktopInstallerFile(files: string[], ext: string): string | null {
  const candidates = files
    .map(file => ({ file, version: getDesktopInstallerVersion(file, ext) }))
    .filter((entry): entry is { file: string; version: string } => !!entry.version)

  candidates.sort((a, b) => compareVersions(b.version, a.version))
  return candidates[0]?.file ?? null
}

export function findLatestDesktopVersionSync(dir: string, ext = '.exe'): string | null {
  try {
    const latest = findLatestDesktopInstallerFile(readdirSync(dir), ext)
    return latest ? getDesktopInstallerVersion(latest, ext) : null
  } catch {
    return null
  }
}

export async function findLatestDesktopInstaller(dir: string, ext: string): Promise<string | null> {
  try {
    return findLatestDesktopInstallerFile(await readdir(dir), ext)
  } catch {
    return null
  }
}
