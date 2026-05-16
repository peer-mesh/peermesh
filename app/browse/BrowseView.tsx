'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { PeerRequester, type ProxyResponse, type SessionInfo } from '@/lib/peer-requester'
import { getFlagForCountry } from '@/lib/utils'

let requester: PeerRequester | null = null

const IFRAME_INCOMPATIBLE = [
  'youtube.com',
  'google.com',
  'gmail.com',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'netflix.com',
  'accounts.google.com',
]

const QUICK_LINKS = [
  'wikipedia.org',
  'bbc.com',
  'reuters.com',
  'cnn.com',
  'amazon.com',
]

function proxyAsset(url: string): string {
  if (!url) return ''
  if (url.includes('proxy-asset') || url.includes('localhost')) return url
  if (!url.startsWith('http')) return url
  return `/api/proxy-asset?url=${encodeURIComponent(url)}`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function getHostLabel(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function normalizeBrowseUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const parsed = new URL(candidate)
    if (!['http:', 'https:'].includes(parsed.protocol)) return ''
    return parsed.toString()
  } catch {
    return ''
  }
}

function isLikelyHtml(body: string, headers: Record<string, string>): boolean {
  const contentType = headers['content-type'] ?? ''
  if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) return true
  return /^\s*<(?:!doctype|html|head|body|main|div|span|p|script|style|svg|meta|link)/i.test(body)
}

function buildStatusMessage(response: ProxyResponse, targetUrl: string): string {
  const host = getHostLabel(targetUrl)
  if (response.error === 'Not connected to peer') return 'Peer connection is not active. Reconnect and try again.'
  if (response.error === 'Disconnected') return 'Peer connection closed while the page was loading.'
  switch (response.status) {
    case 403:
      return `Access to ${host} is blocked by PeerMesh safety filters.`
    case 429:
      return 'The session is sending requests too quickly. Wait a moment and retry.'
    case 502:
      return `The peer returned a bad gateway for ${host}. Retry or switch peers.`
    case 503:
      return `The peer is not ready to load ${host}. Refresh or reconnect and try again.`
    case 504:
      return `Timed out while loading ${host}. Retry or try a lighter page.`
    default:
      return response.error || `Request failed with status ${response.status}.`
  }
}

function buildIncompatibleDocument(url: string): string {
  const hostname = getHostLabel(url)
  return `<html><body style="font-family:monospace;padding:40px;background:#0a0a0f;color:#e8e8f0;line-height:1.8">
    <h2 style="color:#00ff88;margin-bottom:16px">${escapeHtml(hostname)}</h2>
    <p style="color:#666680;margin-bottom:24px">This site requires browser APIs that do not run safely inside the proxied iframe.</p>
    <p style="color:#e8e8f0;margin-bottom:8px">Use a normal browser tab if you want to continue with this site.</p>
    <p style="color:#666680;font-size:12px;margin-top:24px">Tip: news sites, docs, blogs, shopping pages, and most static pages work well here.</p>
  </body></html>`
}

function buildTextDocument(body: string, finalUrl: string, status?: number): string {
  const host = getHostLabel(finalUrl)
  return `<html><body style="margin:0;background:#0b0d12;color:#e8e8f0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">
    <div style="padding:18px 22px;border-bottom:1px solid rgba(255,255,255,0.08);background:#10141b">
      <div style="font-size:11px;color:#00ff88;letter-spacing:1px">${escapeHtml(host)}</div>
      <div style="font-size:12px;color:#7f8796;margin-top:6px">Non-HTML response${status ? ` (${status})` : ''}</div>
    </div>
    <pre style="white-space:pre-wrap;word-break:break-word;margin:0;padding:24px;font-size:13px;line-height:1.7">${escapeHtml(body || '(empty response)')}</pre>
  </body></html>`
}

