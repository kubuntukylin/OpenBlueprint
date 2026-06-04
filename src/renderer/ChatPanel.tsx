// ============================================================
// Chat Panel — messaging with streaming + project context
// ============================================================
import { useState, useRef, useEffect, useCallback } from 'react'
import { useChatStore, useProjectStore, useAgentStore, useGenerationStore, useUIStore, type ActionEvent } from './stores'
import { api } from './api'
import ReactMarkdown from 'react-markdown'
import BuildBoard from './BuildBoard'

export default function ChatPanel() {
  const chat = useChatStore()
  const { activeProjectId, projects, setActiveProject, mode } = useProjectStore()
  const agentStore = useAgentStore()
  const genStore = useGenerationStore()
  const activeProject = projects.find(p => p.id === activeProjectId)

  // Suppress benign ResizeObserver loop errors (ReactFlow internal)
  useEffect(() => {
    const orig = window.onerror
    window.onerror = function(msg) { if (typeof msg === 'string' && msg.includes('ResizeObserver')) return true; return orig?.apply(window, arguments as unknown as Parameters<typeof orig>) ?? false }
    return () => { window.onerror = orig }
  }, [])

  const [input, setInput] = useState('')
  const [buildMode, setBuildMode] = useState(false)
  const activeCid = useChatStore(s => s.activeConversationId)
  const actionEvents = useChatStore(s => s.actionEvents)
  const [loadingMessages, setLoadingMessages] = useState(!!activeCid)
  const endRef = useRef<HTMLDivElement>(null)
  const streamMsgIdRef = useRef<string | null>(null)
  const allMessages = useChatStore(s => s.messages)
  const msgs = activeCid ? (allMessages[activeCid] ?? []) : []

  // Scroll to bottom only when message count changes (not on every streaming token)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs.length])

  // Load messages when conversation changes - also runs on mount for restored ID
  useEffect(() => {
    const cid = useChatStore.getState().activeConversationId
    if (!cid) return
    setLoadingMessages(true)
    let cancelled = false
    const load = (attempt: number) => {
      api.convs.messages(cid)
        .then(m => {
          if (cancelled) return
          useChatStore.getState().setMessages(cid, m as never)
          setLoadingMessages(false)
        })
        .catch(err => {
          if (cancelled) return
          if (attempt < 2) setTimeout(() => load(attempt + 1), 1000)
          else {
            // Stale ID — conversation was deleted. Clear it.
            console.error('Failed to load messages:', err)
            localStorage.removeItem('activeConvId')
            useChatStore.getState().setActiveConversation(null)
            setLoadingMessages(false)
          }
        })
    }
    load(0)
    return () => { cancelled = true }
  }, [activeCid])

  // Restore pending plan on mount/refresh from DB
  useEffect(() => {
    const pid = useProjectStore.getState().activeProjectId
    if (!pid) return
    api.agents.list(pid).then((agents: Record<string,unknown>[]) => {
      const pending = agents.filter(a => (a.status || a.state) === 'pending')
      if (pending.length > 0) {
        useChatStore.getState().setPlan({
          agentIds: pending.map(a => a.id as string),
          agentCount: pending.length,
          status: 'pending'
        })
      }
    }).catch(() => {})
  }, [activeProjectId])

  // WebSocket: streaming + agent events
  // Uses getState() to avoid re-registering listeners on every streaming token
  useEffect(() => {
    const u = [
      // Clear stale sending state on reconnect (server may have restarted)
      api.on('ws:connected', () => {
        useChatStore.getState().setIsSending(false)
        useChatStore.getState().setStreamingContent('')
        streamMsgIdRef.current = null
      }),
      api.on('chat:stream', (d: unknown) => {
        const data = d as { conversationId: string; messageId: string; content: string }
        if (data.conversationId === useChatStore.getState().activeConversationId) {
          useChatStore.getState().setStreamingContent(data.content)
          streamMsgIdRef.current = data.messageId
        }
      }),
      api.on('chat:stream-done', (d: unknown) => {
        const data = d as { conversationId: string; messageId: string }
        const store = useChatStore.getState()
        if (data.conversationId === store.activeConversationId) {
          if (store.streamingContent) {
            store.addMessage(data.conversationId, {
              id: data.messageId, conversationId: data.conversationId, role: 'assistant',
              content: store.streamingContent,
              tokensIn: null, tokensOut: null, modelUsed: null,
              parentMessageId: null, sortOrder: Date.now(), createdAt: new Date().toISOString()
            } as never)
          }
          store.setStreamingContent(''); store.setIsSending(false)
          streamMsgIdRef.current = null
        }
      }),
      api.on('conversation:message-new', (d: unknown) => {
        const data = d as { conversationId: string; message: Record<string,unknown> }
        const store = useChatStore.getState()
        if (data.conversationId !== store.activeConversationId) return
        // B1: dedup — skip user messages already added locally
        const existing = store.messages[data.conversationId] || []
        if (data.message.role === 'user' && existing.some(m => m.role === 'user' && m.content === data.message.content)) return
        store.addMessage(data.conversationId, data.message as never)
      }),
      api.on('agent:created', (d: unknown) => {
        useAgentStore.getState().addAgent((d as { agent: Record<string,unknown> }).agent as never)
      }),
      api.on('agent:relationship-added', (d: unknown) => {
        useAgentStore.getState().addRelationship((d as { relationship: Record<string,unknown> }).relationship as never)
      }),
      api.on('project:updated', (d: unknown) => {
        const data = d as { project: Record<string,unknown> }
        const ps = useProjectStore.getState()
        if (ps.projects.find(p => p.id === data.project.id)) ps.updateProject(data.project.id as string, data.project as never)
        else ps.addProject(data.project as never)
      }),
      api.on('generation:agent-log', (d: unknown) => {
        const data = d as { log: Record<string,unknown> }
        const gs = useGenerationStore.getState()
        gs.addLog(data.log as never)
        gs.addTerminalOutput({
          sessionId: (data.log as Record<string,unknown>).session_id as string || '',
          text: `[${(data.log as Record<string,unknown>).phase || 'info'}] ${(data.log as Record<string,unknown>).message}\n`,
          stream: (data.log as Record<string,unknown>).log_level === 'error' ? 'stderr' : 'stdout',
          timestamp: Date.now()
        })
      }),
      // Action mode events from Claude Code
      api.on('action:system', (d: unknown) => {
        useChatStore.getState().addActionEvent({ type: 'system', ...(d as Record<string,unknown>), timestamp: Date.now() } as ActionEvent)
      }),
      api.on('action:thinking', (d: unknown) => {
        const data = d as Record<string,unknown>
        useChatStore.getState().addActionEvent({ type: 'thinking', text: data.text as string, timestamp: Date.now() } as ActionEvent)
      }),
      api.on('action:tool-use', (d: unknown) => {
        const data = d as Record<string,unknown>
        useChatStore.getState().addActionEvent({ type: 'tool-use', name: data.name as string, input: data.input, toolIndex: data.toolIndex as number, timestamp: Date.now() } as ActionEvent)
      }),
      api.on('action:tool-result', (d: unknown) => {
        const data = d as Record<string,unknown>
        useChatStore.getState().addActionEvent({ type: 'tool-result', name: data.name as string, result: data.result, toolUseId: data.toolUseId as string, isError: data.isError as boolean, timestamp: Date.now() } as ActionEvent)
      }),
      api.on('action:terminal', (d: unknown) => {
        const data = d as Record<string,unknown>
        useChatStore.getState().addActionEvent({ type: 'terminal', text: data.text as string, timestamp: Date.now() } as ActionEvent)
      }),
      api.on('action:done', (d: unknown) => {
        const data = d as Record<string,unknown>
        useChatStore.getState().addActionEvent({ type: 'done', content: data.content as string, status: data.status as string, toolCalls: data.toolCalls, timestamp: Date.now() } as ActionEvent)
        useChatStore.getState().setIsSending(false)
        useChatStore.getState().setStreamingContent('')
        streamMsgIdRef.current = null
      }),
      api.on('action:error', (d: unknown) => {
        const data = d as Record<string,unknown>
        useChatStore.getState().addActionEvent({ type: 'error', text: data.error as string, timestamp: Date.now() } as ActionEvent)
      }),
    ]
    return () => {
      u.forEach(fn => fn())
      useChatStore.getState().setIsSending(false)
      useChatStore.getState().setStreamingContent('')
    }
  }, []) // Stable — only register once

  const sendMessage = useCallback(async (content: string) => {
    const store = useChatStore.getState()
    if (!content.trim() || store.isSending) return
    store.setIsSending(true); store.setStreamingContent('')

    try {
      let convId = useChatStore.getState().activeConversationId
      // Add user message locally IMMEDIATELY so it's visible right away
      const userMsg = {
        id: 'local-' + Date.now(), conversationId: convId || '', role: 'user', content,
        tokensIn: null, tokensOut: null, modelUsed: null, parentMessageId: null,
        sortOrder: Date.now(), createdAt: new Date().toISOString()
      }
      store.addMessage(convId || 'pending', userMsg as never)
      if (!convId) {
        const pid = useProjectStore.getState().activeProjectId
        const conv = await api.convs.create({ title: content.slice(0, 60), projectId: pid || null })
        convId = conv.id as string
        // Move the local user message from 'pending' to the real conversation ID
        const pendingMsgs = useChatStore.getState().messages['pending'] || []
        useChatStore.getState().setMessages(convId, pendingMsgs)
        useChatStore.getState().setMessages('pending', [])
        useChatStore.getState().addConversation(conv as never)
        useChatStore.getState().setActiveConversation(convId)
        if (!pid && conv.project_id) setActiveProject(conv.project_id as string)
      }

      useChatStore.getState().clearActionEvents()
      const result = await api.convs.chat(convId, content, buildMode)
      if (result.projectId) setActiveProject(result.projectId as string)
      // B8: ensure assistant message is in store (WebSocket may miss it)
      if (result.message) {
        const msgs = useChatStore.getState().messages[convId] || []
        if (!msgs.some(m => m.id === (result.message as Record<string,unknown>).id)) {
          useChatStore.getState().addMessage(convId, result.message as never)
        }
      }
      // Add newly created agents + relationships to the store immediately
      if (Array.isArray(result.agents) && result.agents.length > 0) {
        const as = useAgentStore.getState()
        for (const a of result.agents as Record<string,unknown>[]) as.addAgent(a as never)
        api.convs.list().then(cs => useChatStore.getState().setConversations(cs as never)).catch(() => {})
      }
      if (Array.isArray(result.relationships) && result.relationships.length > 0) {
        const as = useAgentStore.getState()
        for (const r of result.relationships as Record<string,unknown>[]) as.addRelationship(r as never)
      }
      // Store plan for confirmation
      if (result.plan) {
        useChatStore.getState().setPlan(result.plan as never)
      }
      // If no streaming arrived (sync response), stop sending
      setTimeout(() => {
        if (!useChatStore.getState().streamingContent) useChatStore.getState().setIsSending(false)
      }, 200)

    } catch (err) {
      useChatStore.getState().setIsSending(false)
      useChatStore.getState().setStreamingContent('❌ ' + (err instanceof Error ? err.message : 'Unknown error'))
    }
  }, [buildMode]) // rebuild when mode changes

  const stopStream = async () => {
    const cid = useChatStore.getState().activeConversationId
    if (cid) await api.post(`/api/conversations/${cid}/stop`, {}).catch(() => {})
    useChatStore.getState().setIsSending(false)
    useChatStore.getState().setStreamingContent('')
  }

  const send = () => { if (input.trim() && !chat.isSending) { const m = input; setInput(''); sendMessage(m) } }
  const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }

  const deleteConv = async (id: string) => {
    if (!confirm('Delete this conversation?')) return
    await api.convs.del(id)
    if (chat.activeConversationId === id) chat.setActiveConversation(null)
    chat.setConversations(await api.convs.list() as never)
  }

  // ---- Welcome screen: no conversation selected OR loading ----
  if (!activeCid) {
    return (
      <div className="h-full flex flex-col bg-bg overflow-y-auto">
        <div className="flex-1 flex flex-col items-center justify-center py-8">
          <div className="text-center max-w-lg px-8">
            <h2 className="text-lg font-semibold mb-1">Create software with AI</h2>

            {activeProject ? (
              <p className="text-xs text-accent mb-4">Project: <span className="font-medium">{activeProject.name}</span></p>
            ) : mode === 'project' ? (
              <p className="text-xs text-text-tertiary mb-4">Create a project in the sidebar first, then describe what you want to build.</p>
            ) : (
              <p className="text-xs text-text-tertiary mb-4">Describe the agent you need. It will be created as a standalone agent.</p>
            )}

            <div className="space-y-3 mb-8">
              <div className="flex justify-center">
                <div className="flex bg-bg-tertiary rounded-lg p-0.5">
                  <button onClick={() => setBuildMode(false)}
                    className={`px-3 py-1 text-[11px] rounded-md font-medium transition-colors ${!buildMode ? 'bg-accent text-white' : 'text-text-tertiary hover:text-text'}`}>
                    Chat
                  </button>
                  <button onClick={() => setBuildMode(true)}
                    className={`px-3 py-1 text-[11px] rounded-md font-medium transition-colors ${buildMode ? 'bg-accent text-white' : 'text-text-tertiary hover:text-text'}`}>
                    Build
                  </button>
                </div>
              </div>
              <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={onKey}
                placeholder={buildMode ? "Describe what to build or modify..." : "Describe the software you need..."}
                className="w-full bg-bg-tertiary border border-border rounded-lg px-4 py-3 text-sm placeholder-text-tertiary resize-none outline-none focus:border-accent transition-colors"
                rows={4} disabled={chat.isSending} />
              <button onClick={send} disabled={!input.trim() || chat.isSending}
                className={`w-full px-6 py-2.5 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors ${buildMode ? 'bg-accent hover:bg-accent-hover' : 'bg-bg-tertiary border border-border hover:bg-border text-text'}`}>
                {chat.isSending ? 'Working...' : buildMode ? 'Build' : 'Start Building'}
              </button>
            </div>

            {/* Quick Start Guide */}
            <div className="text-left border border-border rounded-xl bg-bg-secondary overflow-hidden">
              <div className="px-4 py-2.5 border-b border-border bg-bg-tertiary">
                <span className="text-[12px] font-semibold text-text">🚀 Quick Start Guide</span>
                <span className="text-[10px] text-text-tertiary ml-2">Complete workflow in 5 steps</span>
              </div>
              <div className="divide-y divide-border/50">
                {[
                  { n: 1, icon: '📁', title: 'Create Project', desc: 'Click + in the sidebar Projects section. Give it a name and optionally add Rules to guide code generation.', action: 'Go to Sidebar', fn: () => { /* user interacts with sidebar */ } },
                  { n: 2, icon: '💬', title: 'Describe Requirements', desc: 'Type what you want to build in the chat above. The AI decomposes it into agent modules.', action: activeProject ? 'Ready — type above' : 'Create project first', fn: () => {} },
                  { n: 3, icon: '🔗', title: 'View Agent Network', desc: 'Switch to the Agents tab to see the generated modules and their relationships as a graph.', action: 'Open Agents Tab', fn: () => { useUIStore.getState().setActiveTab('agents') } },
                  { n: 4, icon: '⚡', title: 'Generate Code', desc: 'In the Agents tab, click an agent and choose "Regenerate (API)" or "Claude Code Generate". Watch real-time output in the Process tab.', action: 'Open Process Tab', fn: () => { useUIStore.getState().setActiveTab('process') } },
                  { n: 5, icon: '🐳', title: 'Docker Deploy', desc: 'In the Process tab, click docker-compose.yml then Up to build and run all agents as Docker containers.', action: 'Open Process Tab', fn: () => { useUIStore.getState().setActiveTab('process') } },
                ].map(s => (
                  <div key={s.n} className="px-4 py-2.5 flex items-start gap-3">
                    <span className="text-lg flex-shrink-0 mt-0.5">{s.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] font-medium text-text">{s.n}. {s.title}</div>
                      <p className="text-[11px] text-text-tertiary leading-relaxed mt-0.5">{s.desc}</p>
                    </div>
                    <button onClick={s.fn} className="flex-shrink-0 px-2.5 py-1 text-[10px] bg-accent/15 hover:bg-accent/30 text-accent rounded-md whitespace-nowrap mt-0.5 font-medium transition-colors border border-accent/20 hover:border-accent/40">{s.action}</button>
                  </div>
                ))}
              </div>
            </div>

            {chat.conversations.length > 0 && (
              <div className="mt-8 text-left">
                <p className="text-xs text-text-tertiary mb-2">Recent conversations</p>
                <div className="space-y-0.5">
                  {chat.conversations.sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()).slice(0, 5).map(c => (
                    <div key={c.id} className="flex items-center group">
                      <button onClick={() => chat.setActiveConversation(c.id)}
                        className="flex-1 text-left px-2 py-1 text-[12px] text-text-secondary hover:text-text hover:bg-bg-tertiary rounded truncate">
                        {c.title || 'Untitled'}
                      </button>
                      <button onClick={() => deleteConv(c.id)}
                        className="hidden group-hover:block px-1 text-text-tertiary hover:text-error text-[10px]">x</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ---- Chat view ----
  return (
    <div className="h-full flex bg-bg">
      <div className="flex-1 min-w-0 flex flex-col">
      {/* Header */}
      <div className="h-8 border-b border-border flex items-center px-3 gap-2 flex-shrink-0">
        <span className="text-[12px] text-text-secondary truncate flex-1">
          {chat.conversations.find(c => c.id === chat.activeConversationId)?.title || 'Conversation'}
          {activeProject && <span className="text-text-tertiary ml-1.5">· {activeProject.name}</span>}
        </span>
        <button onClick={() => chat.setActiveConversation(null)} className="text-[11px] text-text-tertiary hover:text-text">New</button>
        <button onClick={() => chat.activeConversationId && deleteConv(chat.activeConversationId)} className="text-[11px] text-text-tertiary hover:text-error">Delete</button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loadingMessages ? (
          <div className="flex items-center justify-center h-full">
            <div className="flex gap-2">
              <span className="w-2 h-2 bg-accent rounded-full animate-bounce" />
              <span className="w-2 h-2 bg-accent rounded-full animate-bounce" style={{ animationDelay: '0.1s' }} />
              <span className="w-2 h-2 bg-accent rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
            </div>
          </div>
        ) : msgs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-text-tertiary text-sm">
            No messages. Start the conversation below.
          </div>
        ) : (
          msgs.map(msg => (
            <div key={msg.id} className={`mb-5 flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-lg px-4 py-3 text-sm leading-relaxed ${msg.role === 'user' ? 'bg-accent text-white' : 'bg-bg-secondary border border-border'}`}>
                {msg.role === 'assistant' ? (
                  <div className="prose prose-invert prose-sm max-w-none [&_strong]:text-accent [&_ul]:my-1.5 [&_li]:my-0.5 [&_p]:my-1">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                ) : (
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                )}
              </div>
            </div>
          ))
        )}

        {/* Streaming */}
        {chat.isSending && chat.streamingContent && (
          <div className="mb-5 flex justify-start">
            <div className="max-w-[80%] rounded-lg px-4 py-3 bg-bg-secondary border border-border">
              <div className="prose prose-invert prose-sm max-w-none [&_strong]:text-accent">
                <ReactMarkdown>{chat.streamingContent + '▊'}</ReactMarkdown>
              </div>
            </div>
          </div>
        )}

        {/* Loading dots */}
        {chat.isSending && !chat.streamingContent && (
          <div className="mb-5 flex justify-start">
            <div className="rounded-lg px-4 py-3 bg-bg-secondary border border-border flex gap-2">
              <span className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce" />
              <span className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce" style={{ animationDelay: '0.1s' }} />
              <span className="w-1.5 h-1.5 bg-accent rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
            </div>
          </div>
        )}

        {/* Action mode — tool call + result cards */}
        {actionEvents.length > 0 && (
          <div className="mb-5 space-y-3">
            {actionEvents.map((ev, i) => {
              if (ev.type === 'tool-use') return (
                <div key={i} className="flex justify-start">
                  <div className="max-w-[85%] rounded-lg px-4 py-3 bg-bg-secondary border border-accent/30">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="w-2 h-2 bg-accent rounded-full animate-pulse" />
                      <span className="text-[11px] font-bold text-accent uppercase">TOOL</span>
                      <span className="text-[12px] font-mono text-text">{ev.name?.replace(/^mcp__[^_]+__/, '')}</span>
                    </div>
                    {ev.input && <pre className="text-[11px] text-text-secondary overflow-x-auto max-h-32 overflow-y-auto">{JSON.stringify(ev.input, null, 2)}</pre>}
                  </div>
                </div>
              )
              if (ev.type === 'tool-result') return (
                <div key={i} className="flex justify-start">
                  <div className={`max-w-[85%] rounded-lg px-4 py-3 bg-bg-secondary border ${ev.isError ? 'border-error/30' : 'border-success/30'}`}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className={`w-2 h-2 rounded-full ${ev.isError ? 'bg-error' : 'bg-success'}`} />
                      <span className={`text-[11px] font-bold uppercase ${ev.isError ? 'text-error' : 'text-success'}`}>RESULT</span>
                    </div>
                    <pre className="text-[11px] text-text-secondary overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap">{typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result, null, 2)}</pre>
                  </div>
                </div>
              )
              if (ev.type === 'thinking') return (
                <div key={i} className="flex justify-start">
                  <div className="max-w-[85%] rounded-lg px-4 py-3 bg-bg-secondary border border-border">
                    <div className="prose prose-invert prose-sm max-w-none [&_strong]:text-accent">
                      <ReactMarkdown>{ev.text || ''}</ReactMarkdown>
                    </div>
                  </div>
                </div>
              )
              if (ev.type === 'done') return (
                <div key={i} className="flex justify-center">
                  <span className={`text-[11px] px-3 py-1 rounded-full ${ev.status === 'completed' ? 'bg-success/15 text-success' : ev.status === 'stopped' ? 'bg-warning/15 text-warning' : 'bg-error/15 text-error'}`}>
                    {ev.status === 'completed' ? 'Action completed' : ev.status === 'stopped' ? 'Stopped' : 'Action failed'}
                  </span>
                </div>
              )
              if (ev.type === 'error') return (
                <div key={i} className="flex justify-center">
                  <span className="text-[11px] px-3 py-1 rounded-full bg-error/15 text-error">{ev.text}</span>
                </div>
              )
              return null
            })}
          </div>
        )}

        {/* Plan confirmation card */}
        {chat.plan && (
          <div className="mb-5 flex justify-center">
            <div className="rounded-xl px-5 py-4 bg-accent/10 border-2 border-accent/40 shadow-lg shadow-accent/10 max-w-md w-full">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xl">📋</span>
                <div>
                  <div className="text-sm font-bold text-text">Build Plan Ready</div>
                  <div className="text-[11px] text-text-secondary">{chat.plan.agentCount} agents designed — review and confirm to generate code</div>
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={async () => {
                  const plan = useChatStore.getState().plan
                  if (!plan || !activeProjectId) return
                  try {
                    await api.post('/api/build/confirm', { projectId: activeProjectId, agentIds: plan.agentIds })
                    useChatStore.getState().setPlan(null)
                  } catch (e) { alert('Failed: ' + (e as Error).message) }
                }} className="flex-1 px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-[13px] font-semibold transition-colors">Create Agents</button>
                <button onClick={() => useChatStore.getState().setPlan(null)}
                  className="px-4 py-2 bg-bg-tertiary hover:bg-border text-text-secondary rounded-lg text-[13px] transition-colors">Cancel</button>
              </div>
            </div>
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* Input */}
      <div className="border-t border-border px-4 py-3">
        <div className="flex items-center gap-2 mb-2 max-w-3xl mx-auto">
          <div className="flex bg-bg-tertiary rounded-lg p-0.5">
            <button onClick={() => setBuildMode(false)}
              className={`px-3 py-1 text-[11px] rounded-md font-medium transition-colors ${!buildMode ? 'bg-accent text-white' : 'text-text-tertiary hover:text-text'}`}>
              Chat
            </button>
            <button onClick={() => setBuildMode(true)}
              className={`px-3 py-1 text-[11px] rounded-md font-medium transition-colors ${buildMode ? 'bg-accent text-white' : 'text-text-tertiary hover:text-text'}`}>
              Build
            </button>
          </div>
        </div>
        <div className="flex gap-2 max-w-3xl mx-auto">
          <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={onKey}
            placeholder={buildMode ? "Describe what to build or modify..." : "Ask a question or chat..."}
            className="flex-1 bg-bg-tertiary border border-border rounded-md px-3 py-2 text-sm placeholder-text-tertiary resize-none outline-none focus:border-accent transition-colors"
            rows={2} disabled={chat.isSending} />
          {chat.isSending ? (
            <button onClick={stopStream}
              className="px-5 py-2 bg-error hover:bg-red-600 text-white rounded-md text-sm font-medium transition-colors self-end">
              Stop
            </button>
          ) : (
            <button onClick={send} disabled={!input.trim()}
              className={`px-5 py-2 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-md text-sm font-medium transition-colors self-end ${buildMode ? 'bg-accent hover:bg-accent-hover' : 'bg-bg-tertiary border border-border hover:bg-border text-text'}`}>
              {buildMode ? 'Build' : 'Send'}
            </button>
          )}
        </div>
      </div>
      </div>
      <BuildBoard />
    </div>
  )
}
