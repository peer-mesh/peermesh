import Link from 'next/link'
import { AuthAwareLinks } from './AuthAwareLinks'

const offers = [
  ['Browse through peers', 'Connect from supported countries through verified provider devices instead of a generic datacenter pool.'],
  ['Earn by sharing', 'Run the desktop app or CLI to share spare bandwidth, serve sessions, and earn browsing credits.'],
  ['Private-code routing', 'Expose selected slots only to trusted users. Code holders can connect directly without using the public pool.'],
  ['Developer API', 'Use bearer-key endpoints for routing quotes, sessions, billing, and provider workflows.'],
]

const surfaces = [
  ['CLI', 'Headless provider for servers, terminals, CI boxes, and always-on machines.'],
  ['Desktop', 'Local helper for Windows users who want dashboard-controlled sharing.'],
  ['Extension', 'Browser entry point for country routing and private-code sessions.'],
]

export default function LandingPage() {
  return (
    <main style={{ width: '100%', overflowX: 'hidden' }}>
      <section style={{ minHeight: '92vh', display: 'grid', alignItems: 'center', padding: '24px 20px 56px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ width: '100%', maxWidth: '1120px', margin: '0 auto' }}>
          <nav style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', marginBottom: '64px' }}>
            <div style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--accent)', fontSize: '13px', letterSpacing: '4px' }}>PEERMESH</div>
            <AuthAwareLinks
              style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center', fontFamily: 'var(--font-geist-mono)', fontSize: '11px' }}
              linkStyle={{ color: 'var(--muted)', textDecoration: 'none' }}
            />
          </nav>

          <div style={{ maxWidth: '760px' }}>
            <div style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--accent)', fontSize: '11px', letterSpacing: '2px', marginBottom: '14px' }}>PUBLIC ROUTING, PRIVATE SLOTS, DEVELOPER ACCESS</div>
            <h1 style={{ margin: '0 0 18px', fontSize: '56px', lineHeight: 1.02, fontWeight: 800 }}>
              PeerMesh turns real user connections into a usable network.
            </h1>
            <p style={{ margin: '0 0 28px', color: 'var(--muted)', fontSize: '17px', lineHeight: 1.8, maxWidth: '680px' }}>
              Browse through verified peers, share your own connection for credits, route trusted users through private codes, and inspect provider traffic from one dashboard.
            </p>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <Link href="/auth?mode=signup" style={{ padding: '13px 22px', background: 'var(--accent)', color: '#000', borderRadius: '8px', fontFamily: 'var(--font-geist-mono)', fontWeight: 700, fontSize: '12px', textDecoration: 'none' }}>GET STARTED</Link>
              <Link href="/install" style={{ padding: '13px 22px', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '8px', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', textDecoration: 'none' }}>INSTALL GUIDE</Link>
              <Link href="/developers/api-docs" style={{ padding: '13px 22px', background: 'transparent', color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: '8px', fontFamily: 'var(--font-geist-mono)', fontSize: '12px', textDecoration: 'none' }}>API DOCS</Link>
            </div>
          </div>

          <div style={{ marginTop: '56px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px' }}>
            {['Verified providers', 'Multi-slot sharing', 'Daily limits', 'Traffic inspection'].map(item => (
              <div key={item} style={{ padding: '12px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '12px', color: 'var(--muted)' }}>
                <span style={{ color: 'var(--accent)', fontFamily: 'var(--font-geist-mono)', fontSize: '10px' }}>OK</span> {item}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section style={{ maxWidth: '1120px', margin: '0 auto', padding: '56px 20px', display: 'grid', gap: '18px' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--accent)', fontSize: '10px', letterSpacing: '2px', marginBottom: '8px' }}>WHAT PEERMESH OFFERS</div>
          <h2 style={{ margin: 0, fontSize: '28px' }}>A network for users, hosts, and developers.</h2>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '14px' }}>
          {offers.map(([title, body]) => (
            <article key={title} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', padding: '18px' }}>
              <h3 style={{ margin: '0 0 8px', fontSize: '16px' }}>{title}</h3>
              <p style={{ margin: 0, color: 'var(--muted)', fontSize: '13px', lineHeight: 1.7 }}>{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section style={{ borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
        <div style={{ maxWidth: '1120px', margin: '0 auto', padding: '48px 20px', display: 'grid', gridTemplateColumns: 'minmax(0, 0.9fr) minmax(0, 1.1fr)', gap: '24px', alignItems: 'start' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--accent)', fontSize: '10px', letterSpacing: '2px', marginBottom: '8px' }}>SURFACES</div>
            <h2 style={{ margin: '0 0 12px', fontSize: '26px' }}>Use PeerMesh from the place that fits the job.</h2>
            <p style={{ margin: 0, color: 'var(--muted)', lineHeight: 1.8 }}>The dashboard, desktop helper, CLI, and extension share state for slots, private sharing, limits, and current helper status.</p>
          </div>
          <div style={{ display: 'grid', gap: '10px' }}>
            {surfaces.map(([title, body]) => (
              <div key={title} style={{ display: 'grid', gridTemplateColumns: '88px 1fr', gap: '12px', padding: '14px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '8px' }}>
                <div style={{ fontFamily: 'var(--font-geist-mono)', color: 'var(--accent)', fontSize: '11px' }}>{title}</div>
                <div style={{ color: 'var(--muted)', fontSize: '13px', lineHeight: 1.6 }}>{body}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section style={{ maxWidth: '1120px', margin: '0 auto', padding: '56px 20px', display: 'grid', gap: '16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '14px' }}>
          {[
            ['For requesters', 'Pick a country, enter a private code, or use browser mode when a lightweight session is enough.'],
            ['For providers', 'Inspect sessions, search routed hosts, set bandwidth limits, and report suspicious requester behavior.'],
            ['For developers', 'Use the public docs without signing in; authenticate only when creating keys or managing billing.'],
          ].map(([title, body]) => (
            <div key={title} style={{ padding: '18px', border: '1px solid var(--border)', borderRadius: '8px' }}>
              <h3 style={{ margin: '0 0 8px', fontSize: '16px' }}>{title}</h3>
              <p style={{ margin: 0, color: 'var(--muted)', lineHeight: 1.7, fontSize: '13px' }}>{body}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  )
}
