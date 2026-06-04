// ============================================================
// Sidebar — project tree / standalone agents
// ============================================================
import { useState, useEffect, useRef } from 'react'
import { useUIStore, useProjectStore, useAgentStore, useChatStore } from './stores'
import { api } from './api'
import { APP_NAME } from '../shared/constants'

// SVG icons
const IC = {
  plus: 'M8 2a.5.5 0 0 1 .5.5v5h5a.5.5 0 0 1 0 1h-5v5a.5.5 0 0 1-1 0v-5h-5a.5.5 0 0 1 0-1h5v-5A.5.5 0 0 1 8 2z',
  edit: 'M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10z',
  trash: 'M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1z',
  gear: 'M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.86z',
  right: 'M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z',
  down: 'M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z',
  power: 'M7.5 1v7h1V1a.5.5 0 0 0-1 0z M8 12a4 4 0 0 1-4-4.06 4.03 4.03 0 0 1 1.32-2.98.5.5 0 1 1 .68.74A3.04 3.04 0 0 0 5 7.94 3 3 0 1 0 9.04 9a3.01 3.01 0 0 0-1-1.96.5.5 0 0 1 .66-.75A3.98 3.98 0 0 1 12 8 4 4 0 0 1 8 12z',
  restart: 'M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v-.001z M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z',
  agent: 'M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm2-3a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm4 8c0 1-1 1-1 1H3s-1 0-1-1 1-4 6-4 6 3 6 4zm-1-.004c-.001-.246-.154-.986-.832-1.664C11.516 10.68 10.289 10 8 10c-2.29 0-3.516.68-4.168 1.332-.678.678-.83 1.418-.832 1.664h10z',
}

const S = ({ d, s = 14 }: { d: string; s?: number }) => <svg width={s} height={s} viewBox="0 0 16 16" fill="currentColor"><path d={d} /></svg>

