import type { CSSProperties, ReactNode } from 'react'

export const developerCardStyle: CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: '12px',
  padding: '20px',
}

export const developerMonospaceLabelStyle: CSSProperties = {
  fontFamily: 'var(--font-geist-mono)',
  fontSize: '10px',
  color: 'var(--accent)',
  letterSpacing: '2px',
}

export function CodeBlock({ code }: { code: string }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: '14px',
        background: 'var(--bg)',
        border: '1px solid rgba(255,255,255,0.05)',
        borderRadius: '10px',
        overflowX: 'auto',
        fontSize: '12px',
        lineHeight: 1.65,
        fontFamily: 'var(--font-geist-mono)',
      }}
    >
      <code>{code}</code>
    </pre>
  )
}
