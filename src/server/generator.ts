// ============================================================
// Generator Manager — spawns worker processes, collects output,
// broadcasts to frontend via WebSocket, updates DB.
// ============================================================
import { spawn } from 'child_process'
import { indexAgentCode } from './rag'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs'
import type { WebSocket } from 'ws'
import { getDB, saveDB } from './db'
import type { CodeGenConstraints } from '../shared/types'
import { DEFAULT_CONSTRAINTS } from '../shared/types'
import { enqueue, claimJob, markRunning, completeJob, failJob, heartbeatJob, releaseExpiredLeases, queueStats, type QueueType, type QueueJob } from './queue'
import { logger, logGeneration } from './log'
import { randomUUID } from 'crypto'

// ---- Checkpoint helper ----
function writeCheckpoint(agentId: string, sessionId: string, phase: string, data: Record<string, unknown> = {}) {
  try {
    const db = getDB()
    db.prepare(`INSERT INTO generation_checkpoints (id,agent_id,session_id,phase,checkpoint_json,created_at)
      VALUES (?,?,?,?,?,?)`)
      .run(randomUUID(), agentId, sessionId, phase, JSON.stringify(data), new Date().toISOString())
  } catch { /* best-effort — don't fail generation for checkpoint error */ }
}

function buildConstraints(projectId: string | null): CodeGenConstraints {
  const constraints: CodeGenConstraints = {
    packageAllowlist: [...DEFAULT_CONSTRAINTS.packageAllowlist],
    moduleRules: DEFAULT_CONSTRAINTS.moduleRules.map(r => ({ ...r })),
    requiredFiles: [...DEFAULT_CONSTRAINTS.requiredFiles],
    responseFormat: { ...DEFAULT_CONSTRAINTS.responseFormat },
    extraDependencies: []
  }
  if (projectId) {
    const db = getDB()
    const project = db.prepare('SELECT rules FROM projects WHERE id=?').get(projectId) as Record<string, unknown> | undefined
    const rules = (project?.rules as string) || ''
    if (rules) {
      const pkgMatch = rules.match(/packages?:\s*(.+)/i)
      if (pkgMatch) {
        const extras = pkgMatch[1].split(/[,;\s]+/).filter(Boolean)
        for (const p of extras) {
          if (!constraints.packageAllowlist.includes(p)) {
            constraints.packageAllowlist.push(p)
            constraints.extraDependencies.push(p)
          }
        }
      }
    }
  }
  return constraints
}

const MAX_CONCURRENT = 2

interface GenJob {
  agentId: string
  specFile: string
  process: ReturnType<typeof spawn>
  leaseToken: string
  heartbeatTimer: ReturnType<typeof setInterval>
}

const running = new Map<string, GenJob>()
const agentOutDirs = new Map<string, string>()

// ---- Queue Poller ----
let pollerTimer: ReturnType<typeof setInterval> | null = null
let pollerWss: Set<WebSocket> | null = null

export function startQueuePoller(wssClients: Set<WebSocket>) {
  if (pollerTimer) return
  pollerWss = wssClients
  // Release any expired leases from previous crash
  const released = releaseExpiredLeases()
  if (released > 0) console.log(`[queue] Released ${released} expired leases on startup`)

  pollerTimer = setInterval(() => {
    if (isShuttingDown) return
    try {
      releaseExpiredLeases()
      pollQueue(wssClients)
    } catch (e) {
      logger.error({ err: e }, 'queue poller error')
    }
  }, 2000)
  logger.info('queue poller started')
}