export default function Sidebar() {
  const { setSettingsOpen, setActiveTab } = useUIStore()
  const { mode, setMode, projects, activeProjectId, setActiveProject, setProjects } = useProjectStore()
  const { agents, setAgents, setSelectedAgent, setRelationships } = useAgentStore()
  const { conversations, setConversations, activeConversationId, setActiveConversation } = useChatStore()

  const [dlg, setDlg] = useState(false)
  const [exp, setExp] = useState<Set<string>>(new Set())
  const [editProj, setEditProj] = useState<Record<string, unknown> | null>(null)
  const [pwMenu, setPwMenu] = useState(false)
  const reloadTimer = useRef<ReturnType<typeof setTimeout>>()

  // ---- Data loading ----
  const loadData = async () => {
    setProjects(await api.projects.list() as never)
    setConversations(await api.convs.list() as never)
    const all = await api.agents.list() as Record<string,unknown>[]
    setAgents(all as never)
    const pid = useProjectStore.getState().activeProjectId
    pid ? setRelationships(await api.rels.list(pid) as never) : setRelationships([])
  }

  const reload = () => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current)
    return new Promise<void>(resolve => {
      reloadTimer.current = setTimeout(async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await loadData(); break } catch { if (attempt < 2) await new Promise(r => setTimeout(r, 800)) }
        }
        resolve()
      }, 100)
    })
  }

  // Initial load + WebSocket event listeners
  useEffect(() => {
    reload().then(() => {
      const pid = useProjectStore.getState().activeProjectId
      if (pid) setExp(new Set([pid]))
      else {
        const first = useProjectStore.getState().projects[0]
        if (first) { setActiveProject(first.id); setExp(new Set([first.id])) }
      }
    })

    const unsub = [
      // Reload all data when WebSocket reconnects (server was down/restarted)
      api.on('ws:connected', () => { reload().then(() => {
        const pid = useProjectStore.getState().activeProjectId
        if (pid) setExp(new Set([pid]))
      })}),
      // Full reload for structural changes (create/delete)
      api.on('project:deleted', () => { reload(); setActiveProject(null) }),
      api.on('agent:deleted', reload),
      api.on('conversation:created', reload),
      // Incremental updates — no full reload needed
      api.on('project:updated', (d: unknown) => {
        const p = (d as { project: Record<string, unknown> }).project
        if (p) useProjectStore.getState().updateProject(p.id as string, p as never)
      }),
      api.on('agent:created', (d: unknown) => {
        const a = (d as { agent: Record<string, unknown> }).agent
        if (a) useAgentStore.getState().addAgent(a as never)
      }),
      api.on('agent:updated', (d: unknown) => {
        const a = (d as { agent: Record<string, unknown> }).agent
        if (a) useAgentStore.getState().updateAgent(a.id as string, a as never)
      }),
      api.on('relationship:created', (d: unknown) => {
        const r = (d as { relationship: Record<string, unknown> }).relationship
        if (r) useAgentStore.getState().addRelationship(r as never)
      }),
      api.on('relationship:deleted', (d: unknown) => {
        const data = d as { relationshipId: string }
        if (data.relationshipId) {
          useAgentStore.getState().setRelationships(
            useAgentStore.getState().relationships.filter(r => r.id !== data.relationshipId)
          )
        }
      }),
      api.on('project:relationships-updated', async () => {
        // Refresh relationships for active project
        const pid = useProjectStore.getState().activeProjectId
        if (pid) {
          try {
            const rels = await api.rels.list(pid)
            useAgentStore.getState().setRelationships(rels as never)
          } catch { /* ok */ }
        }
      }),
    ]
    return () => unsub.forEach(f => f())
  }, [])

  // ---- Project actions ----
  const createProject = async (name: string, desc: string, parentId?: string, rules?: string) => {
    try {
      const p = await api.projects.create({ name, description: desc, mode: 'project', outputPath: 'output', parentId: parentId || null, rules: rules || '' })
      setActiveProject(p.id as string); setDlg(false)
      setActiveConversation(null); setActiveTab('chat')
      reload()
    } catch { alert('Failed') }
  }

  const delProject = async (p: Record<string,unknown>) => {
    try {
      // Phase 1: get preview of what will be deleted
      const preview = await api.projects.del(p.id as string, false) as Record<string,unknown>
      if (preview.confirmRequired) {
        const pv = preview.preview as Record<string,unknown>
        const agentNames = (pv.agentNames as string[]) || []
        const detail = agentNames.length > 0
          ? `\n\nAgents to delete (${pv.agents}):\n${agentNames.map((n: string) => '  • ' + n).join('\n')}\n\nConversations: ${pv.conversations}\nRelationships: ${pv.relationships}`
          : ''
        if (!confirm(`Delete "${p.name}" and ALL its contents?${detail}\n\nThis cannot be undone.`)) return
      }
      // Phase 2: confirmed delete
      await api.projects.del(p.id as string, true)
      if (activeProjectId === p.id) setActiveProject(null)
      reload()
    } catch (err) { alert('Delete failed: ' + (err as Error).message) }
  }

  const saveProjectEdit = async (id: string, name: string, desc: string, rules: string) => {
    await api.projects.update(id, { name, description: desc, rules })
    setEditProj(null); reload()
  }

  const delConv = async (c: Record<string,unknown>) => {
    if (!confirm(`Delete "${c.title || 'Untitled'}"?`)) return
    await api.convs.del(c.id as string)
    if (activeConversationId === c.id) setActiveConversation(null)
    reload()
  }

  const createConv = async (projectId: string) => {
    try {
      const c = await api.convs.create({ title: 'New Chat', projectId })
      setActiveConversation(c.id as string); setActiveTab('chat')
      reload()
    } catch { alert('Failed') }
  }

  // ---- System ----
  const shutdown = async () => {
    setPwMenu(false)
    if (confirm(`Shut down ${APP_NAME}?`)) { try { await api.shutdown() } catch { /* gone */ } }
  }
  const restart = async () => {
    setPwMenu(false)
    if (confirm(`Restart ${APP_NAME}?`)) { try { await api.restart() } catch { /* gone */ } }
  }

  // ---- Render ----
  const rootProjects = projects.filter(p => p.mode === 'project' && !p.parentId)
  const getSubProjects = (parentId: string) => projects.filter(p => p.parentId === parentId)
  const standaloneAgents = agents.filter(a => !a.projectId)

  return (
    <aside className="w-[260px] bg-bg-secondary border-r border-border flex flex-col select-none flex-shrink-0">
      {/* Header */}
      <div className="h-10 px-4 flex items-center border-b border-border">
        <span className="text-xs font-semibold tracking-wider text-text-secondary uppercase">{APP_NAME}</span>
      </div>

      {/* Mode toggle */}
      <div className="px-3 py-2 border-b border-border">
        <div className="flex bg-bg-tertiary rounded p-0.5">
          <button onClick={() => setMode('project')}
            className={`flex-1 py-1 text-[11px] rounded font-medium transition-colors ${mode === 'project' ? 'bg-accent text-white' : 'text-text-secondary hover:text-text'}`}>
            Project
          </button>
          <button onClick={() => setMode('standalone')}
            className={`flex-1 py-1 text-[11px] rounded font-medium transition-colors ${mode === 'standalone' ? 'bg-accent text-white' : 'text-text-secondary hover:text-text'}`}>
            Agent
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {mode === 'project' ? (
          <>
            <div className="px-3 py-2 flex items-center justify-between">
              <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-widest">Projects</span>
              <button onClick={() => setDlg(true)} className="p-0.5 rounded text-text-tertiary hover:text-text hover:bg-bg-tertiary">
                <S d={IC.plus} s={13} />
              </button>
            </div>

            {rootProjects.length === 0 ? (
              <p className="text-[11px] text-text-tertiary px-3 py-2">No projects yet. Click + to create one.</p>
            ) : (
              rootProjects.map(p => {
                const open = exp.has(p.id)
                const convs = conversations.filter(c => c.projectId === p.id)
                const pAgents = agents.filter(a => a.projectId === p.id)
                return (
                  <div key={p.id}>
                    {/* Project row */}
                    <div className={`group flex items-center ${activeProjectId === p.id ? 'bg-accent/10' : ''}`}>
                      <button onClick={() => setExp(prev => { const n = new Set(prev); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n })}
                        className="px-1 py-1 text-text-tertiary hover:text-text"><S d={open ? IC.down : IC.right} s={12} /></button>

                      <button onClick={() => { setActiveProject(p.id); setActiveConversation(null) }}
                        className="flex-1 text-left py-1 min-w-0">
                        <span className="text-[12px] text-text">{p.name}</span>
                        <span className="text-[10px] text-text-tertiary ml-1.5">{pAgents.length} agents</span>
                      </button>

                      <div className="hidden group-hover:flex items-center pr-1 gap-0.5">
                        <button onClick={() => setEditProj(p)}
                          className="p-0.5 text-text-tertiary hover:text-text"><S d={IC.edit} s={10} /></button>
                        <button onClick={() => delProject(p)}
                          className="p-0.5 text-text-tertiary hover:text-error"><S d={IC.trash} s={10} /></button>
                      </div>
                    </div>

                    {/* Expanded: conversations + agents */}
                    {open && (
                      <div className="ml-4 border-l border-border/50">
                        {/* Conversations */}
                        <div className="pl-2 py-0.5">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] text-text-tertiary">Conversations</span>
                            <button onClick={() => createConv(p.id)}
                              className="p-0.5 text-text-tertiary hover:text-text"><S d={IC.plus} s={10} /></button>
                          </div>
                          {convs.length === 0 ? (
                            <p className="text-[10px] text-text-tertiary px-1 py-0.5">None</p>
                          ) : (
                            convs.sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()).map(c => (
                              <div key={c.id} className={`group flex items-center rounded ${activeConversationId === c.id ? 'bg-accent/10' : ''}`}>
                                <button onClick={() => { setActiveConversation(c.id); setActiveTab('chat') }}
                                  className="flex-1 text-left px-2 py-0.5 text-[11px] text-text-secondary hover:text-text truncate">
                                  {c.title || 'Untitled'}
                                </button>
                                <button onClick={() => delConv(c)}
                                  className="hidden group-hover:block px-1 text-text-tertiary hover:text-error"><S d={IC.trash} s={10} /></button>
                              </div>
                            ))
                          )}
                        </div>

                        {/* Sub-Projects */}
                        {getSubProjects(p.id).length > 0 && (
                          <div className="pl-2 py-0.5">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] text-text-tertiary">Sub-Projects</span>
                            </div>
                            {getSubProjects(p.id).map(sp => (
                              <button key={sp.id} onClick={() => { setActiveProject(sp.id); setActiveConversation(null); setActiveTab('chat') }}
                                className="w-full text-left px-2 py-0.5 rounded text-[11px] text-text-secondary hover:text-text hover:bg-bg-tertiary flex items-center gap-1">
                                <span className="w-1 h-1 rounded-full bg-accent flex-shrink-0" />
                                <span className="truncate">{sp.name}</span>
                              </button>
                            ))}
                          </div>
                        )}

                        {/* Agents */}
                        <div className="pl-2 pb-1">
                          <div className="py-0.5"><span className="text-[10px] text-text-tertiary">Agents ({pAgents.length})</span></div>
                          {pAgents.length === 0 ? (
                            <p className="text-[10px] text-text-tertiary px-1">None yet. Chat to generate agents.</p>
                          ) : (
                            pAgents.map(a => (
                              <button key={a.id} onClick={() => { setActiveProject(a.projectId); setSelectedAgent(a.id); setActiveTab('agents') }}
                                className="w-full text-left px-2 py-0.5 rounded text-[11px] text-text-secondary hover:text-text hover:bg-bg-tertiary flex items-center gap-1.5">
                                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${a.status === 'completed' ? 'bg-success' : a.status === 'failed' ? 'bg-error' : a.status === 'generating' || a.status === 'queued' ? 'bg-warning animate-pulse' : 'bg-text-tertiary'}`} />
                                <span className="truncate">{a.name}</span>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </>
        ) : (
          <>
            <div className="px-3 py-2 flex items-center justify-between">
              <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-widest">Agents</span>
              <button onClick={() => { setActiveConversation(null); setActiveProject(null); setActiveTab('chat') }}
                className="p-0.5 rounded text-text-tertiary hover:text-text hover:bg-bg-tertiary">
                <S d={IC.plus} s={13} />
              </button>
            </div>
            {standaloneAgents.length === 0 ? (
              <p className="text-[11px] text-text-tertiary px-3 py-2">No standalone agents yet. Click + to create via chat.</p>
            ) : (
              standaloneAgents.map(a => (
                <button key={a.id} onClick={() => { setSelectedAgent(a.id); setActiveTab('agents') }}
                  className="w-full text-left px-3 py-1 rounded text-[11px] text-text-secondary hover:text-text hover:bg-bg-tertiary flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${a.status === 'completed' ? 'bg-success' : a.status === 'failed' ? 'bg-error' : a.status === 'generating' || a.status === 'queued' ? 'bg-warning animate-pulse' : 'bg-text-tertiary'}`} />
                  <span className="truncate">{a.name}</span>
                </button>
              ))
            )}
          </>
        )}
      </div>

      {/* Footer: Settings + System */}
      <div className="border-t border-border p-1.5 space-y-0.5">
        <button onClick={() => setSettingsOpen(true)}
          className="w-full flex items-center gap-2 px-3 py-1.5 rounded text-[12px] text-text-secondary hover:text-text hover:bg-bg-tertiary transition-colors">
          <S d={IC.gear} /> Settings
        </button>
        <div className="relative">
          <button onClick={() => setPwMenu(!pwMenu)}
            className="w-full flex items-center gap-2 px-3 py-1.5 rounded text-[12px] text-text-secondary hover:text-text hover:bg-bg-tertiary transition-colors">
            <S d={IC.power} /> System
          </button>
          {pwMenu && (
            <>
              <div className="absolute bottom-full left-2 right-2 mb-1 bg-bg-tertiary border border-border rounded-md shadow-lg py-1 z-50">
                <button onClick={restart} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-secondary hover:text-text hover:bg-bg">
                  <S d={IC.restart} s={13} /> Restart Server
                </button>
                <button onClick={shutdown} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-error hover:text-error hover:bg-bg">
                  <S d={IC.power} s={13} /> Shut Down
                </button>
              </div>
              <div className="fixed inset-0 z-40" onClick={() => setPwMenu(false)} />
            </>
          )}
        </div>
      </div>

      {/* New Project Dialog */}
      {dlg && <NewProjectDlg onClose={() => setDlg(false)} onCreate={createProject} />}
      {/* Edit Project Dialog */}
      {editProj && <EditProjectDlg project={editProj} onClose={() => setEditProj(null)} onSave={saveProjectEdit} />}
    </aside>
  )
}

function NewProjectDlg({ onClose, onCreate }: { onClose: () => void; onCreate: (n: string, d: string, parentId?: string, rules?: string) => void }) {
  const [n, setN] = useState(''); const [d, setD] = useState(''); const [r, setR] = useState('')
  const submit = () => { if (n.trim()) { onCreate(n.trim(), d.trim(), undefined, r.trim()); onClose() } }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-bg-secondary border border-border rounded-lg w-[480px] shadow-xl p-5 space-y-4">
        <h2 className="text-sm font-semibold">New Project</h2>
        <input value={n} onChange={e => setN(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="Project name" autoFocus
          className="w-full bg-bg border border-border rounded px-3 py-2 text-[13px] placeholder-text-tertiary outline-none focus:border-accent" />
        <textarea value={d} onChange={e => setD(e.target.value)} placeholder="Description (optional)" rows={2}
          className="w-full bg-bg border border-border rounded px-3 py-2 text-[13px] placeholder-text-tertiary outline-none focus:border-accent resize-none" />
        <div>
          <label className="text-[12px] text-text-secondary block mb-1">Project Rules / Generation Guidelines <span className="text-text-tertiary">(optional)</span></label>
          <textarea value={r} onChange={e => setR(e.target.value)}
            placeholder={`e.g. Use microservices architecture with event-driven communication. Follow TypeScript best practices. Each module should be independently testable. Use REST APIs for inter-service communication.

Additional packages (comma-separated):
packages: mqtt, pg, redis, helmet, morgan`}
            rows={4}
            className="w-full bg-bg border border-border rounded px-3 py-2 text-[12px] placeholder-text-tertiary outline-none focus:border-accent resize-none" />
          <p className="text-[10px] text-text-tertiary mt-1">These rules guide how the AI decomposes requirements and generates agent code.</p>
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-1.5 text-[12px] text-text-secondary hover:text-text rounded">Cancel</button>
          <button onClick={submit} disabled={!n.trim()}
            className="px-4 py-1.5 text-[12px] bg-accent hover:bg-accent-hover disabled:opacity-40 text-white rounded font-medium">Create</button>
        </div>
      </div>
    </div>
  )
}

function EditProjectDlg({ project, onClose, onSave }: { project: Record<string, unknown>; onClose: () => void; onSave: (id: string, n: string, d: string, rules: string) => void }) {
  const [n, setN] = useState(project.name as string)
  const [d, setD] = useState((project.description as string) || '')
  const [r, setR] = useState((project.rules as string) || '')
  const submit = () => { if (n.trim()) { onSave(project.id as string, n.trim(), d.trim(), r.trim()); onClose() } }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-bg-secondary border border-border rounded-lg w-[480px] shadow-xl p-5 space-y-4">
        <h2 className="text-sm font-semibold">Edit Project</h2>
        <input value={n} onChange={e => setN(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="Project name" autoFocus
          className="w-full bg-bg border border-border rounded px-3 py-2 text-[13px] placeholder-text-tertiary outline-none focus:border-accent" />
        <textarea value={d} onChange={e => setD(e.target.value)} placeholder="Description (optional)" rows={2}
          className="w-full bg-bg border border-border rounded px-3 py-2 text-[13px] placeholder-text-tertiary outline-none focus:border-accent resize-none" />
        <div>
          <label className="text-[12px] text-text-secondary block mb-1">Project Rules / Generation Guidelines <span className="text-text-tertiary">(optional)</span></label>
          <textarea value={r} onChange={e => setR(e.target.value)}
            placeholder={`Additional packages (comma-separated):
packages: mqtt, pg, redis, helmet, morgan`}
            rows={4}
            className="w-full bg-bg border border-border rounded px-3 py-2 text-[12px] placeholder-text-tertiary outline-none focus:border-accent resize-none" />
          <p className="text-[10px] text-text-tertiary mt-1">These rules guide AI code generation. Add "packages: name1, name2" to allow extra npm packages.</p>
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-1.5 text-[12px] text-text-secondary hover:text-text rounded">Cancel</button>
          <button onClick={submit} disabled={!n.trim()}
            className="px-4 py-1.5 text-[12px] bg-accent hover:bg-accent-hover disabled:opacity-40 text-white rounded font-medium">Save</button>
        </div>
      </div>
    </div>
  )
}