function rewriteLinks(html: string, baseUrl: string, accessToken: string): string {
  try {
    const base = new URL(baseUrl)
    const origin = base.origin

    const interceptScript = `<script>
(function(){
  var ORIGIN='${origin}';
  var PROXY='/api/proxy-fetch';
  var TOKEN='${accessToken}';
  var _fetch=window.fetch.bind(window);
  function proxyFetch(url,method,headers,body){
    return _fetch(PROXY,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},body:JSON.stringify({url:url,method:method||'GET',headers:headers||{},body:body||null})})
      .then(function(r){return r.json();})
      .then(function(d){return new Response(d.body||'',{status:d.status||200,headers:d.headers||{}});});
  }
  function shouldProxy(url){
    return url&&url.startsWith('http')&&!url.includes('localhost')&&!url.includes('127.0.0.1');
  }
  function resolveUrl(url){
    if(!url||typeof url!=='string') return url;
    if(url.startsWith('http')||url.startsWith('//')||url.startsWith('data:')||url.startsWith('blob:')||url.startsWith('javascript:')) return url;
    try{ return ORIGIN+(url.startsWith('/')?url:'/'+url); }catch(e){ return url; }
  }
  window.fetch=function(input,init){
    var url=typeof input==='string'?input:(input&&input.url?input.url:String(input));
    url=resolveUrl(url);
    if(shouldProxy(url)){
      return proxyFetch(url,(init&&init.method)||'GET',(init&&init.headers)||{},(init&&init.body)||null);
    }
    return _fetch(input,init);
  };
  var _XHR=window.XMLHttpRequest;
  window.XMLHttpRequest=function(){
    var xhr=new _XHR(),_m='GET',_u,_isProxy=false;
    xhr.open=function(m,u){
      _m=m; _u=resolveUrl(u);
      _isProxy=shouldProxy(_u);
      if(_isProxy){ _XHR.prototype.open.call(xhr,'POST',PROXY); }
      else { _XHR.prototype.open.call(xhr,m,u); }
    };
    xhr.send=function(body){
      if(_isProxy){
        _XHR.prototype.setRequestHeader.call(xhr,'Content-Type','application/json');
        if(TOKEN) _XHR.prototype.setRequestHeader.call(xhr,'Authorization','Bearer '+TOKEN);
        _XHR.prototype.send.call(xhr,JSON.stringify({url:_u,method:_m,headers:{},body:body||null}));
      } else { _XHR.prototype.send.call(xhr,body); }
    };
    return xhr;
  };
  try{history.pushState=history.replaceState=function(){};}catch(e){}
  document.addEventListener('click',function(e){
    var el=e.target.closest('[data-proxy]');
    if(el){e.preventDefault();e.stopPropagation();window.parent.postMessage({type:'proxy-navigate',url:el.dataset.proxy},'*');}
  },true);
})();
</script>`

    const withIntercept = html.includes('<head')
      ? html.replace(/(<head[^>]*>)/i, `$1${interceptScript}`)
      : html.includes('<html')
        ? html.replace(/(<html[^>]*>)/i, `$1${interceptScript}`)
        : interceptScript + html

    return withIntercept
      .replace(/<link[^>]+rel=["'](preload|prefetch|preconnect|dns-prefetch)["'][^>]*>/gi, '')
      .replace(/(<link[^>]+href=")(https?:\/\/[^"]+)(")/gi, (_, pre, url, post) => `${pre}${proxyAsset(url)}${post}`)
      .replace(/(<link[^>]+href=")(\/(?!api\/)[^"]+)(")/gi, (_, pre, path, post) => {
        try { return `${pre}${proxyAsset(new URL(path, base).href)}${post}` } catch { return `${pre}${path}${post}` }
      })
      .replace(/(<a[^>]+)href="(https?:\/\/[^"]+)"/gi, (_, pre, url) => `${pre}href="#" data-proxy="${url}"`)
      .replace(/(<a[^>]+)href="(\/(?!api\/)[^"]+)"/gi, (_, pre, path) => {
        try { return `${pre}href="#" data-proxy="${new URL(path, base).href}"` } catch { return `${pre}href="#"` }
      })
      .replace(/src="(https?:\/\/[^"]+)"/g, (_, url) => `src="${proxyAsset(url.replace(/&amp;/g, '&'))}"`)
      .replace(/src="(\/(?!api\/)[^"]+)"/g, (_, path) => {
        try { return `src="${proxyAsset(new URL(path.replace(/&amp;/g, '&'), base).href)}"` } catch { return 'src=""' }
      })
      .replace(/src="((?!https?:|data:|blob:|\/)([^"]+))"/g, (_, path) => {
        try { return `src="${proxyAsset(new URL(path.replace(/&amp;/g, '&'), base).href)}"` } catch { return 'src=""' }
      })
      .replace(/src="((?!https?:|data:|blob:|\/)([^"]+\.(png|jpg|jpeg|gif|webp|svg|ico)))"/gi, (_, path) => {
        try { return `src="${proxyAsset(new URL(path.replace(/&amp;/g, '&'), base).href)}"` } catch { return 'src=""' }
      })
      .replace(/<script[^>]+type=["']module["'][^>]*src=["'][^"']*\/api\/[^"']*["'][^>]*><\/script>/gi, '')
  } catch {
    return html
  }
}

