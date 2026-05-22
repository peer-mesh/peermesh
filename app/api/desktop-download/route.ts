import { NextResponse } from 'next/server'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { DESKTOP_PLATFORM_EXT, findLatestDesktopInstaller, getDesktopInstallerVersion } from '@/lib/download-artifacts'

type Platform = 'win' | 'mac' | 'linux'

const PLATFORM_MIME: Record<Platform, string> = {
  win:   'application/octet-stream',
  mac:   'application/x-apple-diskimage',
  linux: 'application/octet-stream',
}

function detectPlatform(ua: string): Platform {
  if (/linux/i.test(ua) && !/android/i.test(ua)) return 'linux'
  if (/mac os x|macintosh/i.test(ua)) return 'mac'
  return 'win' // default to Windows
}

export async function GET(req: Request) {
  const ua = req.headers.get('user-agent') ?? ''

  // Allow override via ?platform=win|mac|linux
  const { searchParams } = new URL(req.url)
  const override = searchParams.get('platform') as Platform | null
  const platform: Platform = (override && override in PLATFORM_MIME) ? override : detectPlatform(ua)

  const mime = PLATFORM_MIME[platform]
  const ext = DESKTOP_PLATFORM_EXT[platform]

  // Try public/ first (Vercel)
  const publicDir = join(process.cwd(), 'public')
  const publicFile = await findLatestDesktopInstaller(publicDir, ext)
  if (publicFile) {
    const content = await readFile(join(publicDir, publicFile))
    return new NextResponse(content, {
      headers: {
        'Content-Type': mime,
        'Content-Disposition': `attachment; filename="${publicFile}"`,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Platform': platform,
        'X-PeerMesh-Version': getDesktopInstallerVersion(publicFile, ext) ?? '',
      },
    })
  }

  // Try desktop/dist/ (local dev)
  try {
    const distDir = join(process.cwd(), 'desktop', 'dist')
    const found = await findLatestDesktopInstaller(distDir, ext)
    if (found) {
      const content = await readFile(join(distDir, found))
      return new NextResponse(content, {
        headers: {
          'Content-Type': mime,
          'Content-Disposition': `attachment; filename="${found}"`,
          'X-Platform': platform,
          'X-PeerMesh-Version': getDesktopInstallerVersion(found, ext) ?? '',
        },
      })
    }
  } catch {}

  return NextResponse.json(
    { error: `Installer not available for ${platform}`, platform },
    { status: 404 }
  )
}