function pollQueue(wssClients: Set<WebSocket>) {
  while (running.size < MAX_CONCURRENT) {
    const job = claimJob(MAX_CONCURRENT, running.size)
    if (!job) break
    const db = getDB()
    const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(job.agentId) as Record<string,unknown> | undefined
    if (!agent) { failJob(job.leaseToken!, 'Agent not found'); continue }

    const project = agent.project_id
      ? db.prepare('SELECT * FROM projects WHERE id=?').get(agent.project_id as string) as Record<string,unknown> | undefined
      : null

    const outDir = agentOutDirs.get(job.agentId) || (project?.output_path as string) || 'output'
    agentOutDirs.set(job.agentId, outDir)

    const constraints = buildConstraints((agent.project_id as string) || null)

    // Build sibling agent context
    const projectAgentsContext: Record<string, unknown>[] = []
    if (agent.project_id) {
      const siblings = db.prepare('SELECT * FROM agents WHERE project_id=? AND id!=?').all(agent.project_id, job.agentId) as Record<string,unknown>[]
      for (const sib of siblings) {
        try {
          const sibSpec = JSON.parse((sib.spec_json as string) || '{}')
          const sibIface = JSON.parse((sib.interface_json as string) || '{}')
          const sibName = (sib.name as string).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
          projectAgentsContext.push({
            id: sib.id, name: sib.name, description: sib.description, status: sib.status,
            responsibilities: sibSpec.responsibilities || [], technologies: sibSpec.technologies || [],
            inputs: sibIface.inputs || [], outputs: sibIface.outputs || [],
            envVar: sibName.toUpperCase().replace(/-/g, '_') + '_URL', serviceName: sibName,
          })
        } catch { /* skip */ }
      }
    }

    // Write spec file to disk
    const specData = {
      agentId: job.agentId, agentName: agent.name, agentDescription: agent.description,
      specJson: agent.spec_json, interfaceJson: agent.interface_json,
      outputDir: outDir, dockerRegistry: (db.prepare("SELECT value FROM settings WHERE key='dockerRegistry'").get() as Record<string,unknown> | undefined)?.value as string || '',
      constraints, projectAgents: projectAgentsContext,
    }
    const tmpDir = join(outDir, '.gen-tmp')
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
    const specFile = join(tmpDir, `claude-agent-${job.agentId.slice(0, 8)}.json`)
    writeFileSync(specFile, JSON.stringify(specData, null, 2), 'utf-8')

    // Checkpoint: spec written, about to spawn worker
    writeCheckpoint(job.agentId, job.leaseToken!, 'init', { outputDir: outDir, specFile })
    spawnClaudeWorker(job.agentId, specFile, job.leaseToken!, wssClients)
  }
}

export function startGenerationClaude(agentId: string, outputDir: string, wssClients: Set<WebSocket>) {
  agentOutDirs.set(agentId, outputDir)
  const job = enqueue(agentId, 'claude_code', { outputDir })
  if (job) {
    logGeneration({ sessionId: job.id, agentId, level: 'info', message: 'Agent enqueued for Claude Code generation', phase: 'init' })
  }
  // Ensure poller is running
  if (!pollerTimer) startQueuePoller(wssClients)
  // Trigger immediate poll
  pollQueue(wssClients)
}

