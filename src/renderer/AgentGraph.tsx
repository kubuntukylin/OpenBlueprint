import React, { useMemo, useCallback, useEffect } from 'react'
import { ReactFlow, Background, Controls, MiniMap, useNodesState, useEdgesState, type Node, MarkerType } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useAgentStore, useProjectStore, useUIStore, useGenerationStore, useNotificationStore } from './stores'
import { api } from './api'
import Editor from '@monaco-editor/react'
import { AGENT_STATUS_COLORS, EDGE_COLORS } from '../shared/types'

const EDGE_LABELS: Record<string, string> = {
  depends_on: 'depends on', communicates_with: 'communicates', shares_data: 'shares data'
}

export default function AgentGraph() {
  const allAgents = useAgentStore(s => s.agents)
  const relationships = useAgentStore(s => s.relationships)
  const activeProjectId = useProjectStore(s => s.activeProjectId)
  const selectedAgentId = useAgentStore(s => s.selectedAgentId)
  const setSelectedAgent = useAgentStore(s => s.setSelectedAgent)
  const nodePositions = useAgentStore(s => s.nodePositions)
  const updateNodePosition = useAgentStore(s => s.updateNodePosition)

  const agents = useMemo(() => activeProjectId ? allAgents.filter(a => a.projectId === activeProjectId || !a.projectId) : allAgents, [allAgents, activeProjectId])

  // Load relationships
  useEffect(() => {
    if (activeProjectId) {
      api.rels.list(activeProjectId).then(r => { useAgentStore.getState().setRelationships(r as never) }).catch(() => {})
    }
  }, [activeProjectId])

  // Reload on WS events
  useEffect(() => {
    const reload = () => {
      const pid = useProjectStore.getState().activeProjectId
      if (!pid) return
      api.rels.list(pid).then(r => { useAgentStore.getState().setRelationships(r as never) }).catch(() => {})
    }
    const u1 = api.on('agent:created', reload)
    const u2 = api.on('agent:relationship-added', reload)
    return () => { u1(); u2() }
  }, [activeProjectId])

  const ioMap = useMemo(() => {
    const map: Record<string, string> = {}
    for (const a of agents) {
      try {
        const iface = JSON.parse(a.interfaceJson || '{}')
        map[a.id] = `${(iface.inputs as unknown[])?.length || 0} in / ${(iface.outputs as unknown[])?.length || 0} out`
      } catch { map[a.id] = '' }
    }
    return map
  }, [agents])

  // Build nodes and edges directly — no complex dep tracking
  const rawNodes: Node[] = useMemo(() => agents.map((a, i) => {
    const saved = nodePositions[a.id]
    return {
      id: a.id,
      type: 'default',
      position: saved || { x: 80 + (i % 3) * 300, y: 40 + Math.floor(i / 3) * 140 },
      data: {
        label: (
          <div className={`px-3 py-2 rounded-xl border-2 min-w-[170px] cursor-pointer transition-colors ${selectedAgentId === a.id ? 'border-blue-400 bg-blue-400/10 shadow-lg shadow-blue-400/20' : 'border-white/10 bg-[#1a1d2e] hover:border-white/25'}`} onClick={() => setSelectedAgent(a.id)}>
            <div className="flex items-center gap-2 mb-1">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: AGENT_STATUS_COLORS[a.status] || '#888', boxShadow: `0 0 6px ${AGENT_STATUS_COLORS[a.status] || '#888'}` }} />
              <span className="text-[13px] font-semibold text-white">{a.name}</span>
            </div>
            <div className="text-[11px] text-gray-400 line-clamp-2 mb-1.5">{(a.description || '').slice(0, 60)}</div>
            <div className="flex items-center justify-between text-[10px]">
              <span className="px-1.5 py-0.5 rounded-full font-medium capitalize" style={{ backgroundColor: AGENT_STATUS_COLORS[a.status] + '20', color: AGENT_STATUS_COLORS[a.status] }}>{a.status}</span>
              <span className="text-gray-500">{ioMap[a.id] || ''}</span>
            </div>
          </div>
        )
      }
    }
  }), [agents, selectedAgentId, ioMap, nodePositions])

  const rawEdges = useMemo(() => {
    return relationships.filter(r => r.sourceAgentId && r.targetAgentId && r.sourceAgentId !== r.targetAgentId).map(r => ({
      id: r.id, source: r.sourceAgentId, target: r.targetAgentId,
      type: 'default' as const,
      animated: r.relationshipType === 'communicates_with',
      label: EDGE_LABELS[r.relationshipType] || r.relationshipType,
      style: { stroke: EDGE_COLORS[r.relationshipType] || '#888', strokeWidth: 2 },
      labelStyle: { fill: '#888', fontSize: 10, fontWeight: 500 },
      labelBgStyle: { fill: '#1a1d2e', fillOpacity: 0.9 },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 4,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: EDGE_COLORS[r.relationshipType] || '#888' },
    }))
  }, [relationships])

  const [nodes, setNodes, onNodesChangeRaw] = useNodesState(rawNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(rawEdges)

  // Sync — detect both count and status/attribute changes
  useEffect(() => { setNodes(rawNodes) }, [agents, selectedAgentId])
  useEffect(() => { setEdges(rawEdges) }, [relationships, agents])

  const onNodesChange = useCallback((changes: Parameters<typeof onNodesChangeRaw>[0]) => {
    onNodesChangeRaw(changes)
    for (const c of changes) {
      if (c.type === 'position' && c.position) updateNodePosition(c.id, c.position)
    }
  }, [updateNodePosition])

  const onNodeClick = useCallback((_e: React.MouseEvent, node: Node) => { setSelectedAgent(node.id) }, [setSelectedAgent])

  const selected = agents.find(a => a.id === selectedAgentId)

  if (agents.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-[#0d1117]">
        <div className="text-center max-w-md">
          <h3 className="text-base font-semibold text-gray-300 mb-2">Agent Network</h3>
          <p className="text-[13px] text-gray-500 leading-relaxed">Start a conversation in the Chat tab. The AI will design agent modules and their relationships, shown here as an interactive graph.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex">
      <div className="flex-1 h-full relative">
        <span className="absolute top-1 left-3 text-[10px] text-amber-400 z-10 pointer-events-none bg-black/70 px-1 rounded">N:{nodes.length} E:{edges.length} R:{relationships.length}</span>
        <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onNodeClick={onNodeClick} fitView>
          <Background color="#1e293b" gap={24} size={1} />
          <Controls className="!bg-[#1a1d2e] !border-[#2d3348] !rounded-xl" position="bottom-left" />
          <MiniMap className="!bg-[#1a1d2e] !border-[#2d3348] !rounded-xl" maskColor="rgba(0,0,0,0.6)" nodeColor={n => AGENT_STATUS_COLORS[agents.find(a => a.id === n.id)?.status || 'pending'] || '#888'} position="bottom-right" />
        </ReactFlow>
        <div className="absolute top-3 right-3 bg-[#1a1d2e]/95 border border-[#2d3348] rounded-xl p-3 shadow-xl pointer-events-none z-10">
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Legend</div>
          <div className="space-y-1.5">
            {Object.entries(EDGE_LABELS).map(([type, label]) => (
              <div key={type} className="flex items-center gap-2 text-[11px]">
                <span className="w-4 h-0.5 rounded-full" style={{ backgroundColor: EDGE_COLORS[type] }} />
                <span className="text-gray-400">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      {selected && <AgentDetail agent={selected} onClose={() => setSelectedAgent(null)} />}
    </div>
  )
}

function AgentDetail({ agent, onClose }: { agent: import('../shared/types').Agent; onClose: () => void }) {
  const liveAgent = useAgentStore(s => s.agents.find(a => a.id === agent.id)) || agent
  const genSession = useGenerationStore(s => s.sessions[agent.id])
  const [edit, setEdit] = React.useState(false)
  const [ename, setEName] = React.useState(agent.name)
  const [edesc, setEDesc] = React.useState(liveAgent.description)
  const [saving, setSaving] = React.useState(false)
  const [regenerating, setRegenerating] = React.useState(false)
  const [files, setFiles] = React.useState<{name:string,path:string,size:number}[]>([])
  const [fileTree, setFileTree] = React.useState<FileTreeNode[]>([])
  const [viewingFile, setViewingFile] = React.useState<string | null>(null)
  const [fileContent, setFileContent] = React.useState('')
  const [loadingFile, setLoadingFile] = React.useState(false)
  const [editingFile, setEditingFile] = React.useState(false)
  const [editedContent, setEditedContent] = React.useState('')
  const [savingFile, setSavingFile] = React.useState(false)
  const [expandedDirs, setExpandedDirs] = React.useState<Set<string>>(new Set())
  const updateAgent = useAgentStore(s => s.updateAgent)
  const removeAgent = useAgentStore(s => s.removeAgent)
  const projects = useProjectStore(s => s.projects)
  const project = agent.projectId ? projects.find(p => p.id === agent.projectId) : null

  React.useEffect(() => {
    if (liveAgent.outputPath) {
      api.agents.files(liveAgent.id).then(f => setFiles(f)).catch(() => {})
      // Load full file tree for browsing subdirectories
      api.get<FileTreeNode[]>('/api/agents/' + liveAgent.id + '/file-tree').then(t => {
        setFileTree(t)
      }).catch(() => {})
    }
  }, [liveAgent.id, liveAgent.outputPath])

  const viewFile = async (path: string) => {
    setViewingFile(path); setLoadingFile(true)
    try { const r = await api.get<{content:string}>(`/api/files?path=${encodeURIComponent(path)}`); setFileContent(r.content) }
    catch { setFileContent('// Failed to load file') }
    finally { setLoadingFile(false) }
  }

  let interfaceInfo: Record<string, unknown> = {}
  try { interfaceInfo = JSON.parse(agent.interfaceJson || '{}') } catch { /* ok */ }

  return (
    <div className="w-80 bg-[#1a1d2e] border-l border-[#2d3348] overflow-y-auto flex-shrink-0">
      <div className="px-4 py-3 border-b border-[#2d3348] flex items-center justify-between">
        {edit ? (
          <input value={ename} onChange={e => setEName(e.target.value)} className="flex-1 bg-[#0d1117] border border-[#2d3348] rounded-lg px-2 py-1.5 text-sm text-white font-semibold focus:outline-none focus:border-blue-400" />
        ) : (
          <h3 className="text-sm font-semibold text-white truncate">{agent.name}</h3>
        )}
        <button onClick={onClose} className="text-gray-500 hover:text-white ml-2 flex-shrink-0">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z" /></svg>
        </button>
      </div>
      <div className="p-4 space-y-4">
        <div>
          <div className="text-[11px] text-gray-500 mb-1">Status</div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="px-2 py-0.5 text-xs rounded-full capitalize font-medium" style={{ backgroundColor: (AGENT_STATUS_COLORS[liveAgent.status] || '#888') + '20', color: AGENT_STATUS_COLORS[liveAgent.status] }}>{liveAgent.status}</span>
            {genSession && genSession.status !== liveAgent.status && (
              <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${genSession.status === 'completed' ? 'bg-success/20 text-success' : genSession.status === 'failed' ? 'bg-error/20 text-error' : 'bg-warning/20 text-warning'}`}>
                Process: {genSession.status}
              </span>
            )}
          </div>
        </div>
        {project && (
          <div>
            <div className="text-[11px] text-gray-500 mb-1">Project</div>
            <p className="text-sm text-white font-medium">{project.name}</p>
            <p className="text-[11px] text-gray-500 mt-0.5 font-mono">{project.outputPath || 'output'}</p>
          </div>
        )}
        {liveAgent.outputPath && (() => {
          const hasTree = fileTree.length > 0
          return (
          <div>
            <div className="text-[11px] text-gray-500 mb-1">Generated Files</div>
            <p className="text-[11px] text-blue-400 font-mono mb-2 truncate">{liveAgent.outputPath}</p>
            {hasTree ? (
              <div className="space-y-0 max-h-72 overflow-y-auto bg-[#0d1117] rounded-lg p-1">
                <FileTreeDisplay nodes={fileTree} depth={0} expandedDirs={expandedDirs}
                  toggleDir={(d) => setExpandedDirs(prev => { const n = new Set(prev); n.has(d) ? n.delete(d) : n.add(d); return n })}
                  selectedFile={viewingFile} onSelect={viewFile} />
              </div>
            ) : files.length > 0 ? (
              <div className="space-y-0.5 max-h-48 overflow-y-auto bg-[#0d1117] rounded-lg p-1.5">
                {files.map(f => (
                  <button key={f.name} onClick={() => viewFile(f.path)} className={`w-full text-left px-2 py-1 rounded text-[11px] flex justify-between items-center transition-colors ${viewingFile === f.path ? 'bg-blue-500/20 text-blue-300' : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'}`}>
                    <span className="font-mono truncate flex-1">{f.name}</span>
                    <span className="text-[10px] text-gray-500 ml-2 flex-shrink-0">{(f.size / 1024).toFixed(1)}K</span>
                  </button>
                ))}
              </div>
            ) : null}
            {viewingFile && (
              <div className="mt-2 bg-[#0d1117] rounded-lg overflow-hidden border border-[#2d3348]">
                <div className="px-2 py-1 bg-[#1a1d2e] border-b border-[#2d3348] flex items-center justify-between">
                  <span className="text-[10px] text-gray-400 font-mono truncate">{viewingFile.replace(/\\/g, '/').split('/').pop()}</span>
                  <div className="flex gap-1">
                    <button onClick={() => { setEditingFile(true); setEditedContent(fileContent) }} className="text-accent hover:text-blue-300 text-[10px] px-1">Edit</button>
                    <button onClick={() => setViewingFile(null)} className="text-gray-500 hover:text-white text-[10px]">✕</button>
                  </div>
                </div>
                <div className="p-2 max-h-96 overflow-y-auto">
                  {loadingFile ? <div className="text-[11px] text-gray-500 py-4 text-center">Loading...</div> : editingFile ? (
                    <div>
                      <Editor height="400px" language={detectLanguage(viewingFile)} theme="vs-dark"
                        value={editedContent} onChange={v => setEditedContent(v || '')}
                        options={{ fontSize: 11, minimap: { enabled: false }, scrollBeyondLastLine: false, wordWrap: 'on', lineNumbers: 'on', renderWhitespace: 'selection' }} />
                      <div className="flex gap-2 mt-1.5">
                        <button onClick={async () => {
                          setSavingFile(true)
                          try { await api.put('/api/files', { path: viewingFile, content: editedContent }); setFileContent(editedContent); setEditingFile(false) }
                          catch { useNotificationStore.getState().addToast({ type: 'error', message: 'Save failed', duration: 5000 }) }
                          finally { setSavingFile(false) }
                        }} disabled={savingFile} className="px-2 py-0.5 text-[10px] bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded">Save</button>
                        <button onClick={() => { setEditingFile(false); setEditedContent(fileContent) }} className="px-2 py-0.5 text-[10px] bg-gray-700 hover:bg-gray-600 text-gray-300 rounded">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <pre className="text-[11px] text-gray-300 font-mono whitespace-pre-wrap break-all leading-relaxed max-h-96 overflow-y-auto">{fileContent}</pre>
                      <button onClick={() => { setEditingFile(true); setEditedContent(fileContent) }} className="mt-1.5 px-2 py-0.5 text-[10px] bg-gray-700 hover:bg-gray-600 text-gray-300 rounded">Edit</button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )})()}
        <div>
          <div className="text-[11px] text-gray-500 mb-1">Description</div>
          {edit ? (
            <textarea value={edesc} onChange={e => setEDesc(e.target.value)} className="w-full bg-[#0d1117] border border-[#2d3348] rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-400 resize-none" rows={3} />
          ) : (
            <p className="text-sm text-gray-300">{agent.description || 'No description'}</p>
          )}
        </div>
        {!edit && ((interfaceInfo.inputs as Array<Record<string, unknown>>)?.length > 0) && (
          <div>
            <div className="text-[11px] text-gray-500 mb-1">Inputs</div>
            <div className="space-y-1">
              {(interfaceInfo.inputs as Array<Record<string, unknown>>).map((inp, i) => (
                <div key={i} className="text-xs text-gray-400 bg-[#0d1117] rounded-lg px-2 py-1.5 flex justify-between">
                  <span className="font-medium text-gray-300">{inp.name as string}</span>
                  <span className="text-gray-500 text-[10px]">{inp.type as string}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {!edit && ((interfaceInfo.outputs as Array<Record<string, unknown>>)?.length > 0) && (
          <div>
            <div className="text-[11px] text-gray-500 mb-1">Outputs</div>
            <div className="space-y-1">
              {(interfaceInfo.outputs as Array<Record<string, unknown>>).map((out, i) => (
                <div key={i} className="text-xs text-gray-400 bg-[#0d1117] rounded-lg px-2 py-1.5 flex justify-between">
                  <span className="font-medium text-gray-300">{out.name as string}</span>
                  <span className="text-gray-500 text-[10px]">{out.type as string}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div>
          <div className="text-[11px] text-gray-500 mb-1">Generation</div>
          <p className="text-sm text-gray-300">{agent.generationAttempts} / {agent.maxRetries} attempts</p>
        </div>
        {liveAgent.errorMessage && (
          <div>
            <div className="text-[11px] text-gray-500 mb-1">Error</div>
            <p className="text-sm text-red-400">{liveAgent.errorMessage}</p>
          </div>
        )}
        <div className="space-y-2 pt-2 border-t border-[#2d3348]">
          {/* Add Feature — sends build mode chat with agent context */}
          <AddFeature agent={agent} />
          {edit ? (
            <div className="flex gap-2">
              <button onClick={async () => { setSaving(true); try { const u = await api.agents.update(agent.id, { name: ename, description: edesc }); updateAgent(agent.id, u as never); setEdit(false) } catch (e) { useNotificationStore.getState().addToast({ type: 'error', message: 'Failed: ' + (e as Error).message, duration: 6000 }) } finally { setSaving(false) } }} disabled={saving} className="flex-1 px-3 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white rounded-lg text-sm font-medium">{saving ? 'Saving...' : 'Save'}</button>
              <button onClick={() => { setEdit(false); setEName(agent.name); setEDesc(agent.description) }} className="flex-1 px-3 py-1.5 bg-[#2d3348] hover:bg-[#3d4568] text-gray-300 rounded-lg text-sm">Cancel</button>
            </div>
          ) : (
            <button onClick={() => setEdit(true)} className="w-full px-3 py-1.5 bg-[#2d3348] hover:bg-[#3d4568] text-gray-300 rounded-lg text-sm">Edit Agent</button>
          )}
          <button onClick={async () => { if (!confirm(`Regenerate "${agent.name}"? Other agents are not affected.`)) return; setRegenerating(true); try { const u = await api.agents.regenerate(agent.id); updateAgent(agent.id, u as never) } catch (e) { useNotificationStore.getState().addToast({ type: 'error', message: 'Failed: ' + (e as Error).message, duration: 6000 }) } finally { setRegenerating(false) } }} disabled={regenerating} className="w-full px-3 py-1.5 bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 rounded-lg text-sm border border-blue-500/20 disabled:opacity-50">{regenerating ? 'Regenerating...' : 'Regenerate (API)'}</button>
          <button onClick={async () => { if (!confirm(`Generate "${agent.name}" with Claude Code? Full process visibility in Process tab.`)) return; setRegenerating(true); useUIStore.getState().setActiveTab('process'); try { const u = await api.agents.generateClaude(agent.id); updateAgent(agent.id, u as never) } catch (e) { useNotificationStore.getState().addToast({ type: 'error', message: 'Failed: ' + (e as Error).message, duration: 6000 }) } finally { setRegenerating(false) } }} disabled={regenerating} className="w-full px-3 py-1.5 bg-green-500/10 hover:bg-green-500/20 text-green-400 rounded-lg text-sm border border-green-500/20 disabled:opacity-50">{regenerating ? 'Generating...' : 'Claude Code Generate'}</button>
          <button onClick={async () => { if (!confirm(`Delete "${agent.name}"?`)) return; try { await api.agents.del(agent.id); removeAgent(agent.id); onClose() } catch (e) { useNotificationStore.getState().addToast({ type: 'error', message: 'Failed: ' + (e as Error).message, duration: 6000 }) } }} className="w-full px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg text-sm border border-red-500/20">Delete Agent</button>
        </div>
      </div>
    </div>
  )
}

function AddFeature({ agent }: { agent: import('../shared/types').Agent }) {
  const [text, setText] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const projects = useProjectStore(s => s.projects)
  const project = agent.projectId ? projects.find(p => p.id === agent.projectId) : null
  const add = async () => {
    if (!text.trim() || sending) return
    setSending(true)
    try {
      const msg = `Update agent "${agent.name}" (id: ${agent.id}). Current: ${agent.description}. ${text}`
      let convId = useChatStore.getState().activeConversationId
      if (!convId && project) {
        const conv = await api.convs.create({ title: `Update ${agent.name}`, projectId: project.id })
        convId = conv.id as string
      }
      if (convId) {
        await api.convs.chat(convId, msg, true)
        useUIStore.getState().setActiveTab('chat')
      }
      setText('')
    } catch (e) { useNotificationStore.getState().addToast({ type: 'error', message: 'Failed: ' + (e as Error).message, duration: 6000 }) } finally { setSending(false) }
  }
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] text-gray-500">Add feature to this agent</div>
      <textarea value={text} onChange={e => setText(e.target.value)}
        placeholder="e.g. add logging, add auth, support MQTT..."
        className="w-full bg-[#0d1117] border border-[#2d3348] rounded px-2 py-1.5 text-[11px] text-gray-300 placeholder-gray-600 resize-none focus:outline-none focus:border-purple-400"
        rows={2} disabled={sending} />
      <button onClick={add} disabled={!text.trim() || sending}
        className="w-full px-3 py-1.5 bg-purple-500/10 hover:bg-purple-500/20 text-purple-400 rounded text-[12px] border border-purple-500/20 disabled:opacity-40">
        {sending ? 'Sending...' : 'Add Feature'}
      </button>
    </div>
  )
}

// ---- File Tree ----
interface FileTreeNode { name: string; type: 'file' | 'dir'; path: string; size: number; children?: FileTreeNode[] }

function FileTreeDisplay({ nodes, depth, expandedDirs, toggleDir, selectedFile, onSelect }: {
  nodes: FileTreeNode[]
  depth: number
  expandedDirs: Set<string>
  toggleDir: (path: string) => void
  selectedFile: string | null
  onSelect: (path: string) => void
}) {
  // Directories first, then files, both alphabetically
  const sorted = [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return (
    <>
      {sorted.map(n => {
        if (n.type === 'dir') {
          const isExpanded = expandedDirs.has(n.path)
          const children = (n as { children?: FileTreeNode[] }).children || []
          return (
            <div key={n.path}>
              <button onClick={() => toggleDir(n.path)}
                className="w-full text-left px-1 py-0.5 text-[11px] text-gray-400 hover:text-gray-200 flex items-center gap-1 rounded hover:bg-white/5">
                <span className="text-[10px] w-3 text-center">{isExpanded ? '▾' : '▸'}</span>
                <span className="text-yellow-600">📁</span>
                <span className="font-mono truncate">{n.name}/</span>
              </button>
              {isExpanded && (
                <div className="ml-3 border-l border-[#2d3348] pl-2">
                  <FileTreeDisplay nodes={children} depth={depth + 1}
                    expandedDirs={expandedDirs} toggleDir={toggleDir}
                    selectedFile={selectedFile} onSelect={onSelect} />
                </div>
              )}
            </div>
          )
        }
        return (
          <button key={n.path} onClick={() => onSelect(n.path)}
            className={`w-full text-left px-1 py-0.5 text-[11px] flex items-center gap-1 rounded transition-colors ${
              selectedFile === n.path ? 'bg-blue-500/20 text-blue-300' : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
            }`}>
            <span className="w-3" />
            <span className="text-[10px]">{iconForFile(n.name)}</span>
            <span className="font-mono truncate flex-1">{n.name}</span>
            {n.size > 0 && <span className="text-[9px] text-gray-600 flex-shrink-0">{formatSize(n.size)}</span>}
          </button>
        )
      })}
    </>
  )
}

function iconForFile(name: string): string {
  if (name.endsWith('.tsx')) return '⚛️'
  if (name.endsWith('.ts')) return '🔷'
  if (name.endsWith('.json')) return '{ }'
  if (name === 'Dockerfile') return '🐳'
  if (name.endsWith('.html')) return '🌐'
  if (name.endsWith('.css')) return '🎨'
  if (name.endsWith('.md')) return '📝'
  if (name.endsWith('.js')) return '📒'
  return '📄'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / 1024 / 1024).toFixed(1)}M`
}

function detectLanguage(filePath: string): string {
  if (filePath.endsWith('.tsx')) return 'typescriptreact'
  if (filePath.endsWith('.ts')) return 'typescript'
  if (filePath.endsWith('.json')) return 'json'
  if (filePath.endsWith('.html')) return 'html'
  if (filePath.endsWith('.css')) return 'css'
  if (filePath.endsWith('.md')) return 'markdown'
  if (filePath.endsWith('.js')) return 'javascript'
  if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) return 'yaml'
  return 'plaintext'
}