function responseToDocument(response: ProxyResponse, finalUrl: string, accessToken: string): string {
  if (!response.body) return buildTextDocument('', finalUrl, response.status)
  if (isLikelyHtml(response.body, response.headers)) {
    return rewriteLinks(response.body, finalUrl, accessToken)
  }
  return buildTextDocument(response.body, finalUrl, response.status)
}

export default function BrowseView() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const relayEndpoint = searchParams.get('relay') ?? ''
  const relayFallbackParam = searchParams.get('relayFallback') ?? relayEndpoint
  const country = searchParams.get('country') ?? ''
  const userId = searchParams.get('userId') ?? ''
  const dbSessionId = searchParams.get('dbSessionId') ?? ''
  const preferredProviderUserId = searchParams.get('preferredProviderUserId') || null
  const privateProviderUserId = searchParams.get('privateProviderUserId') || null
  const privateBaseDeviceId = searchParams.get('privateBaseDeviceId') || null
  const connectionType = searchParams.get('connectionType') ?? 'public'

  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'disconnected'>('connecting')
  const [pageState, setPageState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [inputUrl, setInputUrl] = useState('')
  const [currentUrl, setCurrentUrl] = useState('')
  const [content, setContent] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [reconnectNotice, setReconnectNotice] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState('')
  const [bytesUsed, setBytesUsed] = useState(0)
  const [lastRequestedUrl, setLastRequestedUrl] = useState('')
  const [lastLoadedUrl, setLastLoadedUrl] = useState('')
  const [loadingLabel, setLoadingLabel] = useState('Preparing secure route...')
  const accessTokenRef = useRef('')
  const bytesUsedRef = useRef(0)
  const contentRef = useRef('')

  useEffect(() => {
    contentRef.current = content
  }, [content])

  useEffect(() => {
    accessTokenRef.current = accessToken
  }, [accessToken])

  useEffect(() => {
    if (!reconnectNotice) return undefined
    const timer = window.setTimeout(() => setReconnectNotice(null), 3500)
    return () => window.clearTimeout(timer)
  }, [reconnectNotice])

  useEffect(() => {
    if (!relayEndpoint) {
      router.push('/dashboard')
      return
    }

    let cancelled = false
    const relayFallbackList = relayFallbackParam.split(',').filter(Boolean)

    const start = async () => {
      try {
        const tokenResponse = await fetch('/api/agent-token')
        const tokenData = await tokenResponse.json().catch(() => ({}))
        if (!tokenResponse.ok || !tokenData.token) {
          throw new Error(tokenData.error ?? 'Could not verify your session')
        }
        if (cancelled) return

        accessTokenRef.current = tokenData.token
        setAccessToken(tokenData.token)

        requester = new PeerRequester()
        await requester.connect(
          relayEndpoint,
          dbSessionId,
          country,
          userId,
          tokenData.token,
          (reason) => {
            setConnectionState('disconnected')
            if (contentRef.current) {
              setNotice(reason ?? 'Peer disconnected. Refresh or retry to continue.')
              setPageState('ready')
            } else {
              setPageState('error')
              setErrorMsg(reason ?? 'Peer disconnected unexpectedly')
            }
          },
          preferredProviderUserId,
          privateProviderUserId,
          privateBaseDeviceId,
          relayFallbackList,
          (_sessionInfo: SessionInfo, attempt?: number) => {
            setConnectionState('connected')
            setReconnectNotice(attempt ? `Peer switched and recovered (attempt ${attempt}).` : 'Peer switched and recovered.')
            setNotice(null)
          }
        )
        if (cancelled) return
        setConnectionState('connected')
        setPageState('idle')
      } catch (error) {
        if (cancelled) return
        setConnectionState('disconnected')
        setPageState('error')
        setErrorMsg(error instanceof Error ? error.message : 'Could not connect')
      }
    }

    void start()

    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'proxy-navigate') {
        void navigate(event.data.url)
      }
    }
    window.addEventListener('message', onMessage)

    return () => {
      cancelled = true
      window.removeEventListener('message', onMessage)
      if (requester) void doEndSession()
    }
  // This effect intentionally binds a single relay session lifecycle to the launch params.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country, dbSessionId, preferredProviderUserId, privateBaseDeviceId, privateProviderUserId, relayEndpoint, relayFallbackParam, router, userId])

  async function doEndSession() {
    if (!requester) return
    const activeRequester = requester
    requester = null
    activeRequester.disconnect()
    if (dbSessionId) {
      await fetch('/api/session/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: dbSessionId, disconnectReason: 'completed' }),
      }).catch(() => {})
    }
  }

  const ensureAccessToken = useCallback(async () => {
    if (accessTokenRef.current) return accessTokenRef.current
    try {
      const response = await fetch('/api/agent-token')
      const data = await response.json()
      const token = data.token ?? ''
      accessTokenRef.current = token
      setAccessToken(token)
      return token
    } catch {
      return ''
    }
  }, [])

  const navigate = useCallback(async (target: string) => {
    const normalizedUrl = normalizeBrowseUrl(target)
    if (!normalizedUrl) {
      const invalidMessage = 'Enter a valid http:// or https:// URL.'
      if (contentRef.current) {
        setNotice(invalidMessage)
      } else {
        setPageState('error')
        setErrorMsg(invalidMessage)
      }
      return
    }

    if (!requester?.isConnected) {
      const disconnectedMessage = 'Peer connection is not active. Return to the dashboard and reconnect.'
      if (contentRef.current) {
        setNotice(disconnectedMessage)
      } else {
        setPageState('error')
        setErrorMsg(disconnectedMessage)
      }
      return
    }

    setLastRequestedUrl(normalizedUrl)
    setInputUrl(normalizedUrl)
    setErrorMsg('')
    setNotice(null)
    setLoadingLabel(`Loading ${getHostLabel(normalizedUrl)}...`)
    setPageState('loading')

    try {
      const hostname = getHostLabel(normalizedUrl).replace(/^www\./, '')
      if (IFRAME_INCOMPATIBLE.some(domain => hostname.endsWith(domain))) {
        setCurrentUrl(normalizedUrl)
        setLastLoadedUrl(normalizedUrl)
        setContent(buildIncompatibleDocument(normalizedUrl))
        setPageState('ready')
        return
      }

      const response = await requester.fetch(normalizedUrl)
      if (response.error && !response.body) {
        throw new Error(buildStatusMessage(response, normalizedUrl))
      }

      const actualUrl = response.finalUrl || normalizedUrl
      const token = await ensureAccessToken()
      const rendered = responseToDocument(response, actualUrl, token)
      setCurrentUrl(actualUrl)
      setLastLoadedUrl(actualUrl)
      setContent(rendered)
      setPageState('ready')
      setNotice(response.status >= 400 ? buildStatusMessage(response, actualUrl) : null)
      setBytesUsed(previous => previous + response.body.length)
      bytesUsedRef.current += response.body.length
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to load page'
      if (contentRef.current) {
        setPageState('ready')
        setNotice(message)
      } else {
        setPageState('error')
        setErrorMsg(message)
      }
    }
  }, [ensureAccessToken])

  const handleRefresh = useCallback(async () => {
    const target = currentUrl || lastLoadedUrl || inputUrl
    if (!target) return
    await navigate(target)
  }, [currentUrl, inputUrl, lastLoadedUrl, navigate])

  const handleRetry = useCallback(async () => {
    const target = lastRequestedUrl || currentUrl || inputUrl
    if (!target) return
    await navigate(target)
  }, [currentUrl, inputUrl, lastRequestedUrl, navigate])

  async function handleDisconnect() {
    await doEndSession()
    router.push('/dashboard')
  }

  const flag = getFlagForCountry(country)
  const hasContent = content.length > 0
  const isBusy = connectionState === 'connecting' || pageState === 'loading'
  const currentHost = currentUrl ? getHostLabel(currentUrl) : 'No page loaded'
  const canRetry = !!(lastRequestedUrl || currentUrl || inputUrl)
  const canRefresh = !!(lastLoadedUrl || currentUrl)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg)' }}>
      <div style={{ background: 'linear-gradient(180deg, rgba(16,18,26,0.98), rgba(14,16,22,0.94))', borderBottom: '1px solid var(--border)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px', position: 'sticky', top: 0, zIndex: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <button
            onClick={handleDisconnect}
            style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', padding: '8px 10px', borderRadius: '8px', fontSize: '11px', cursor: 'pointer', fontFamily: 'var(--font-geist-mono)', whiteSpace: 'nowrap' }}
          >
            EXIT
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 10px', background: 'rgba(0,255,136,0.08)', border: '1px solid rgba(0,255,136,0.2)', borderRadius: '8px', whiteSpace: 'nowrap' }}>
            <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: connectionState === 'connected' ? 'var(--accent)' : connectionState === 'connecting' ? '#ffaa00' : '#ff6060', boxShadow: connectionState === 'connected' ? '0 0 8px rgba(0,255,136,0.45)' : 'none' }} />
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: connectionState === 'disconnected' ? '#ff6060' : 'var(--accent)', letterSpacing: '0.5px' }}>
              {connectionState === 'connecting' ? `CONNECTING ${flag} ${country}` : connectionState === 'connected' ? `${flag} ${country} PEER READY` : `${flag} ${country} PEER OFFLINE`}
            </span>
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '9px', color: connectionType === 'private' ? 'var(--accent)' : 'var(--muted)', background: 'rgba(0,0,0,0.28)', padding: '2px 6px', borderRadius: '4px', letterSpacing: '0.5px' }}>
              {connectionType === 'private' ? 'PRIVATE' : 'PUBLIC'}
            </span>
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <button
              onClick={() => void handleRefresh()}
              disabled={!canRefresh || isBusy}
              style={{ padding: '8px 10px', background: 'transparent', border: '1px solid var(--border)', color: !canRefresh || isBusy ? 'var(--muted)' : 'var(--text)', borderRadius: '8px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: !canRefresh || isBusy ? 'not-allowed' : 'pointer' }}
            >
              REFRESH
            </button>
            <button
              onClick={() => void handleRetry()}
              disabled={!canRetry || isBusy}
              style={{ padding: '8px 10px', background: 'transparent', border: '1px solid var(--border)', color: !canRetry || isBusy ? 'var(--muted)' : 'var(--text)', borderRadius: '8px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: !canRetry || isBusy ? 'not-allowed' : 'pointer' }}
            >
              RETRY
            </button>
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', whiteSpace: 'nowrap' }}>
              {(bytesUsed / 1024).toFixed(1)}KB
            </span>
          </div>
        </div>

        <form onSubmit={(event) => { event.preventDefault(); void navigate(inputUrl) }} style={{ display: 'flex', gap: '8px' }}>
          <input
            value={inputUrl}
            onChange={event => setInputUrl(event.target.value)}
            placeholder="Enter a URL or domain..."
            disabled={connectionState === 'connecting'}
            style={{ flex: 1, padding: '10px 12px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '10px', color: 'var(--text)', fontSize: '13px', outline: 'none', fontFamily: 'var(--font-geist-mono)' }}
          />
          <button
            type="submit"
            disabled={connectionState === 'connecting' || !inputUrl.trim()}
            style={{ minWidth: '108px', padding: '10px 16px', background: connectionState === 'connecting' || !inputUrl.trim() ? 'var(--border)' : 'var(--accent)', color: connectionState === 'connecting' || !inputUrl.trim() ? 'var(--muted)' : '#000', border: 'none', borderRadius: '10px', fontFamily: 'var(--font-geist-mono)', fontSize: '11px', fontWeight: 700, cursor: connectionState === 'connecting' || !inputUrl.trim() ? 'not-allowed' : 'pointer', letterSpacing: '0.5px' }}
          >
            {pageState === 'loading' ? 'LOADING...' : 'OPEN'}
          </button>
        </form>

        {(notice || reconnectNotice) && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', background: reconnectNotice ? 'rgba(0,255,136,0.08)' : 'rgba(255,170,0,0.08)', border: `1px solid ${reconnectNotice ? 'rgba(0,255,136,0.2)' : 'rgba(255,170,0,0.25)'}`, borderRadius: '10px', padding: '10px 12px' }}>
            <span style={{ fontSize: '11px', color: reconnectNotice ? 'var(--accent)' : '#ffaa00', lineHeight: 1.6 }}>
              {reconnectNotice || notice}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {notice && canRetry && (
                <button
                  onClick={() => void handleRetry()}
                  style={{ padding: '6px 10px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '7px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: 'pointer' }}
                >
                  RETRY
                </button>
              )}
              <button
                onClick={() => { setNotice(null); setReconnectNotice(null) }}
                style={{ padding: '6px 10px', background: 'transparent', border: '1px solid transparent', color: 'var(--muted)', borderRadius: '7px', fontFamily: 'var(--font-geist-mono)', fontSize: '10px', cursor: 'pointer' }}
              >
                DISMISS
              </button>
            </div>
          </div>
        )}
      </div>

      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', minHeight: 0 }}>
        {pageState === 'loading' && hasContent && (
          <div style={{ position: 'absolute', inset: '18px 18px auto 18px', zIndex: 12, display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', background: 'rgba(8,10,14,0.88)', border: '1px solid rgba(0,255,136,0.18)', borderRadius: '10px', backdropFilter: 'blur(12px)' }}>
            <span style={{ width: '12px', height: '12px', border: '2px solid rgba(255,255,255,0.15)', borderTopColor: 'var(--accent)', borderRadius: '50%', display: 'inline-block', animation: 'spin 0.7s linear infinite' }} />
            <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: 'var(--muted)', letterSpacing: '0.5px' }}>{loadingLabel}</span>
          </div>
        )}

        {connectionState === 'connecting' && !hasContent && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px' }}>
            <div style={{ width: '36px', height: '36px', border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--muted)', letterSpacing: '1px' }}>CONNECTING TO {flag} {country}...</div>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}

        {connectionState === 'connected' && pageState === 'loading' && !hasContent && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px' }}>
            <div style={{ width: '36px', height: '36px', border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--muted)', letterSpacing: '1px' }}>{loadingLabel}</div>
          </div>
        )}

        {connectionState === 'connected' && !hasContent && pageState === 'idle' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '28px' }}>
            <div style={{ width: '100%', maxWidth: '760px', display: 'grid', gap: '16px' }}>
              <div style={{ padding: '24px', background: 'linear-gradient(180deg, rgba(0,255,136,0.07), rgba(255,255,255,0.02))', border: '1px solid rgba(0,255,136,0.15)', borderRadius: '18px' }}>
                <div style={{ fontSize: '40px', marginBottom: '10px' }}>{flag}</div>
                <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '12px', color: 'var(--accent)', letterSpacing: '1px', marginBottom: '10px' }}>
                  CONNECTED TO {country} · {connectionType === 'private' ? 'PRIVATE LINK' : 'PUBLIC POOL'}
                </div>
                <div style={{ fontSize: '14px', color: 'var(--muted)', lineHeight: 1.7, maxWidth: '620px' }}>
                  Search for a site above or start with one of the quick links below. PeerMesh will keep the page visible during reloads and let you retry transient failures without dropping the session.
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
                {QUICK_LINKS.map(site => (
                  <button
                    key={site}
                    onClick={() => void navigate(site)}
                    style={{ textAlign: 'left', padding: '14px 16px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '14px', color: 'var(--text)', cursor: 'pointer' }}
                  >
                    <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)', marginBottom: '6px', letterSpacing: '0.5px' }}>QUICK OPEN</div>
                    <div style={{ fontSize: '14px', color: 'var(--accent)' }}>{site}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {pageState === 'error' && !hasContent && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '28px' }}>
            <div style={{ width: '100%', maxWidth: '520px', background: 'var(--surface)', border: '1px solid rgba(255,96,96,0.25)', borderRadius: '18px', padding: '24px', display: 'grid', gap: '14px' }}>
              <div style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '11px', color: '#ff6060', letterSpacing: '1px' }}>BROWSE ERROR</div>
              <div style={{ fontSize: '15px', color: 'var(--text)', lineHeight: 1.7 }}>{errorMsg || 'This page could not be loaded.'}</div>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <button
                  onClick={() => void handleRetry()}
                  disabled={!canRetry}
                  style={{ padding: '10px 14px', background: canRetry ? 'var(--accent)' : 'var(--border)', color: canRetry ? '#000' : 'var(--muted)', border: 'none', borderRadius: '10px', fontFamily: 'var(--font-geist-mono)', fontSize: '11px', fontWeight: 700, cursor: canRetry ? 'pointer' : 'not-allowed' }}
                >
                  RETRY
                </button>
                <button
                  onClick={handleDisconnect}
                  style={{ padding: '10px 14px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '10px', fontFamily: 'var(--font-geist-mono)', fontSize: '11px', cursor: 'pointer' }}
                >
                  BACK TO DASHBOARD
                </button>
              </div>
            </div>
          </div>
        )}

        {content && (
          <iframe
            srcDoc={content}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
            title={`Browsing via ${country} peer`}
          />
        )}
      </div>

      <div style={{ background: 'var(--surface)', borderTop: '1px solid var(--border)', padding: '8px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)' }}>
          {pageState === 'loading' ? loadingLabel : currentHost}
        </span>
        <span style={{ fontFamily: 'var(--font-geist-mono)', fontSize: '10px', color: 'var(--muted)' }}>
          {dbSessionId ? `${dbSessionId.slice(0, 8)}...` : 'session pending'}
        </span>
      </div>
    </div>
  )
}