function spawnClaudeWorker(agentId: string, specFile: string, leaseToken: string, wssClients: Set<WebSocket>) {
  const db = getDB()
  db.prepare("UPDATE agents SET status='generating', updated_at=? WHERE id=?").run(new Date().toISOString(), agentId)
  saveDB()

  markRunning(leaseToken)

  // Heartbeat every 60s to keep the lease alive for long runs
  const heartbeatTimer = setInterval(() => { try { heartbeatJob(leaseToken) } catch { /* ignore */ } }, 60_000)

  const broadcast = (type: string, payload: unknown) => {
    const msg = JSON.stringify({ type, payload })
    for (const ws of wssClients) { if (ws.readyState === 1) ws.send(msg) }
  }

  broadcast('agent:updated', { agent: db.prepare('SELECT * FROM agents WHERE id=?').get(agentId) })

  const workerPath = join(process.cwd(), 'generator-worker', 'claude-worker.ts')
  const child = spawn(process.execPath, ['--require', 'tsx/cjs', workerPath, specFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd()
  })

  running.set(agentId, { agentId, specFile, process: child, leaseToken, heartbeatTimer })

  // Checkpoint: worker spawned
  writeCheckpoint(agentId, leaseToken, 'generate', { specFile })

  let buffer = ''
  let hasFiles = false
  let lastError = ''

  child.stdout.on('data', (data: Buffer) => {
    buffer += data.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        broadcast('generation:worker', { agentId, ...msg })
        if (msg.type === 'file:generated') hasFiles = true
        if (msg.type === 'result') {
          if (msg.outputDir && msg.success) {
            getDB().prepare('UPDATE agents SET output_path=?, updated_at=? WHERE id=?')
              .run(msg.outputDir as string, new Date().toISOString(), agentId)
            saveDB()
          }
          if (!msg.success && msg.error) lastError = msg.error as string
        }
      } catch { /* partial line */ }
    }
  })

  child.stderr.on('data', (data: Buffer) => {
    broadcast('generation:worker', { agentId, type: 'terminal', text: data.toString(), stream: 'stderr', timestamp: Date.now() })
  })

  child.on('close', async (code) => {
    const j = running.get(agentId)
    if (j) { clearInterval(j.heartbeatTimer); running.delete(agentId) }
    const genOutDir = agentOutDirs.get(agentId) || 'output'
    try { unlinkSync(specFile) } catch { /* ok */ }

    const genOk = code === 0 && hasFiles
    const status = genOk ? 'completed' : 'failed'

    let errMsg = ''
    if (!hasFiles && code === 0) errMsg = lastError || 'No files generated - Claude Code did not produce FILE markers'
    else if (code !== 0) errMsg = lastError || `Claude Code exited with code ${code}`

    // --- Validate Phase: run test pipeline on successful generation ---
    let testPassed = true
    if (genOk) {
      const agentName_ = (db.prepare('SELECT name FROM agents WHERE id=?').get(agentId) as Record<string,unknown> | undefined)?.name as string || ''
      const agentDir = join(genOutDir, agentName_.replace(/[^a-zA-Z0-9一-鿿_-]/g, '-'))

      // Set to validating
      db.prepare("UPDATE agents SET status='validating', updated_at=? WHERE id=?").run(new Date().toISOString(), agentId)
      saveDB()
      broadcast('agent:updated', { agent: db.prepare('SELECT * FROM agents WHERE id=?').get(agentId) })

      writeCheckpoint(agentId, leaseToken, 'validate', { outputDir: genOutDir, agentDir })

      // Run test pipeline (install + compile + vitest)
      const { runTestPipeline } = await import('./test-runner')
      const pipeResult = await runTestPipeline(agentId, agentDir, leaseToken, broadcast)

      if (!pipeResult.passed) {
        // Run fix loop
        const { runFixLoop } = await import('./fix-dispatcher')
        testPassed = await runFixLoop(agentId, agentDir, leaseToken, wssClients, broadcast)

        if (!testPassed) {
          db.prepare("UPDATE agents SET status='failed', error_message=?, updated_at=? WHERE id=?")
            .run('Tests failed after max fix attempts — manual review needed', new Date().toISOString(), agentId)
          saveDB()
          failJob(leaseToken, 'Tests failed after ' + 3 + ' fix attempts')
          writeCheckpoint(agentId, leaseToken, 'complete', { status: 'failed', error: 'Tests failed after fix loop' })
          broadcast('agent:updated', { agent: db.prepare('SELECT * FROM agents WHERE id=?').get(agentId) })
          broadcast('generation:done', { agentId, exitCode: code, status: 'failed', error: 'Tests failed after fix loop' })
          return
        }
      }

      writeCheckpoint(agentId, leaseToken, 'package', { testPassed })
      indexAgentCode(agentId, agentDir, agentName_).catch(() => {})
    }

    // Finalize status
    const finalStatus = genOk ? 'completed' : 'failed'
    db.prepare('UPDATE agents SET status=?, updated_at=? WHERE id=?').run(finalStatus, new Date().toISOString(), agentId)
    if (errMsg) {
      db.prepare('UPDATE agents SET error_message=?, updated_at=? WHERE id=?')
        .run(errMsg, new Date().toISOString(), agentId)
    }
    saveDB()

    if (finalStatus === 'failed') {
      failJob(leaseToken, errMsg)
      logGeneration({ sessionId: leaseToken, agentId, level: 'error', message: errMsg, phase: 'generate' })
    } else {
      completeJob(leaseToken)
      logGeneration({ sessionId: leaseToken, agentId, level: 'info', message: 'Generation + tests completed', phase: 'complete' })
    }

    writeCheckpoint(agentId, leaseToken, 'complete', { status: finalStatus, error: errMsg, hasFiles, testPassed })
    broadcast('agent:updated', { agent: db.prepare('SELECT * FROM agents WHERE id=?').get(agentId) })
    broadcast('generation:done', { agentId, exitCode: code, status: finalStatus, error: errMsg, testPassed })
  })

  child.on('error', (err) => {
    const j = running.get(agentId)
    if (j) { clearInterval(j.heartbeatTimer); running.delete(agentId) }
    try { unlinkSync(specFile) } catch { /* ok */ }
    db.prepare("UPDATE agents SET status='failed', error_message=?, updated_at=? WHERE id=?").run(err.message, new Date().toISOString(), agentId)
    saveDB()
    failJob(leaseToken, err.message)
    writeCheckpoint(agentId, leaseToken, 'complete', { status: 'failed', error: err.message })
    logGeneration({ sessionId: leaseToken, agentId, level: 'error', message: err.message, phase: 'generate' })
    broadcast('agent:updated', { agent: db.prepare('SELECT * FROM agents WHERE id=?').get(agentId) })
    broadcast('generation:done', { agentId, error: err.message, status: 'failed' })
  })
}

