// ============================================================
// Zustand Stores — all app state in one file
// ============================================================
import { create } from 'zustand'
import type { Project, Agent, AgentRelationship, Conversation, Message, GenerationLog, TerminalEntry } from '../shared/types'

// ---- UI Store ----
interface UIState {
  activeTab: 'chat' | 'skills' | 'agents' | 'process' | 'tests' | 'help'
  theme: 'dark' | 'light'
  settingsOpen: boolean
  setActiveTab: (tab: UIState['activeTab']) => void
  setTheme: (theme: UIState['theme']) => void
  setSettingsOpen: (open: boolean) => void
}
export const useUIStore = create<UIState>(set => ({
  activeTab: 'chat', theme: 'dark', settingsOpen: false,
  setActiveTab: (tab) => set({ activeTab: tab }),
  setTheme: (theme) => set({ theme }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
}))

// ---- Project Store ----
interface ProjectState {
  projects: Project[]
  activeProjectId: string | null
  mode: 'project' | 'standalone'
  setProjects: (p: Project[]) => void
  addProject: (p: Project) => void
  updateProject: (id: string, u: Partial<Project>) => void
  removeProject: (id: string) => void
  setActiveProject: (id: string | null) => void
  setMode: (m: 'project' | 'standalone') => void
}
export const useProjectStore = create<ProjectState>(set => ({
  projects: [], activeProjectId: localStorage.getItem('activeProjectId') || null, mode: (localStorage.getItem('mode') as 'project' | 'standalone') || 'project',
  setProjects: (projects) => set({ projects }),
  addProject: (p) => set(s => ({ projects: [...s.projects, p] })),
  updateProject: (id, u) => set(s => ({ projects: s.projects.map(p => p.id === id ? { ...p, ...u } : p) })),
  removeProject: (id) => set(s => ({ projects: s.projects.filter(p => p.id !== id) })),
  setActiveProject: (id) => { if (id) localStorage.setItem('activeProjectId', id); else localStorage.removeItem('activeProjectId'); set({ activeProjectId: id }) },
  setMode: (mode) => { localStorage.setItem('mode', mode); set({ mode }) },
}))

// ---- Agent Store ----
interface AgentState {
  agents: Agent[]
  relationships: AgentRelationship[]
  selectedAgentId: string | null
  nodePositions: Record<string, { x: number; y: number }>
  setAgents: (a: Agent[]) => void
  addAgent: (a: Agent) => void
  updateAgent: (id: string, u: Partial<Agent>) => void
  removeAgent: (id: string) => void
  setRelationships: (r: AgentRelationship[]) => void
  addRelationship: (r: AgentRelationship) => void
  setSelectedAgent: (id: string | null) => void
  setNodePositions: (p: Record<string, { x: number; y: number }>) => void
  updateNodePosition: (id: string, pos: { x: number; y: number }) => void
}
export const useAgentStore = create<AgentState>(set => ({
  agents: [], relationships: [], selectedAgentId: null, nodePositions: {},
  setAgents: (agents) => set({ agents }),
  addAgent: (a) => set(s => s.agents.some(x => x.id === a.id) ? s : { agents: [...s.agents, a] }),
  updateAgent: (id, u) => set(s => ({ agents: s.agents.map(a => a.id === id ? { ...a, ...u } : a) })),
  removeAgent: (id) => set(s => ({ agents: s.agents.filter(a => a.id !== id) })),
  setRelationships: (relationships) => set({ relationships }),
  addRelationship: (r) => set(s => s.relationships.some(x => x.id === r.id) ? s : { relationships: [...s.relationships, r] }),
  setSelectedAgent: (id) => set({ selectedAgentId: id }),
  setNodePositions: (nodePositions) => set({ nodePositions }),
  updateNodePosition: (id, pos) => set(s => ({ nodePositions: { ...s.nodePositions, [id]: pos } })),
}))

// ---- Action Event types ----
export interface ActionEvent {
  type: 'system' | 'thinking' | 'tool-use' | 'tool-result' | 'terminal' | 'done' | 'error'
  name?: string
  input?: unknown
  result?: unknown
  text?: string
  toolIndex?: number
  toolUseId?: string
  isError?: boolean
  model?: string
  mcpServers?: unknown
  status?: string
  content?: string
  toolCalls?: unknown[]
  timestamp: number
}

// ---- Chat Store ----
interface ChatState {
  conversations: Conversation[]
  activeConversationId: string | null
  messages: Record<string, Message[]>
  streamingContent: string
  isSending: boolean
  plan: { agentIds: string[]; agentCount: number; status: string } | null
  actionEvents: ActionEvent[]
  setConversations: (c: Conversation[]) => void
  addConversation: (c: Conversation) => void
  setActiveConversation: (id: string | null) => void
  setMessages: (cid: string, m: Message[]) => void
  addMessage: (cid: string, m: Message) => void
  setStreamingContent: (c: string) => void
  setIsSending: (s: boolean) => void
  setPlan: (p: { agentIds: string[]; agentCount: number; status: string } | null) => void
  addActionEvent: (e: ActionEvent) => void
  clearActionEvents: () => void
}
export const useChatStore = create<ChatState>(set => ({
  conversations: [], activeConversationId: localStorage.getItem('activeConvId') || null, messages: {}, streamingContent: '', isSending: false, plan: null, actionEvents: [],
  setConversations: (conversations) => set({ conversations }),
  addConversation: (c) => set(s => ({ conversations: [c, ...s.conversations] })),
  setActiveConversation: (id) => { if (id) localStorage.setItem('activeConvId', id); else localStorage.removeItem('activeConvId'); set({ activeConversationId: id }) },
  setMessages: (cid, messages) => set(s => ({ messages: { ...s.messages, [cid]: messages } })),
  addMessage: (cid, m) => set(s => ({ messages: { ...s.messages, [cid]: [...(s.messages[cid] || []), m] } })),
  setStreamingContent: (streamingContent) => set({ streamingContent }),
  setIsSending: (isSending) => set({ isSending }),
  setPlan: (plan) => set({ plan }),
  addActionEvent: (e) => set(s => ({ actionEvents: [...s.actionEvents, e] })),
  clearActionEvents: () => set({ actionEvents: [] }),
}))

// ---- Generation Store ----
export interface GenSession {
  agentId: string; agentName: string; startTime: number
  status: 'generating' | 'completed' | 'failed'
  files: string[]; error?: string
}
interface GenState {
  logs: GenerationLog[]
  terminalHistory: TerminalEntry[]
  terminalText: string
  sessions: Record<string, GenSession>
  agentTerminalTexts: Record<string, string>
  dockerState: 'idle' | 'generated' | 'building' | 'running'
  addLog: (l: GenerationLog) => void
  addTerminalOutput: (t: TerminalEntry) => void
  appendTerminalText: (text: string) => void
  appendAgentTerminalText: (agentId: string, text: string) => void
  upsertSession: (s: GenSession) => void
  updateSession: (agentId: string, u: Partial<GenSession>) => void
  setDockerState: (s: 'idle' | 'generated' | 'building' | 'running') => void
}
export const useGenerationStore = create<GenState>(set => ({
  logs: [], terminalHistory: [], terminalText: localStorage.getItem('processTerminalText') || '',
  sessions: (() => { try { return JSON.parse(localStorage.getItem('processSessions') || '{}') } catch { return {} } })(),
  agentTerminalTexts: {},
  dockerState: (localStorage.getItem('dockerState') as 'idle'|'generated'|'building'|'running') || 'idle',
  addLog: (log) => set(s => ({ logs: [...s.logs, log] })),
  addTerminalOutput: (t) => set(s => {
    const next = [...s.terminalHistory, t]
    if (next.length > 500) next.splice(0, next.length - 500)
    return { terminalHistory: next }
  }),
  appendTerminalText: (text) => set(s => {
    let t = s.terminalText + text
    if (t.length > 50000) t = t.slice(-40000)
    try { localStorage.setItem('processTerminalText', t) } catch { /* quota exceeded */ }
    return { terminalText: t }
  }),
  appendAgentTerminalText: (agentId, text) => set(s => {
    const prev = s.agentTerminalTexts[agentId] || ''
    let t = prev + text
    if (t.length > 20000) t = t.slice(-15000)
    return { agentTerminalTexts: { ...s.agentTerminalTexts, [agentId]: t } }
  }),
  upsertSession: (session) => set(s => {
    const next = { ...s.sessions, [session.agentId]: session }
    try { localStorage.setItem('processSessions', JSON.stringify(next)) } catch { /* ok */ }
    return { sessions: next }
  }),
  updateSession: (agentId, u) => set(s => {
    const cur = s.sessions[agentId]
    if (!cur) return s
    const next = { ...s.sessions, [agentId]: { ...cur, ...u } }
    try { localStorage.setItem('processSessions', JSON.stringify(next)) } catch { /* ok */ }
    return { sessions: next }
  }),
  setDockerState: (dockerState) => { localStorage.setItem('dockerState', dockerState); set({ dockerState }) },
}))

// ---- Notification Store (Toast messages) ----
export interface Toast {
  id: string
  type: 'success' | 'error' | 'warning' | 'info'
  message: string
  duration: number
}

interface NotificationState {
  toasts: Toast[]
  addToast: (toast: Omit<Toast, 'id'>) => void
  removeToast: (id: string) => void
}
export const useNotificationStore = create<NotificationState>((set, get) => ({
  toasts: [],
  addToast: (t) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const toast = { ...t, id }
    set(s => ({ toasts: [...s.toasts, toast] }))
    if (t.duration !== 0) setTimeout(() => get().removeToast(id), t.duration || 5000)
  },
  removeToast: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
}))
