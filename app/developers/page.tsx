import Link from 'next/link'
import { SignedInDeveloperCards } from './PublicDevLinks'

const BASE = 'https://peermesh-beta.vercel.app'

const cards = [
  {
    href: '/developers/api-docs',
    label: 'API Reference',
    desc: 'Full endpoint reference with live curl, Node, and Python examples. Bearer key auth only.',
    tag: 'DOCS',
  },
  {
    href: '/install',
    label: 'Install PeerMesh',
    desc: 'Install the CLI, desktop app, or extension and review demo screenshots and video slots.',
    tag: 'INSTALL',
  },
]

export default function DevelopersOverviewPage() {
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '40px 48px', maxWidth: '860px' }}>
      <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--accent)', letterSpacing: '3px', marginBottom: '12px' }}>
        PEERMESH DEVELOPERS
      </div>
      <h1 style={{ margin: '0 0 12px', fontSize: '32px', fontWeight: 700, lineHeight: 1.15 }}>
        Developer Platform
      </h1>
      <p style={{ margin: '0 0 32px', fontSize: '15px', color: 'var(--muted)', lineHeight: 1.8, maxWidth: '600px' }}>
        Plug residential routing into your backend, worker fleet, or browser automation.
        All API calls authenticate with a Bearer API key.
      </p>

      {/* Base URL */}
      <div style={{ marginBottom: '36px', padding: '16px 20px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px' }}>
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', letterSpacing: '2px', marginBottom: '8px' }}>BASE URL</div>
        <code style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '14px', color: 'var(--accent)' }}>
          {BASE}/v1/&#123;path&#125;
        </code>
        <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--muted)' }}>
          All v1 endpoints accept <code style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px' }}>Authorization: Bearer &lt;api-key&gt;</code>
        </div>
      </div>

      {/* Quick nav cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px', marginBottom: '40px' }}>
        {cards.map(card => (
          <Link key={card.href} href={card.href} style={{ textDecoration: 'none' }}>
            <div style={{
              padding: '20px',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              cursor: 'pointer',
              transition: 'border-color 0.15s',
            }}>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '2px', marginBottom: '8px' }}>
                {card.tag}
              </div>
              <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '8px', color: 'var(--text)' }}>{card.label}</div>
              <div style={{ fontSize: '13px', color: 'var(--muted)', lineHeight: 1.7 }}>{card.desc}</div>
            </div>
          </Link>
        ))}
        <SignedInDeveloperCards />
      </div>

      {/* Auth note */}
      <div style={{ padding: '20px', background: 'rgba(0,255,136,0.04)', border: '1px solid rgba(0,255,136,0.15)', borderRadius: '12px' }}>
        <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--accent)', letterSpacing: '2px', marginBottom: '10px' }}>AUTH MODEL</div>
        <div style={{ fontSize: '13px', color: 'var(--muted)', lineHeight: 1.8 }}>
          Developer API calls use <strong style={{ color: 'var(--text)' }}>Bearer API keys</strong> only.
          Public docs do not require login. Sign in before creating API keys, funding a wallet, or inspecting provider traffic.
        </div>
        <div style={{ marginTop: '12px', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--muted)', background: 'var(--bg)', padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--border)' }}>
          Authorization: Bearer pm_live_xxxxxxxxxxxxxxxxxxxx
        </div>
      </div>
    </div>
  )
}