// Separate in-memory queue for LLM API path (avoids storing API keys in DB)
const apiQueue: Array<{ agentId: string; specFile: string }> = []

export function startGeneration(
  agentId: string,
  llmConfig: Record<string, unknown>,
  outputDir: string,
  wssClients: Set<WebSocket>
) {
  const db = getDB()

  // Get agent from DB
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(agentId) as Record<string,unknown> | undefined
  if (!agent) return

  const project = agent.project_id
    ? db.prepare('SELECT * FROM projects WHERE id=?').get(agent.project_id as string) as Record<string,unknown> | undefined
    : null

  // Read docker registry mirror from settings
  const apiOutDir = outputDir || (project?.output_path as string) || 'output'
  const dockerRegistry2 = (db.prepare("SELECT value FROM settings WHERE key='dockerRegistry'").get() as Record<string,unknown> | undefined)?.value as string || ''

  // Build constraints
  const constraints = buildConstraints((agent.project_id as string) || null)

  // Build project agent context for dependency awareness
  const apiProjectAgents: Record<string, unknown>[] = []
  if (agent.project_id) {
    const siblings = db.prepare('SELECT * FROM agents WHERE project_id=? AND id!=?').all(agent.project_id, agentId) as Record<string,unknown>[]
    for (const sib of siblings) {
      try {
        const sibSpec = JSON.parse((sib.spec_json as string) || '{}')
        const sibIface = JSON.parse((sib.interface_json as string) || '{}')
        const sibName = (sib.name as string).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
        apiProjectAgents.push({
          id: sib.id, name: sib.name, description: sib.description, status: sib.status,
          responsibilities: sibSpec.responsibilities || [], technologies: sibSpec.technologies || [],
          inputs: sibIface.inputs || [], outputs: sibIface.outputs || [],
          envVar: sibName.toUpperCase().replace(/-/g, '_') + '_URL',
          serviceName: sibName,
        })
      } catch { /* skip */ }
    }
  }

  // Prepare spec file
  const specData = {
    agentId,
    agentName: agent.name,
    agentDescription: agent.description,
    specJson: agent.spec_json,
    interfaceJson: agent.interface_json,
    outputDir: apiOutDir,
    llmConfig,
    dockerRegistry: dockerRegistry2,
    constraints,
    projectAgents: apiProjectAgents,
  }

  const tmpDir = join(apiOutDir, '.gen-tmp')
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
  const specFile = join(tmpDir, `agent-${agentId.slice(0, 8)}.json`)
  writeFileSync(specFile, JSON.stringify(specData, null, 2), 'utf-8')

  // Enqueue or spawn (in-memory only for LLM API path — avoids storing API keys)
  apiQueue.push({ agentId, specFile })
  processApiQueue(wssClients)
}

function processApiQueue(wssClients: Set<WebSocket>) {
  while (running.size < MAX_CONCURRENT && apiQueue.length > 0) {
    const job = apiQueue.shift()!
    spawnApiWorker(job.agentId, job.specFile, wssClients)
  }
}

