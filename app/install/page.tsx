import Link from 'next/link'
import Image from 'next/image'
import { AuthAwareLinks } from '../AuthAwareLinks'

const cliSteps = [
  ['Install Node.js 18+', 'Use the current LTS installer from nodejs.org, Homebrew, apt, or your platform package manager.'],
  ['Install the provider', 'npm install -g @btcmaster1000/peermesh-provider'],
  ['Start sharing', 'peermesh-provider'],
  ['Check sync', 'peermesh-provider --status'],
]

const desktopSteps = [
  ['Download the installer', 'Use the Windows desktop installer from PeerMesh.'],
  ['Sign in', 'Open the app, sign in, and approve the local helper session.'],
  ['Set slots and limits', 'Use the dashboard or desktop controls. Changes sync across the app, CLI, and extension.'],
  ['Keep it updated', 'The dashboard shows a desktop update banner only when the published version is newer than your app.'],
]

const extensionSteps = [
  ['Open the extension page', 'Install the unpacked extension or download the packaged extension from PeerMesh.'],
  ['Pin it', 'Pin PeerMesh in Chrome so connection state is visible.'],
  ['Connect', 'Choose a country for public routing or enter a private code for a trusted host.'],
  ['Use helper mode', 'Run the desktop app or CLI for multi-slot sharing and tunnel support.'],
]

function StepList({ steps }: { steps: string[][] }) {
  return (
    <ol style={{ display: 'grid', gap: '10px', margin: 0, padding: 0, listStyle: 'none' }}>
      {steps.map(([title, body], index) => (
        <li key={title} style={{ display: 'grid', gridTemplateColumns: '28px 1fr', gap: '10px', alignItems: 'start' }}>
          <span style={{ display: 'grid', placeItems: 'center', width: '28px', height: '28px', borderRadius: '999px', background: 'var(--accent-dim)', color: 'var(--accent)', fontFamily: 'var(--font-geist-mono)', fontSize: '11px', fontWeight: 700 }}>
            {index + 1}
          </span>
          <span>
            <strong style={{ display: 'block', fontSize: '13px', marginBottom: '3px' }}>{title}</strong>
            <span style={{ display: 'block', color: 'var(--muted)', fontSize: '12px', lineHeight: 1.6 }}>{body}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}

function MediaCard({ title, label, src, kind }: { title: string; label: string; src: string; kind: 'video' | 'screenshot' }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden', background: 'var(--surface)' }}>
      {kind === 'video' ? (
        <iframe
          title={title}
          src={src}
          style={{ width: '100%', aspectRatio: '16 / 9', border: 0, display: 'block', borderBottom: '1px solid var(--border)' }}
        />
      ) : (
        <Image
          src={src}
          alt={title}
          width={1280}
          height={720}
          style={{ width: '100%', height: 'auto', display: 'block', borderBottom: '1px solid var(--border)' }}
        />
      )}
      <div style={{ padding: '12px 14px' }}>
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '0.5px', marginBottom: '5px' }}>{label}</div>
        <div style={{ fontSize: '13px', fontWeight: 600 }}>{title}</div>
      </div>
    </div>
  )
}

export default function InstallPage() {
  return (
    <main style={{ width: '100%', maxWidth: '1040px', margin: '0 auto', padding: '40px 20px 72px' }}>
      <nav style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', marginBottom: '44px' }}>
        <Link href="/" style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--accent)', textDecoration: 'none', fontSize: '13px', letterSpacing: '3px' }}>PEERMESH</Link>
        <AuthAwareLinks
          includeTraffic={false}
          style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', fontFamily: 'var(--font-geist-mono)', fontSize: '11px' }}
          linkStyle={{ color: 'var(--muted)', textDecoration: 'none' }}
        />
      </nav>

      <section style={{ marginBottom: '36px' }}>
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', letterSpacing: '2px', marginBottom: '10px' }}>INSTALL PEERMESH</div>
        <h1 style={{ margin: '0 0 14px', fontSize: '42px', lineHeight: 1.05, maxWidth: '760px' }}>Choose the surface that matches how you work.</h1>
        <p style={{ margin: 0, color: 'var(--muted)', lineHeight: 1.8, maxWidth: '700px' }}>
          Use the CLI for servers and automation, the desktop app for a local provider helper, and the browser extension for quick country or private-code connections.
        </p>
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px', marginBottom: '42px' }}>
        {[
          ['CLI', 'Servers, terminals, background sharing', cliSteps, 'npm install -g @btcmaster1000/peermesh-provider'],
          ['Desktop', 'Windows helper with dashboard control', desktopSteps, '/api/desktop-download'],
          ['Extension', 'Browser-based public and private connects', extensionSteps, '/extension/install'],
        ].map(([title, subtitle, steps, action]) => (
          <article key={String(title)} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', padding: '18px' }}>
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px', marginBottom: '7px' }}>{title}</div>
            <h2 style={{ margin: '0 0 14px', fontSize: '18px' }}>{subtitle}</h2>
            <StepList steps={steps as string[][]} />
            <div style={{ marginTop: '16px', padding: '10px 12px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '7px', fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', wordBreak: 'break-word' }}>{action}</div>
          </article>
        ))}
      </section>

      <section style={{ display: 'grid', gap: '16px', marginBottom: '42px' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px', marginBottom: '8px' }}>DEMO VIDEOS</div>
          <h2 style={{ margin: 0, fontSize: '22px' }}>Short walkthroughs to record and publish</h2>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '14px' }}>
          <MediaCard kind="video" src="/demo/cli-demo.html" label="VIDEO" title="CLI install, sign-in, status, and private slot setup" />
          <MediaCard kind="video" src="/demo/desktop-demo.html" label="VIDEO" title="Desktop install, slot count, daily limit, and update flow" />
          <MediaCard kind="video" src="/demo/extension-demo.html" label="VIDEO" title="Extension country routing and private-code connection" />
        </div>
      </section>

      <section style={{ display: 'grid', gap: '16px' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '1px', marginBottom: '8px' }}>SCREENSHOTS</div>
          <h2 style={{ margin: 0, fontSize: '22px' }}>What users should see after setup</h2>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '14px' }}>
          <MediaCard kind="screenshot" src="/demo/dashboard-screenshot.svg" label="SCREENSHOT" title="Dashboard showing helper status, slots, and private/public counts" />
          <MediaCard kind="screenshot" src="/demo/provider-sessions-screenshot.svg" label="SCREENSHOT" title="Provider sessions with searchable routed host history" />
          <MediaCard kind="screenshot" src="/demo/developer-docs-screenshot.svg" label="SCREENSHOT" title="Developer API reference and version endpoint" />
        </div>
      </section>
    </main>
  )
}
