export type ProxyResponse = {
  requestId: string
  status: number
  headers: Record<string, string>
  body: string
  error?: string
  finalUrl?: string
}

export type SessionInfo = {
  sessionId: string
  country: string
  relayEndpoint: string
  mandate?: unknown
  transportTier?: number
  providerDirectEndpoint?: string | null
}

type PendingRequest = {
  resolve: (response: ProxyResponse) => void
  timer: ReturnType<typeof setTimeout>
}

export class PeerRequester {
  private ws: WebSocket | null = null
  private pending = new Map<string, PendingRequest>()
  private onDisconnect?: (reason?: string) => void
  private onReconnect?: (sessionInfo: SessionInfo, attempt?: number) => void
  private agentSessionId = ''
  sessionInfo: SessionInfo | null = null

  async connect(
    relayEndpoint: string,
    dbSessionId: string,
    country: string,
    userId: string,
    authToken: string,
    onDisconnect?: (reason?: string) => void,
    preferredProviderUserId?: string | null,
    privateProviderUserId?: string | null,
    privateBaseDeviceId?: string | null,
    relayFallbackList?: string[],
    onReconnect?: (sessionInfo: SessionInfo, attempt?: number) => void
  ): Promise<void> {
    this.onDisconnect = onDisconnect
    this.onReconnect = onReconnect
    this.agentSessionId = ''
    this.sessionInfo = null
    const fallbackList = (relayFallbackList && relayFallbackList.length > 0)
      ? relayFallbackList
      : [relayEndpoint]

    return new Promise((resolve, reject) => {
      let attemptIndex = 0
      let retries = 0
      const MAX_RETRIES = 3
      let settled = false
      let disconnected = false
      let connectTimer: ReturnType<typeof setTimeout> | null = null

      const clearConnectTimer = () => {
        if (!connectTimer) return
        clearTimeout(connectTimer)
        connectTimer = null
      }

      const resolveOnce = () => {
        if (settled) return
        settled = true
        clearConnectTimer()
        resolve()
      }

      const rejectOnce = (error: Error) => {
        if (settled) return
        settled = true
        clearConnectTimer()
        reject(error)
      }

      const notifyDisconnect = (reason = 'Connection lost') => {
        if (disconnected) return
        disconnected = true
        this.flushPending(reason)
        this.onDisconnect?.(reason)
      }

      const tryConnect = () => {
        if (attemptIndex >= fallbackList.length) {
          // Exhausted all relays — retry with backoff if providers were busy
          if (retries < MAX_RETRIES) {
            retries++
            attemptIndex = 0
            setTimeout(tryConnect, 3000)
            return
          }
          rejectOnce(new Error('No peer available in ' + country + ' - try another country'))
          return
        }
        const relay = fallbackList[attemptIndex]
        this.ws = new WebSocket(relay)

        this.ws.onopen = () => {
          this.ws!.send(JSON.stringify({
            type: 'request_session',
            country,
            userId,
            authToken,
            requireTunnel: false,
            dbSessionId,
            preferredProviderUserId: preferredProviderUserId ?? null,
            privateProviderUserId: privateProviderUserId ?? null,
            privateBaseDeviceId: privateBaseDeviceId ?? null,
            supportsDirect: true,
          }))
        }

        this.ws.onmessage = (event) => {
          const msg = JSON.parse(event.data)

          if (msg.type === 'session_created') {
            this.sessionInfo = {
              sessionId: msg.sessionId,
              country,
              relayEndpoint: relay,
              mandate: msg.mandate ?? null,
              transportTier: msg.transportTier ?? 0,
              providerDirectEndpoint: msg.providerDirectEndpoint ?? null,
            }
          }

          if (msg.type === 'agent_session_ready') {
            this.agentSessionId = msg.sessionId
            resolveOnce()
          }

          if (msg.type === 'session_reconnected') {
            this.agentSessionId = msg.sessionId
            const reconnectRelay = msg.relayEndpoint || relay
            this.sessionInfo = {
              sessionId: msg.sessionId,
              country: msg.country ?? country,
              relayEndpoint: reconnectRelay,
              mandate: msg.mandate ?? null,
              transportTier: msg.transportTier ?? 0,
              providerDirectEndpoint: msg.providerDirectEndpoint ?? null,
            }
            this.onReconnect?.(this.sessionInfo, msg.attempt)
          }

          if (msg.type === 'proxy_response') {
            const response = msg.response as ProxyResponse
            const pending = this.pending.get(response.requestId)
            if (pending) {
              clearTimeout(pending.timer)
              this.pending.delete(response.requestId)
              pending.resolve(response)
            }
          }

          if (msg.type === 'error') {
            if (!settled) {
              // No provider on this relay — try the next one in the fallback list
              if (attemptIndex < fallbackList.length - 1) {
                attemptIndex++
                this.ws?.close()
                setTimeout(tryConnect, 500)
              } else {
                // Last relay failed — advance past end to trigger retry-with-backoff
                attemptIndex = fallbackList.length
                this.ws?.close()
                setTimeout(tryConnect, 0)
              }
            } else {
              notifyDisconnect(msg.message)
            }
          }

          if (msg.type === 'session_ended') {
            notifyDisconnect(msg.reason ?? 'Peer session ended')
          }
        }

        this.ws.onerror = () => {
          if (!settled && attemptIndex < fallbackList.length - 1) {
            attemptIndex++
            setTimeout(tryConnect, 1500)
          } else if (!settled) {
            rejectOnce(new Error('WebSocket connection failed'))
          }
        }

        this.ws.onclose = () => {
          if (!settled) return
          if (this.sessionInfo) notifyDisconnect('Peer connection closed')
        }

        connectTimer = setTimeout(() => {
          if (!this.agentSessionId) {
            this.ws?.close()
            rejectOnce(new Error('No peer available in ' + country + ' - try another country'))
          }
        }, 15_000)
      }

      tryConnect()
    })
  }

  async fetch(url: string, options: RequestInit = {}): Promise<ProxyResponse> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return { requestId: '', status: 503, headers: {}, body: '', error: 'Not connected to peer' }
    }
    const requestId = crypto.randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId)
        if (!pending) return
        this.pending.delete(requestId)
        pending.resolve({ requestId, status: 504, headers: {}, body: '', error: 'Request timed out' })
      }, 30_000)

      this.pending.set(requestId, { resolve, timer })
      this.ws!.send(JSON.stringify({
        type: 'proxy_request',
        sessionId: this.agentSessionId,
        request: {
          requestId,
          url,
          method: options.method ?? 'GET',
          headers: options.headers ?? {},
          body: options.body ?? null,
        },
      }))
    })
  }

  private flushPending(reason: string) {
    for (const [requestId, pending] of this.pending.entries()) {
      clearTimeout(pending.timer)
      pending.resolve({ requestId, status: 503, headers: {}, body: '', error: reason })
    }
    this.pending.clear()
  }

  disconnect() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'end_session' }))
    }
    this.ws?.close()
    this.ws = null
    this.sessionInfo = null
    this.flushPending('Disconnected')
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && !!this.agentSessionId
  }
}