function spawnApiWorker(agentId: string, specFile: string, wssClients: Set<WebSocket>) {
  const db = getDB()

  // Update agent status
  db.prepare("UPDATE agents SET status='generating', updated_at=? WHERE id=?").run(new Date().toISOString(), agentId)
  saveDB()

  const broadcast = (type: string, payload: unknown) => {
    const msg = JSON.stringify({ type, payload })
    for (const ws of wssClients) { if (ws.readyState === 1) ws.send(msg) }
  }

  broadcast('agent:updated', { agent: db.prepare('SELECT * FROM agents WHERE id=?').get(agentId) })

  const workerPath = join(process.cwd(), 'generator-worker', 'index.ts')
  const child = spawn(process.execPath, ['--require', 'tsx/cjs', workerPath, specFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd()
  })

  // Use placeholder lease token for API path (not queued in DB)
  const dummyLease = 'api-' + Date.now().toString(36)
  const dummyHeartbeat = setInterval(() => {}, 60_000)
  running.set(agentId, { agentId, specFile, process: child, leaseToken: dummyLease, heartbeatTimer: dummyHeartbeat })

  let buffer = ''

  child.stdout.on('data', (data: Buffer) => {
    buffer += data.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        broadcast('generation:worker', { agentId, ...msg })
        // Write output path immediately when result arrives
        if (msg.type === 'result' && msg.outputDir) {
          const db2 = getDB()
          db2.prepare('UPDATE agents SET output_path=?, updated_at=? WHERE id=?')
            .run(msg.outputDir as string, new Date().toISOString(), agentId)
          saveDB()
        }
      } catch { /* partial line */ }
    }
  })

  child.stderr.on('data', (data: Buffer) => {
    broadcast('generation:worker', {
      agentId,
      type: 'terminal',
      text: data.toString(),
      stream: 'stderr',
      timestamp: Date.now()
    })
  })

  child.on('close', (code) => {
    const j = running.get(agentId)
    if (j) { clearInterval(j.heartbeatTimer); running.delete(agentId) }
    try { unlinkSync(specFile) } catch { /* ok */ }

    const status = code === 0 ? 'completed' : 'failed'
    db.prepare('UPDATE agents SET status=?, updated_at=? WHERE id=?').run(status, new Date().toISOString(), agentId)
    if (code !== 0) {
      db.prepare('UPDATE agents SET error_message=?, updated_at=? WHERE id=?')
        .run(`Worker exited with code ${code}`, new Date().toISOString(), agentId)
    }
    saveDB()

    broadcast('agent:updated', { agent: db.prepare('SELECT * FROM agents WHERE id=?').get(agentId) })
    broadcast('generation:done', { agentId, exitCode: code, status })

    // Process next in queue
    processApiQueue(wssClients)
  })

  child.on('error', (err) => {
    const j = running.get(agentId)
    if (j) { clearInterval(j.heartbeatTimer); running.delete(agentId) }
    try { unlinkSync(specFile) } catch { /* ok */ }

    db.prepare("UPDATE agents SET status='failed', error_message=?, updated_at=? WHERE id=?").run(err.message, new Date().toISOString(), agentId)
    saveDB()

    broadcast('agent:updated', { agent: db.prepare('SELECT * FROM agents WHERE id=?').get(agentId) })
    broadcast('generation:done', { agentId, error: err.message, status: 'failed' })

    processApiQueue(wssClients)
  })
}

export function generateAllAgents(
  agentIds: string[],
  llmConfig: Record<string, unknown>,
  outputDir: string,
  wssClients: Set<WebSocket>
) {
  for (const id of agentIds) {
    startGenerationClaude(id, outputDir, wssClients)
  }
}

// ---- Claude Code Action Mode — spawns Claude Code CLI with MCP tools ----
export interface ActionParams {
  conversationId: string
  messageId: string
  prompt: string
  projectId?: string | null
  outputDir: string
  signal?: AbortSignal
}

