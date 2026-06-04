import { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useGenerationStore, useProjectStore, useAgentStore, useUIStore } from './stores'
import { api } from './api'

export default function ProcessPanel() {
  const isVisible = useUIStore(s => s.activeTab === 'process')
  const logs = useGenerationStore(s => s.logs)
  const sessions = useGenerationStore(s => s.sessions)
  const terminalText = useGenerationStore(s => s.terminalText)
  const agentTerminalTexts = useGenerationStore(s => s.agentTerminalTexts)
  const termRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const [, setTick] = useState(0)
  const [cwd, setCwd] = useState('output')
  const cmdBuf = useRef('')
  const [selectedAgentId, setSelectedAgentId] = useState<string | 'all'>('all')
  const selectedRef = useRef<string | 'all'>('all')
  const dockerState = useGenerationStore(s => s.dockerState)
  const setDockerState = useGenerationStore(s => s.setDockerState)

  const initedRef = useRef(false)
  useEffect(() => {
    if (!termRef.current || initedRef.current) return
    initedRef.current = true
    const term = new Terminal({
      rows: 28, fontSize: 13,
      fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
      theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff' },
      disableStdin: false, cursorBlink: true,
      allowProposedApi: true, smoothScrollDuration: 50
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(termRef.current)
    // Auto-fit to container width
    const fitTerm = () => { try { fitAddon.fit() } catch { /* ok */ } }
    setTimeout(fitTerm, 200)
    const obs = new ResizeObserver(fitTerm)
    obs.observe(termRef.current)

    if (terminalText) term.write(terminalText.replace(/\x1b\[[0-9;]*m/g, ''))
    term.write(`$ `)

    term.onData((data: string) => {
      if (data === '\r') {
        const cmd = cmdBuf.current.trim()
        term.write('\r\n')
        if (cmd) {
          if (cmd === 'clear' || cmd === 'cls') {
            term.clear()
            term.write(`\x1b[33mCWD: ${cwd}\x1b[0m\r\n\r\n$ `)
          } else if (cmd.startsWith('cd ')) {
            const newDir = cmd.slice(3).trim()
            setCwd(prev => {
              const next = newDir.startsWith('/') || newDir.includes(':') ? newDir : `${prev}/${newDir}`.replace(/\/\//g, '/')
              term.write(`\x1b[33mCWD: ${next}\x1b[0m\r\n\r\n$ `)
              return next
            })
          } else {
            term.write(`\x1b[33mRunning: ${cmd}\x1b[0m\r\n`)
            api.shell.exec(cwd, cmd).catch(() => term.write('\x1b[31mFailed to execute\x1b[0m\r\n'))
          }
        } else {
          term.write('$ ')
        }
        cmdBuf.current = ''
      } else if (data === '\x7f') {
        if (cmdBuf.current.length > 0) {
          cmdBuf.current = cmdBuf.current.slice(0, -1)
          term.write('\b \b')
        }
      } else if (data === '\x03') {
        term.write('^C\r\n$ ')
        cmdBuf.current = ''
      } else if (data.length === 1) {
        cmdBuf.current += data
        term.write(data)
      }
    })

    xtermRef.current = term
    return () => { obs.disconnect(); term.dispose(); xtermRef.current = null; initedRef.current = false }
  }, [])

  // Re-fit xterm when panel becomes visible (was display:none with 0 dimensions)
  useEffect(() => {
    if (isVisible && xtermRef.current) {
      setTimeout(() => { try { xtermRef.current!.resize(xtermRef.current!.cols, xtermRef.current!.rows) } catch { /* ok */ } }, 50)
    }
  }, [isVisible])

  // Tick every second for elapsed time display
  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(iv)
  }, [])

  // Switch xterm content when selected agent changes
  const switchToAgent = useCallback((agentId: string | 'all') => {
    setSelectedAgentId(agentId)
    selectedRef.current = agentId
    const term = xtermRef.current
    if (!term) return
    term.clear()
    if (agentId === 'all') {
      const t = useGenerationStore.getState().terminalText
      if (t) term.write(t)
    } else {
      const t = useGenerationStore.getState().agentTerminalTexts[agentId]
      if (t) term.write(t)
      else term.write(`\x1b[33mNo output yet for this agent. Generation may not have started.\x1b[0m\r\n`)
    }
    term.write(`\r\n\x1b[36m--- Viewing: ${agentId === 'all' ? 'All Agents' : useAgentStore.getState().agents.find(a => a.id === agentId)?.name || agentId} ---\x1b[0m\r\n$ `)
  }, [])

  // WebSocket listeners — filter by selected agent for generation events
  useEffect(() => {
    const u1 = api.on('generation:worker', (d: unknown) => {
      const msg = d as Record<string, unknown>
      if (!xtermRef.current) return
      const agentId = msg.agentId as string
      const viewing = selectedRef.current
      if (viewing !== 'all' && viewing !== agentId) return // filter when viewing specific agent
      if (msg.type === 'terminal') {
        xtermRef.current.write(msg.stream === 'stderr' ? `\x1b[31m${msg.text}\x1b[0m` : msg.text as string)
      } else if (msg.type === 'progress') {
        xtermRef.current.write(`\x1b[36m[${msg.phase}]\x1b[0m ${msg.message}\n`)
      }
    })
    const u2 = api.on('generation:done', (d: unknown) => {
      const msg = d as Record<string, unknown>
      if (!xtermRef.current) return
      const viewing = selectedRef.current
      if (viewing !== 'all' && viewing !== (msg.agentId as string)) return
      xtermRef.current.write(`${msg.status === 'completed' ? '\x1b[32mCOMPLETED\x1b[0m' : '\x1b[31mFAILED\x1b[0m'}  ${msg.agentId}\n`)
      if (msg.error) xtermRef.current.write(`\x1b[31m${msg.error}\x1b[0m\n`)
    })
    const u3 = api.on('shell:stdout', (d: unknown) => {
      const msg = d as Record<string, unknown>
      if (xtermRef.current) xtermRef.current.write(msg.text as string)
    })
    const u4 = api.on('shell:stderr', (d: unknown) => {
      const msg = d as Record<string, unknown>
      if (xtermRef.current) xtermRef.current.write(`\x1b[31m${msg.text}\x1b[0m`)
    })
    const u5 = api.on('shell:exit', (d: unknown) => {
      const msg = d as Record<string, unknown>
      if (!xtermRef.current) return
      const exitCode = msg.code as number
      if (exitCode !== 0) xtermRef.current.write(`\r\n\x1b[31mexit ${exitCode}\x1b[0m\r\n`)
      xtermRef.current.write('$ ')
    })
    return () => { u1(); u2(); u3(); u4(); u5() }
  }, [])

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [logs])

  const allAgents = useAgentStore(s => s.agents)
  const activePid = useProjectStore(s => s.activeProjectId)
  const projectAgents = useMemo(() =>
    activePid ? allAgents.filter(a => a.projectId === activePid) : allAgents,
    [allAgents, activePid])
  const agentCount = projectAgents.length
  const hasData = agentCount > 0 || logs.length > 0 || terminalText.length > 0

  // Filter logs by selected agent
  const filteredLogs = selectedAgentId === 'all'
    ? logs
    : logs.filter(l => l.agentId === selectedAgentId || l.sessionId === selectedAgentId)

  if (!hasData) {
    return (
      <div className="h-full flex items-center justify-center bg-bg">
        <div className="text-center max-w-sm px-8">
          <h3 className="text-sm font-semibold mb-2">Process Monitor</h3>
          <p className="text-[13px] text-text-secondary leading-relaxed">
            Select a project with agents to view generation and deployment progress.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-bg">
      {/* Agent tabs + inline Build/Rebuild actions */}
      <div className="flex-shrink-0 border-b border-border px-3 py-1.5 flex flex-wrap items-center gap-1.5 overflow-x-auto">
        <button
          onClick={() => switchToAgent('all')}
          className={`px-3 py-1 text-[12px] rounded-lg font-medium whitespace-nowrap transition-colors ${
            selectedAgentId === 'all'
              ? 'bg-accent text-white shadow-sm'
              : 'bg-bg-tertiary text-text-secondary hover:text-text hover:bg-border'
          }`}
        >
          All ({agentCount})
        </button>
        {projectAgents.map(a => {
          const s = sessions[a.id]
          const status = (s && s.status === 'generating') ? 'generating' : a.status as string
          const isDone = status === 'completed'
          const isFailed = status === 'failed'
          const isPending = status === 'pending'
          return (
            <div key={a.id}
              className={`flex items-center rounded-lg border transition-colors whitespace-nowrap ${
                selectedAgentId === a.id ? 'bg-accent/10 border-accent/30' : 'bg-bg-tertiary border-border'
              }`}
            >
              <button onClick={() => switchToAgent(a.id)} className="flex items-center gap-1.5 pl-2.5 pr-1 py-1">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  status === 'generating' || status === 'queued' ? 'bg-warning animate-pulse' :
                  isDone ? 'bg-success' : isFailed ? 'bg-error' : 'bg-text-tertiary'
                }`} />
                <span className="text-[12px] font-medium max-w-[120px] truncate">{a.name}</span>
                <span className={`text-[10px] ${
                  status === 'generating' || status === 'queued' ? 'text-warning' : isDone ? 'text-success' : isFailed ? 'text-error' : 'text-text-tertiary'
                }`}>{status}{s && s.status === 'generating' ? ` ${Math.floor((Date.now() - s.startTime) / 1000)}s` : ''}</span>
              </button>
              {(isPending || isFailed) && (
                <button onClick={async (e) => { e.stopPropagation()
                  try {
                    await api.agents.generateClaude(a.id)
                    useGenerationStore.getState().upsertSession({ agentId: a.id, agentName: a.name, startTime: Date.now(), status: 'generating', files: [] })
                  } catch (err) { alert('Failed: ' + (err as Error).message) }
                }} className="px-1.5 py-0.5 text-[10px] rounded bg-accent/10 text-accent hover:bg-accent/20 font-medium mr-1">Build</button>
              )}
              {isDone && (
                <button onClick={async (e) => { e.stopPropagation()
                  try {
                    await api.agents.regenerate(a.id)
                    useGenerationStore.getState().upsertSession({ agentId: a.id, agentName: a.name, startTime: Date.now(), status: 'generating', files: [] })
                  } catch (err) { alert('Failed: ' + (err as Error).message) }
                }} className="px-1.5 py-0.5 text-[10px] rounded bg-bg-tertiary text-text-tertiary hover:text-text font-medium mr-1">Re</button>
              )}
            </div>
          )
        })}
      </div>

      {/* Selected agent detail card */}
      {selectedAgentId !== 'all' && (() => {
        const agent = allAgents.find(a => a.id === selectedAgentId)
        if (!agent) return null
        const s = sessions[selectedAgentId]
        const status = (s && s.status === 'generating') ? 'generating' : agent.status
        return (
          <div className={`flex-shrink-0 px-4 py-2.5 border-b border-border/30 ${
            status === 'generating' ? 'bg-warning/5' : status === 'completed' ? 'bg-success/5' : status === 'failed' ? 'bg-error/5' : ''
          }`}>
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                status === 'generating' || status === 'queued' ? 'bg-warning animate-pulse' :
                status === 'completed' ? 'bg-success' : status === 'failed' ? 'bg-error' : 'bg-text-tertiary'
              }`} />
              <span className="text-sm font-semibold text-text">{agent.name}</span>
              <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
                status === 'generating' || status === 'queued' ? 'bg-warning/20 text-warning' :
                status === 'completed' ? 'bg-success/20 text-success' : 'bg-error/20 text-error'
              }`}>{status}</span>
            </div>
            <div className="text-[12px] text-text-secondary space-y-1 ml-5">
              <p>{agent.description || 'No description'}</p>
              {agent.outputPath && <div className="text-[11px] text-text-tertiary font-mono">{agent.outputPath}</div>}
              {agent.generationAttempts > 0 && (
                <div className="flex gap-4 flex-wrap">
                  <span><span className="text-text-tertiary">Attempts:</span> {agent.generationAttempts}/{agent.maxRetries}</span>
                  {s && <span><span className="text-text-tertiary">Files:</span> {s.files.length}</span>}
                </div>
              )}
              {s && s.files.length > 0 && (
                <div className="text-[11px] text-text-tertiary break-all leading-relaxed">{s.files.join(', ')}</div>
              )}
              {agent.errorMessage && <div className="text-error text-[12px] leading-relaxed break-all mt-1">⚠ {agent.errorMessage}</div>}
            </div>
          </div>
        )
      })()}

      {/* ============================================================ */}
      {/* Docker Deployment Wizard */}
      {/* ============================================================ */}
      <div className="border-b border-border flex-shrink-0">
        {/* Step 1: Generate YAML */}
        <div className={`px-4 py-2 flex items-center gap-3 border-b border-border/30 ${dockerState !== 'idle' ? 'bg-success/5' : ''}`}>
          <span className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[12px] font-bold ${dockerState !== 'idle' ? 'bg-success/20 text-success' : 'bg-accent/20 text-accent'}`}>
            {dockerState !== 'idle' ? '✓' : '1'}
          </span>
          <span className="text-[12px] text-text-secondary min-w-[200px]">
            <span className="font-semibold">Generate config</span>
            <span className="text-text-tertiary ml-1.5">docker-compose.yml + Dockerfiles</span>
          </span>
          <div className="flex-1" />
          <button onClick={async () => {
            const pid = useProjectStore.getState().activeProjectId
            if (!pid) {
              if (xtermRef.current) xtermRef.current.write('\x1b[31mNo active project selected in sidebar.\x1b[0m\r\n$ ')
              return
            }
            try {
              const r = await api.get<{yaml:string, agentCount:number, services:string[]}>(`/api/projects/${pid}/docker-compose`)
              const filePath = `${cwd}/docker-compose.yml`
              await api.put('/api/files', { path: filePath, content: r.yaml })
              setDockerState('generated')
              if (xtermRef.current) {
                xtermRef.current.write(`\x1b[32mGenerated docker-compose.yml\x1b[0m  \x1b[90m${r.services.length} services\x1b[0m\r\n$ `)
              }
            } catch (e) {
              if (xtermRef.current) xtermRef.current.write(`\x1b[31m✗ 失败: ${(e as Error).message}\x1b[0m\r\n$ `)
            }
          }} className={`px-3 py-1 text-[11px] rounded-md font-medium transition-colors ${
            dockerState !== 'idle'
              ? 'bg-success/10 text-success border border-success/20'
              : 'bg-accent hover:bg-accent-hover text-white'
          }`}>
            {dockerState !== 'idle' ? '✓ Generated' : '1. Generate docker-compose.yml'}
          </button>
        </div>

        {/* Step 2: Build & Start */}
        <div className={`px-4 py-2 flex items-center gap-3 border-b border-border/30 ${
          dockerState === 'running' ? 'bg-success/5' : dockerState === 'building' ? 'bg-warning/5' : dockerState === 'generated' ? 'bg-warning/5' : ''
        }`}>
          <span className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[12px] font-bold ${
            dockerState === 'running' ? 'bg-success/20 text-success' :
            dockerState === 'building' ? 'bg-warning/20 text-warning animate-pulse' :
            dockerState === 'generated' ? 'bg-warning/20 text-warning' : 'bg-bg-tertiary text-text-tertiary'
          }`}>
            {dockerState === 'running' ? '✓' : dockerState === 'building' ? '⏳' : '2'}
          </span>
          <span className="text-[12px] text-text-secondary min-w-[200px]">
            <span className="font-semibold">Build & Start</span>
            <span className="text-text-tertiary ml-1.5">docker-compose up --build -d</span>
          </span>
          <div className="flex-1" />
          <button onClick={async () => {
            if (dockerState === 'idle') {
              if (xtermRef.current) xtermRef.current.write('\x1b[33mClick Step 1 first to generate docker-compose.yml\x1b[0m\r\n$ ')
              return
            }
            if (dockerState === 'building') {
              if (xtermRef.current) xtermRef.current.write('\x1b[33mBuild in progress...\x1b[0m\r\n$ ')
              return
            }
            if (!xtermRef.current) return
            const term = xtermRef.current
            setDockerState('building')
            term.write('\x1b[36m=== Build & Start ===\x1b[0m\r\n\r\n')
            try {
              term.write('\x1b[90mLoading cached images...\x1b[0m\r\n')
              await api.shell.exec(cwd, 'cmd /c "if exist .docker-cache\\dd-base-images.tar docker load -i .docker-cache\\dd-base-images.tar"')
              const info = await api.get<{services:string[],agentCount:number}>(`/api/projects/${useProjectStore.getState().activeProjectId}/docker-compose`)
              const services = (info.services || []).filter((s: string) => s !== 'gateway')
              let ok = 0; let fail = 0
              // Build each agent Docker image independently
              for (let i = 0; i < services.length; i++) {
                const svc = services[i]
                term.write(`[${i+1}/${services.length}] \x1b[33m${svc}\x1b[0m `)
                const r = await api.shell.exec(cwd, `docker build -t ${svc}:latest ./${svc}`) as {pid:number}
                const exitCode = await new Promise<number>(resolve => {
                  const unsub = api.on('shell:exit', (d: unknown) => {
                    const msg = d as Record<string,unknown>
                    if ((msg.pid as number) === r.pid) { unsub(); resolve((msg.code as number) || 1) }
                  })
                })
                if (exitCode === 0) { ok++; term.write('\x1b[32mOK\x1b[0m\r\n') }
                else { fail++; term.write(`\x1b[31mFAILED (exit ${exitCode})\x1b[0m\r\n`) }
              }
              term.write(`\r\n\x1b[1m${ok} built, ${fail} failed\x1b[0m\r\n`)
              // Start containers
              term.write('\x1b[90mStarting containers...\x1b[0m\r\n')
              await api.shell.exec(cwd, 'docker-compose up -d')
              setDockerState('running')
              term.write('\x1b[32mContainers started\x1b[0m\r\n$ ')
            } catch (e) {
              setDockerState('generated')
              term.write(`\x1b[31mError: ${(e as Error).message}\x1b[0m\r\n$ `)
            }
          }} className={`px-3 py-1 text-[11px] rounded-md font-medium transition-colors ${
            dockerState === 'running'
              ? 'bg-success/10 text-success border border-success/20'
              : dockerState === 'building'
              ? 'bg-warning/20 text-warning border border-warning/30'
              : dockerState === 'generated'
              ? 'bg-warning hover:bg-warning/80 text-white'
              : 'bg-bg-tertiary text-text-tertiary border border-border/30'
          }`}>
            {dockerState === 'running' ? '✓ Running' :
             dockerState === 'building' ? '⏳ Building...' : '2. Build & Start'}
          </button>
        </div>

        {/* Service Status — per-agent Docker operations */}
        {dockerState === 'running' && (
          <div className="border-b border-border/30">
            <div className="px-4 py-2 border-b border-border/30 flex items-center">
              <span className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[12px] font-bold bg-bg-tertiary text-text-tertiary">3</span>
              <span className="text-[12px] font-semibold text-text-secondary ml-3">Service Status</span>
              <span className="text-[11px] text-text-tertiary ml-2">{projectAgents.length} agents</span>
              <div className="flex-1" />
              <button onClick={() => {
                if (xtermRef.current) xtermRef.current.write('\x1b[36mdocker-compose ps\x1b[0m\r\n')
                api.shell.exec(cwd, 'docker-compose ps').catch(() => {})
              }} className="px-2 py-0.5 text-[10px] rounded bg-bg-tertiary text-text-tertiary hover:text-text">ps</button>
              <button onClick={() => {
                if (xtermRef.current) xtermRef.current.write('\x1b[36mdocker-compose down\x1b[0m\r\n')
                api.shell.exec(cwd, 'docker-compose down').catch(() => {})
                setDockerState('generated')
              }} className="px-2 py-0.5 text-[10px] rounded bg-error/10 text-error hover:bg-error/20 ml-1.5">stop all</button>
            </div>
            <div className="max-h-[200px] overflow-y-auto">
              {projectAgents.map(a => {
                const s = sessions[a.id]
                const status = (s && s.status === 'generating') ? 'generating' : a.status
                const svcName = a.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
                return (
                  <div key={a.id} className="px-4 py-1.5 border-b border-border/30 flex items-center gap-2 hover:bg-bg-tertiary/50 transition-colors">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      status === 'completed' ? 'bg-success' : status === 'generating' || status === 'queued' ? 'bg-warning animate-pulse' : status === 'failed' ? 'bg-error' : 'bg-text-tertiary'
                    }`} />
                    <span className="text-[11px] text-text-secondary flex-1 truncate">{a.name}</span>
                    <span className={`text-[10px] flex-shrink-0 ${status === 'completed' ? 'text-success' : status === 'failed' ? 'text-error' : 'text-text-tertiary'}`}>{status}</span>
                    <button onClick={() => {
                      if (xtermRef.current) { xtermRef.current.write(`\x1b[36mdocker logs ${svcName} --tail=30\x1b[0m\r\n`); api.shell.exec(cwd, `docker logs ${svcName} --tail=30`).catch(() => {}) }
                    }} className="px-1.5 py-0.5 text-[10px] rounded bg-bg-tertiary text-text-tertiary hover:text-text flex-shrink-0">Logs</button>
                    <button onClick={() => {
                      if (xtermRef.current) { xtermRef.current.write(`\x1b[36mdocker restart ${svcName}\x1b[0m\r\n`); api.shell.exec(cwd, `docker restart ${svcName}`).catch(() => {}) }
                    }} className="px-1.5 py-0.5 text-[10px] rounded bg-bg-tertiary text-text-tertiary hover:text-text flex-shrink-0">Restart</button>
                    <button onClick={() => {
                      if (!xtermRef.current) return
                      const term = xtermRef.current
                      term.write(`\x1b[36mRebuild ${svcName}\x1b[0m\r\n`)
                      api.shell.exec(cwd, `docker build -t ${svcName}:latest ./${svcName}`).then((r: unknown) => {
                        const pid = (r as {pid:number}).pid
                        let done = false
                        const unsub = api.on('shell:exit', (d: unknown) => {
                          if (done) return; done = true; unsub()
                          const msg = d as Record<string,unknown>
                          if ((msg.pid as number) === pid) {
                            if ((msg.code as number) === 0) {
                              term.write(`\x1b[32mBuild OK, restarting...\x1b[0m\r\n`)
                              api.shell.exec(cwd, `docker-compose up -d ${svcName}`).catch(() => {})
                            } else { term.write(`\x1b[31mBuild failed\x1b[0m\r\n`) }
                            term.write('$ ')
                          }
                        })
                        setTimeout(() => { if (!done) { done = true; unsub(); term.write('\x1b[33mBuild timed out\x1b[0m\r\n$ ') } }, 120000)
                      }).catch(() => { term.write(`\x1b[31mBuild error\x1b[0m\r\n$ `) })
                    }} className="px-1.5 py-0.5 text-[10px] rounded bg-accent/10 text-accent hover:bg-accent/20 flex-shrink-0">Rebuild</button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Stop All */}
        <div className="px-4 py-2 flex items-center gap-3">
          <span className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[12px] font-bold bg-bg-tertiary text-text-tertiary">{dockerState === 'running' ? '4' : '3'}</span>
          <span className="text-[12px] text-text-secondary min-w-[200px]">
            <span className="font-semibold">Stop all</span>
            <span className="text-text-tertiary ml-1.5">docker-compose down</span>
          </span>
          <div className="flex-1" />
          <button onClick={() => {
            if (xtermRef.current) xtermRef.current.write('\x1b[36mdocker-compose down\x1b[0m\r\n')
            api.shell.exec(cwd, 'docker-compose down').catch(() => {})
            setDockerState('generated')
          }} className="px-3 py-1 text-[11px] rounded-md font-medium bg-error/10 hover:bg-error/20 text-error border border-error/20 transition-colors">
            down
          </button>
        </div>
      </div>

      {/* Terminal */}
      <div ref={termRef} className="flex-1 min-h-0 overflow-hidden border-b border-border" />

      {/* Activity log */}
      <div className="max-h-28 overflow-y-auto flex-shrink-0" ref={logRef}>
        {filteredLogs.length === 0 ? (
          <div className="px-4 py-3 text-[12px] text-text-tertiary text-center">
            {selectedAgentId !== 'all' ? 'No logs for this agent yet.' : 'No activity logs yet.'}
          </div>
        ) : (
          filteredLogs.slice(-60).reverse().map(l => (
            <div key={l.id} className={`px-4 py-1.5 text-[11px] border-b border-border/30 flex gap-3 items-start ${l.logLevel === 'error' ? 'bg-error/5' : l.logLevel === 'warn' ? 'bg-warning/5' : ''}`}>
              <span className="text-text-tertiary w-16 flex-shrink-0 pt-px">{l.createdAt ? new Date(l.createdAt).toLocaleTimeString() : ''}</span>
              <span className={`flex-shrink-0 uppercase font-medium w-12 ${
                l.logLevel === 'error' ? 'text-error' :
                l.logLevel === 'warn' ? 'text-warning' : 'text-text-tertiary'
              }`}>[{l.logLevel}]</span>
              <span className={`flex-1 leading-relaxed break-all ${
                l.logLevel === 'error' ? 'text-error' :
                l.logLevel === 'warn' ? 'text-warning' : 'text-text-secondary'
              }`}>{l.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
