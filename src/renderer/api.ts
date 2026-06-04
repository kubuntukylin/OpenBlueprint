// ============================================================
// API Client — HTTP fetch + WebSocket events
// ============================================================
const BASE = 'http://localhost:3001'

type EventFn = (data: unknown) => void
const listeners = new Map<string, Set<EventFn>>()
let ws: WebSocket | null = null

// Convert snake_case keys to camelCase recursively
function camelKeys(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj
  if (Array.isArray(obj)) return obj.map(camelKeys)
  if (typeof obj === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const key = k.replace(/_([a-z])/g, (_, c) => (c as string).toUpperCase())
      out[key] = camelKeys(v)
    }
    return out
  }
  return obj
}

function connectWS() {
  if (ws?.readyState === WebSocket.OPEN) return
  try {
    ws = new WebSocket('ws://localhost:3001/ws')
    ws.onopen = () => {
      listeners.get('ws:connected')?.forEach(fn => fn({}))
    }
    ws.onmessage = (e) => {
      try {
        const { type, payload } = JSON.parse(e.data)
        listeners.get(type)?.forEach(fn => fn(camelKeys(payload)))
      } catch { /* ignore */ }
    }
    ws.onclose = () => { setTimeout(connectWS, 3000) }
    ws.onerror = () => ws?.close()
  } catch { setTimeout(connectWS, 3000) }
}
connectWS()

async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(BASE + path, { headers: { 'Content-Type': 'application/json' }, ...opts })
  if (!r.ok) {
    const e = await r.json().catch(() => ({ error: r.statusText }))
    throw new Error(e.error || `HTTP ${r.status}`)
  }
  return camelKeys(await r.json()) as T
}

export const api = {
  // ---- Generic ----
  get: <T>(p: string) => req<T>(p),
  post: <T>(p: string, b?: unknown) => req<T>(p, { method: 'POST', body: b ? JSON.stringify(b) : undefined }),
  put: <T>(p: string, b?: unknown) => req<T>(p, { method: 'PUT', body: b ? JSON.stringify(b) : undefined }),
  del: <T>(p: string) => req<T>(p, { method: 'DELETE' }),

  // ---- Projects ----
  projects: {
    list: () => req<Record<string,unknown>[]>('/api/projects'),
    create: (d: Record<string,unknown>) => req<Record<string,unknown>>('/api/projects', { method: 'POST', body: JSON.stringify(d) }),
    update: (id: string, d: Record<string,unknown>) => req<Record<string,unknown>>(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify(d) }),
    del: (id: string, confirm?: boolean) => req('/api/projects/' + id + (confirm ? '?confirm=true' : ''), { method: 'DELETE' }),
  },

  // ---- Agents ----
  agents: {
    list: (projectId?: string) => req<Record<string,unknown>[]>('/api/agents' + (projectId ? '?projectId=' + projectId : '')),
    update: (id: string, d: Record<string,unknown>) => req<Record<string,unknown>>('/api/agents/' + id, { method: 'PUT', body: JSON.stringify(d) }),
    del: (id: string) => req('/api/agents/' + id, { method: 'DELETE' }),
    files: (id: string) => req<{name:string,path:string,size:number}[]>('/api/agents/' + id + '/files'),
    regenerate: (id: string) => req<Record<string,unknown>>('/api/agents/' + id + '/regenerate', { method: 'POST' }),
    generateClaude: (id: string) => req<Record<string,unknown>>('/api/agents/' + id + '/generate-claude', { method: 'POST' }),
  },

  // ---- Conversations ----
  convs: {
    list: () => req<Record<string,unknown>[]>('/api/conversations'),
    create: (d: Record<string,unknown>) => req<Record<string,unknown>>('/api/conversations', { method: 'POST', body: JSON.stringify(d) }),
    del: (id: string) => req('/api/conversations/' + id, { method: 'DELETE' }),
    messages: (id: string) => req<Record<string,unknown>[]>(`/api/conversations/${id}/messages`),
    chat: (id: string, content: string, buildMode?: boolean) => req<Record<string,unknown>>(`/api/conversations/${id}/chat`, { method: 'POST', body: JSON.stringify({ content, buildMode: buildMode || false }) }),
  },

  // ---- LLM Configs ----
  llm: {
    list: () => req<Record<string,unknown>[]>('/api/llm-configs'),
    create: (d: Record<string,unknown>) => req<Record<string,unknown>>('/api/llm-configs', { method: 'POST', body: JSON.stringify(d) }),
    update: (id: string, d: Record<string,unknown>) => req<Record<string,unknown>>('/api/llm-configs/' + id, { method: 'PUT', body: JSON.stringify(d) }),
    del: (id: string) => req('/api/llm-configs/' + id, { method: 'DELETE' }),
    test: (id: string) => req<Record<string,unknown>>('/api/llm-configs/' + id + '/test', { method: 'POST' }),
  },

  // ---- Relationships ----
  rels: {
    list: (projectId?: string) => req<Record<string,unknown>[]>('/api/relationships' + (projectId ? '?projectId=' + projectId : '')),
  },

  // ---- Settings ----
  settings: {
    get: () => req<Record<string,unknown>>('/api/settings'),
    set: (key: string, value: unknown) => req('/api/settings/' + key, { method: 'PUT', body: JSON.stringify({ value }) }),
  },

  // ---- Shell ----
  shell: {
    exec: (cwd: string, command: string) => req('/api/shell/exec', { method: 'POST', body: JSON.stringify({ cwd, command }) }),
  },

  // ---- System ----
  shutdown: () => req('/api/shutdown', { method: 'POST' }),
  restart: () => req('/api/restart', { method: 'POST' }),

  // ---- WebSocket events ----
  on: (event: string, fn: EventFn) => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event)!.add(fn)
    return () => { listeners.get(event)?.delete(fn) }
  }
}