export function startClaudeCodeAction(
  params: ActionParams,
  wssClients: Set<WebSocket>
) {
  const { conversationId, messageId, prompt, projectId, outputDir, signal } = params
  const db = getDB()

  const broadcast = (type: string, payload: unknown) => {
    const msg = JSON.stringify({ type, payload })
    for (const ws of wssClients) { if (ws.readyState === 1) ws.send(msg) }
  }

  // Build system prompt with full project context
  let sysPrompt = `You operate OpenBlueprint — a visual platform for building multi-agent microservice systems. You have MCP tools to manage agents, read/write/modify source code, run shell commands, and manage Docker.

## TOOLS SUMMARY
- Agent management: list_agents, create_agent, update_agent, delete_agent, get_project_context
- Relationships: create_relationship, delete_relationship, analyze_relationships (use after creating ALL agents!)
- Code reading: list_agent_files (flat list), list_file_tree (recursive tree), read_file
- Code writing: write_file
- Shell: exec_shell (npm install, tsc, docker, etc.)

## RELATIONSHIP TYPES (use ALL three when creating agents)
- dependencies: Agent A needs Agent B to START. If A calls B's API, list B as a dependency.
- communicatesWith: Agents exchange data at RUNTIME. If A calls B's API or B calls A's, list as communicatesWith.
- sharesData: Agents share a data store or event stream (same DB, MQTT topic, Redis channel).

A single agent pair often needs MULTIPLE types. Example: api-gateway depends_on auth-service AND communicatesWith auth-service.

## RULES
1. ALWAYS call list_agents or get_project_context FIRST before making changes. Never guess.
2. When creating agents: set dependencies, communicatesWith, AND sharesData fields. Review each agent's inputs/outputs to identify ALL three relationship types.
3. After creating ALL agents: MANDATORY — call analyze_relationships(projectId) to auto-analyze and create all relationships. This is CRITICAL for correct build order.
4. When modifying an agent's CODE: first call list_agent_files(agentId) to see what files exist, then read_file to inspect the code, then write_file to make changes.
5. After writing code: run exec_shell to verify (e.g., "cd <agent-dir> && npx tsc --noEmit").
6. When user says "delete duplicates" or "remove X": first list agents, IDENTIFY duplicates by comparing names/descriptions, then delete redundant ones.
7. When user says "create", "add", "modify", "rename", "change": use the appropriate tool immediately.
8. After making changes, VERIFY by listing agents again.
9. Agent IDs are the exact string from list_agents results (e.g., "api-gateway-3b8caa"). Use them exactly.
10. NEVER create an agent with the same name as an existing one — use update_agent instead.
11. Explain what you're doing clearly, then execute. Match the user's language.`

  if (projectId) {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as Record<string,unknown> | undefined
    const agents = db.prepare('SELECT id, name, description, status FROM agents WHERE project_id=?').all(projectId) as Record<string,unknown>[]
    sysPrompt += `\n\n## CURRENT PROJECT
Project: ${project?.name || 'Unknown'} (${projectId})
Agents: ${agents.length > 0 ? agents.map(a => `${a.name} (${a.id}, ${a.status})`).join('; ') : 'None yet.'}
`
    const rules = (project?.rules as string) || ''
    if (rules) sysPrompt += `Project Rules: ${rules}\n`
  }

  // Resolve MCP config to absolute path
  const mcpConfigPath = join(process.cwd(), 'mcp-config.json')

  // Combine system prompt into -p arg (avoids cmd.exe command-line length limits)
  const fullPrompt = sysPrompt + '\n\n---\n\nUser: ' + prompt

  // Spawn Claude Code with MCP config and stream-json output
  const args = [
    '-p', fullPrompt,
    '--print',
    '--mcp-config', mcpConfigPath,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--include-partial-messages',
  ]

  // Spawn claude.exe directly on Windows (not cmd.exe) to avoid command-line length limits
  const isWin = process.platform === 'win32'
  const claudeExe = isWin
    ? join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    : 'claude'
  const child = spawn(claudeExe, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: process.cwd() })

  // Track final message text for DB save
  let messageContent = ''
  let toolCalls: Array<{ name: string; input: unknown; result?: unknown; status: string; toolUseId?: string }> = []

  // Process a single JSON line from stream-json output
  const processEvent = (line: string) => {
    if (!line.trim()) return
    try {
      const event = JSON.parse(line)
      const etype = event.type as string

      if (etype === 'system') {
        broadcast('action:system', { conversationId, messageId, mcpServers: event.mcp_servers, model: event.model })
      } else if (etype === 'assistant') {
        const contents = Array.isArray(event.message?.content) ? event.message.content : (event.message?.content ? [event.message.content] : [])
        for (const block of contents) {
          if (block.type === 'text' && block.text) {
            messageContent = block.text
            broadcast('action:thinking', { conversationId, messageId, text: block.text })
          } else if (block.type === 'thinking' && block.thinking) {
            broadcast('action:thinking', { conversationId, messageId, text: (block.thinking as string).split('\n')[0] })
          } else if (block.type === 'tool_use') {
            const ti = toolCalls.length
            toolCalls.push({ name: block.name || '', input: block.input || {}, status: 'running', toolUseId: block.id as string || '' })
            broadcast('action:tool-use', { conversationId, messageId, name: block.name, input: block.input, toolIndex: ti })
          }
        }
      } else if (etype === 'user') {
        const contents = Array.isArray(event.message?.content) ? event.message.content : []
        for (const block of contents) {
          if (block.type === 'tool_result') {
            const resultText = Array.isArray(block.content)
              ? block.content.map((c: { type: string; text?: string }) => c.text || '').join('')
              : (typeof block.content === 'string' ? block.content : JSON.stringify(block.content))
            // Match tool result by tool_use_id (not first-running)
            const tId = block.tool_use_id as string || ''
            const call = tId ? toolCalls.find(tc => tc.toolUseId === tId) : toolCalls.find(tc => tc.status === 'running')
            if (call) { call.result = resultText; call.status = 'completed' }
            broadcast('action:tool-result', { conversationId, messageId, toolUseId: tId, result: resultText, isError: block.is_error })
          }
        }
      } else if (etype === 'result') {
        if (event.result) messageContent = event.result as string || messageContent
      }
    } catch { /* partial line */ }
  }

  let buffer = ''
  child.stdout.on('data', (data: Buffer) => {
    buffer += data.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) processEvent(line)
  })

  child.stdout.on('end', () => {
    if (buffer.trim()) processEvent(buffer)
    buffer = ''
  })

  child.stderr.on('data', (data: Buffer) => {
    // Forward stderr as terminal output for debugging
    const text = data.toString()
    if (text.trim()) {
      broadcast('action:terminal', { conversationId, messageId, text })
    }
  })

  let settled = false

  child.on('error', (err) => {
    if (settled) return; settled = true
    db.prepare('UPDATE messages SET content=? WHERE id=?').run('Action failed: ' + err.message, messageId)
    saveDB()
    broadcast('action:error', { conversationId, messageId, error: `Claude Code failed to start: ${err.message}` })
    broadcast('action:done', { conversationId, messageId, exitCode: -1, error: err.message, status: 'failed' })
  })

  child.on('close', (code) => {
    if (settled) return; settled = true
    const status = code === 0 ? 'completed' : 'failed'
    const finalContent = messageContent || (status === 'completed' ? 'Action completed.' : 'Action failed.')
    db.prepare('UPDATE messages SET content=? WHERE id=?').run(finalContent, messageId)
    saveDB()
    broadcast('action:done', {
      conversationId,
      messageId,
      exitCode: code === null ? -1 : code,
      status,
      content: finalContent,
      toolCalls,
    })
  })

  // Handle abort (user clicks Stop)
  if (signal) {
    const onAbort = () => {
      if (settled) return; settled = true
      try { child.kill() } catch { /* ok */ }
      db.prepare('UPDATE messages SET content=? WHERE id=?').run(messageContent || 'Action stopped by user.', messageId)
      saveDB()
      broadcast('action:done', { conversationId, messageId, exitCode: -1, status: 'stopped', content: messageContent })
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }
}

// ---- Graceful Shutdown Support ----
export let isShuttingDown = false

export function setShuttingDown() { isShuttingDown = true }

export async function drain(timeoutMs: number): Promise<void> {
  if (running.size === 0) return
  const promises: Promise<void>[] = []
  for (const [agentId, job] of running) {
    promises.push(new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        try { job.process.kill('SIGKILL') } catch { /* already dead */ }
        resolve()
      }, timeoutMs)
      job.process.on('close', () => {
        clearTimeout(timer)
        resolve()
      })
      try { job.process.kill('SIGTERM') } catch { /* already dead */ }
    }))
  }
  await Promise.all(promises)
}
