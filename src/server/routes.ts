// ============================================================
// All API Routes
// Key principle: every mutation writes to DB immediately.
// No event bus. Chat streaming uses direct WebSocket send.
// ============================================================
import { type Express, type Request, type Response } from 'express'
import { randomUUID } from 'crypto'
import type { WebSocket } from 'ws'
import { getDB, saveDB } from './db'
import { createLLMProvider, createDecomposer } from './llm'
import { startGeneration, generateAllAgents, startGenerationClaude, startClaudeCodeAction } from './generator'
import { rememberMessage, getRecentContext } from './memory'
import { indexMessage, retrieveContext } from './rag'
import type { LLMConfig } from '../shared/types'

const { stringify } = JSON

export function registerRoutes(app: Express, wssClients: Set<WebSocket>, onShutdown: () => void, onRestart: () => void) {
  const db = getDB()
  const activeStreams = new Map<string, AbortController>()
  const broadcast = (type: string, payload: unknown) => {
    const msg = stringify({ type, payload })
    for (const ws of wssClients) { if (ws.readyState === 1) ws.send(msg) }
  }
  const rnd = () => randomUUID()
  const now = () => new Date().toISOString()

  // ---- Error handling: JSON parse errors ----
  app.use((err: Error, _req: Request, res: Response, next: (err?: Error) => void) => {
    if ((err as Record<string,unknown>).type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Invalid JSON in request body', detail: err.message })
    }
    next(err)
  })

  // ---- Health ----
  app.get('/api/ping', (_req, res) => res.json({ status: 'pong' }))

  // ---- System ----
  app.post('/api/shutdown', (_req, res) => { res.json({ message: 'Shutting down...' }); setTimeout(onShutdown, 300) })
  app.post('/api/restart', (_req, res) => { res.json({ message: 'Restarting...' }); setTimeout(onRestart, 300) })

  // ========================================
  // PROJECTS
  // ========================================
  app.post('/api/projects', (req, res) => {
    const { name, description, mode, outputPath, parentId, rules } = req.body
    const projectMode = mode || 'project'
    if (!['project', 'standalone'].includes(projectMode)) {
      return res.status(400).json({ error: `Invalid mode '${projectMode}'. Must be 'project' or 'standalone'` })
    }
    const id = rnd(); const t = now()
    db.prepare('INSERT INTO projects (id,name,description,rules,output_path,status,mode,parent_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, name, description || '', rules || '', outputPath || 'output', 'idle', projectMode, parentId || null, t, t)
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(id)
    saveDB(); res.json(p)
  })

  app.get('/api/projects', (_req, res) => {
    res.json(db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all())
  })

  app.get('/api/projects/:id', (req, res) => {
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id)
    if (!p) return res.status(404).json({ error: 'Project not found' })
    res.json(p)
  })

  app.put('/api/projects/:id', (req, res) => {
    const cols = fields(req.body, ['name', 'description', 'outputPath', 'status', 'mode', 'rules'])
    if (cols.length) {
      const sets = cols.map(c => `${snake(c)} = ?`).join(',')
      const vals = cols.map(c => req.body[c])
      db.prepare(`UPDATE projects SET ${sets}, updated_at=? WHERE id=?`).run(...vals, now(), req.params.id)
    }
    res.json(db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id)); saveDB()
  })

  app.delete('/api/projects/:id', (req, res) => {
    const confirm = req.query.confirm === 'true'

    // Collect all agents to be deleted (including sub-projects)
    const allProjectIds = [req.params.id]
    const subProjects = db.prepare('SELECT id FROM projects WHERE parent_id=?').all(req.params.id) as Record<string,unknown>[]
    for (const sp of subProjects) allProjectIds.push(sp.id as string)

    const allAgents: Record<string,unknown>[] = []
    for (const pid of allProjectIds) {
      const agents = db.prepare('SELECT id, name, status FROM agents WHERE project_id=?').all(pid) as Record<string,unknown>[]
      allAgents.push(...agents)
    }

    const convCount = (db.prepare('SELECT COUNT(*) as c FROM conversations WHERE project_id IN (' + allProjectIds.map(() => '?').join(',') + ')').get(...allProjectIds) as Record<string,unknown>).c
    const relCount = allAgents.length > 0
      ? (db.prepare('SELECT COUNT(*) as c FROM agent_relationships WHERE source_agent_id IN (' + allAgents.map(() => '?').join(',') + ') OR target_agent_id IN (' + allAgents.map(() => '?').join(',') + ')').get(...allAgents.map(a => a.id), ...allAgents.map(a => a.id)) as Record<string,unknown>).c
      : 0

    if (!confirm) {
      return res.json({
        confirmRequired: true,
        hint: 'Add ?confirm=true to proceed with deletion',
        preview: { projects: allProjectIds.length, agents: allAgents.length, agentNames: allAgents.map(a => a.name), conversations: convCount, relationships: relCount }
      })
    }

    // Delete sub-projects recursively
    for (const sp of subProjects) {
      const subAgents = db.prepare('SELECT id FROM agents WHERE project_id=?').all(sp.id) as Record<string,unknown>[]
      for (const a of subAgents) {
        db.prepare('DELETE FROM agent_relationships WHERE source_agent_id=? OR target_agent_id=?').run(a.id, a.id)
      }
      db.prepare('DELETE FROM agents WHERE project_id=?').run(sp.id)
      db.prepare('DELETE FROM conversations WHERE project_id=?').run(sp.id)
      db.prepare('DELETE FROM projects WHERE id=?').run(sp.id)
    }
    // Delete target project
    const agents = db.prepare('SELECT id FROM agents WHERE project_id=?').all(req.params.id) as Record<string,unknown>[]
    for (const a of agents) {
      db.prepare('DELETE FROM agent_relationships WHERE source_agent_id=? OR target_agent_id=?').run(a.id, a.id)
    }
    db.prepare('DELETE FROM agents WHERE project_id=?').run(req.params.id)
    db.prepare('DELETE FROM conversations WHERE project_id=?').run(req.params.id)
    db.prepare('DELETE FROM projects WHERE id=?').run(req.params.id)
    // Clean up any remaining orphaned relationships
    db.prepare("DELETE FROM agent_relationships WHERE source_agent_id NOT IN (SELECT id FROM agents) OR target_agent_id NOT IN (SELECT id FROM agents)").run()
    saveDB()
    res.json({ success: true, deleted: { projects: allProjectIds.length, agents: allAgents.length, conversations: convCount as number, relationships: relCount as number } })
  })

  // ========================================
  // AGENTS
  // ========================================
  app.get('/api/agents', (req, res) => {
    const pid = req.query.projectId as string | undefined
    const all = pid
      ? db.prepare('SELECT * FROM agents WHERE project_id=? ORDER BY sort_order').all(pid)
      : db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all()
    res.json(all)
  })

  app.get('/api/agents/:id', (req, res) => {
    const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id)
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    res.json(agent)
  })

  app.post('/api/agents', (req, res) => {
    const { projectId, name, description, specJson, interfaceJson, dependencies, status: reqStatus } = req.body
    if (!projectId || !name) return res.status(400).json({ error: 'projectId and name required' })
    const t = now()
    // Dedup by name within project
    const existing = db.prepare('SELECT id FROM agents WHERE project_id=? AND name=?').get(projectId, name) as Record<string,unknown> | undefined
    if (existing) {
      db.prepare('UPDATE agents SET description=COALESCE(?,description), spec_json=COALESCE(?,spec_json), interface_json=COALESCE(?,interface_json), updated_at=? WHERE id=?')
        .run(description || null, specJson ? stringify(specJson) : null, interfaceJson ? stringify(interfaceJson) : null, t, existing.id)
      const updated = db.prepare('SELECT * FROM agents WHERE id=?').get(existing.id)
      saveDB()
      broadcast('agent:updated', { agent: updated })
      return res.json(updated)
    }
    const id = rnd()
    db.prepare('INSERT INTO agents (id,project_id,name,description,status,spec_json,interface_json,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, name, description || '', reqStatus || 'pending', specJson ? stringify(specJson) : '{}', interfaceJson ? stringify(interfaceJson) : '{}', 0, t, t)
    // Create relationships from dependencies/inputs/outputs
    if (Array.isArray(dependencies)) {
      for (const depName of dependencies) {
        const tgt = db.prepare('SELECT id FROM agents WHERE (id=? OR name=?) AND project_id=?').get(depName, depName, projectId) as Record<string,unknown> | undefined
        if (tgt && tgt.id !== id) {
          try { db.prepare('INSERT INTO agent_relationships (id,source_agent_id,target_agent_id,relationship_type,description,created_at) VALUES (?,?,?,?,?,?)').run(rnd(), id, tgt.id, 'depends_on', '', t) } catch { /* dup */ }
        }
      }
    }
    const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(id)
    saveDB()
    broadcast('agent:created', { agent })
    res.json(agent)
  })

  app.put('/api/agents/:id', (req, res) => {
    const cols = fields(req.body, ['name', 'description', 'status', 'outputPath', 'generationAttempts', 'errorMessage'])
    if (cols.length) {
      const sets = cols.map(c => `${snake(c)} = ?`).join(',')
      const vals = cols.map(c => req.body[c])
      db.prepare(`UPDATE agents SET ${sets}, updated_at=? WHERE id=?`).run(...vals, now(), req.params.id)
    }
    // Sync spec_json name/description when name/description updated
    if ((req.body.name || req.body.description) && !req.body.specJson) {
      const agent = db.prepare('SELECT spec_json FROM agents WHERE id=?').get(req.params.id) as Record<string,unknown> | undefined
      if (agent?.spec_json) {
        try {
          const spec = JSON.parse(agent.spec_json as string)
          if (req.body.name) spec.name = req.body.name
          if (req.body.description) spec.description = req.body.description
          db.prepare('UPDATE agents SET spec_json=? WHERE id=?').run(stringify(spec), req.params.id)
        } catch { /* spec_json is malformed */ }
      }
    }
    // Handle dependencies update — replace all depends_on relationships for this agent
    if (Array.isArray(req.body.dependencies)) {
      // Delete existing depends_on relationships where this agent is the source
      db.prepare("DELETE FROM agent_relationships WHERE source_agent_id=? AND relationship_type='depends_on'").run(req.params.id)
      const t = now()
      for (const depName of req.body.dependencies) {
        const projectAgent = db.prepare('SELECT project_id FROM agents WHERE id=?').get(req.params.id) as Record<string,unknown> | undefined
        const tgt = db.prepare('SELECT id FROM agents WHERE (id=? OR name=?) AND project_id=?').get(depName, depName, projectAgent?.project_id)
        if (tgt && (tgt as Record<string,unknown>).id !== req.params.id) {
          try { db.prepare('INSERT INTO agent_relationships (id,source_agent_id,target_agent_id,relationship_type,description,created_at) VALUES (?,?,?,?,?,?)').run(rnd(), req.params.id, (tgt as Record<string,unknown>).id, 'depends_on', '', t) } catch { /* dup */ }
        }
      }
    }
    res.json(db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id)); saveDB()
  })

  app.post('/api/agents/:id/generate-claude', (req, res) => {
    const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id) as Record<string,unknown> | undefined
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    const status = agent.status as string
    if (status === 'queued' || status === 'generating') {
      return res.status(409).json({ error: 'Agent is already queued or generating', agent })
    }
    const attempts = ((agent.generation_attempts as number) || 0) + 1
    db.prepare("UPDATE agents SET status='queued', generation_attempts=?, error_message=NULL, updated_at=? WHERE id=?")
      .run(attempts, now(), req.params.id)
    saveDB()
    const updatedClaude = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id)
    broadcast('agent:updated', { agent: updatedClaude })
    const proj = agent.project_id
      ? db.prepare('SELECT output_path FROM projects WHERE id=?').get(agent.project_id as string) as Record<string,unknown> | undefined
      : null
    startGenerationClaude(req.params.id, (proj?.output_path as string) || 'output', wssClients)
    res.json(updatedClaude)
  })

  app.post('/api/agents/:id/regenerate', (req, res) => {
    const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id) as Record<string,unknown> | undefined
    if (!agent) return res.status(404).json({ error: 'Agent not found' })
    const status = agent.status as string
    if (status === 'queued' || status === 'generating') {
      return res.status(409).json({ error: 'Agent is already queued or generating', agent })
    }
    // Reset status and increment attempts
    const attempts = ((agent.generation_attempts as number) || 0) + 1
    db.prepare("UPDATE agents SET status='queued', generation_attempts=?, error_message=NULL, updated_at=? WHERE id=?")
      .run(attempts, now(), req.params.id)
    saveDB()
    const updatedRegen = db.prepare('SELECT * FROM agents WHERE id=?').get(req.params.id)
    broadcast('agent:updated', { agent: updatedRegen })
    const proj = agent.project_id
      ? db.prepare('SELECT output_path FROM projects WHERE id=?').get(agent.project_id as string) as Record<string,unknown> | undefined
      : null
    startGenerationClaude(req.params.id, (proj?.output_path as string) || 'output', wssClients)
    res.json(updatedRegen)
  })

  // List generated files for an agent
  app.get('/api/agents/:id/files', (req, res) => {
    const agent = db.prepare('SELECT output_path FROM agents WHERE id=?').get(req.params.id) as Record<string,unknown> | undefined
    if (!agent?.output_path) return res.json([])
    const dir = agent.output_path as string
    try {
      const fs = require('fs')
      const path = require('path')
      const fullPath = path.resolve(dir)
      if (!fs.existsSync(fullPath)) return res.json([])
      const files = fs.readdirSync(fullPath).filter((f: string) => f.endsWith('.ts') || f.endsWith('.md') || f.endsWith('.json') || f === 'Dockerfile')
      res.json(files.map((f: string) => ({ name: f, path: path.join(dir, f).replace(/\\/g, '/'), size: fs.statSync(path.join(fullPath, f)).size })))
    } catch { res.json([]) }
  })

  // Recursive file tree for an agent
  app.get('/api/agents/:id/file-tree', (req, res) => {
    const agent = db.prepare('SELECT output_path FROM agents WHERE id=?').get(req.params.id) as Record<string,unknown> | undefined
    const base = require('path').resolve(agent?.output_path as string || '')
    const fs = require('fs')
    const path = require('path')
    if (!base || !fs.existsSync(base)) return res.json([])
    const walk = (dir: string): Record<string,unknown>[] => {
      return fs.readdirSync(dir, { withFileTypes: true }).map((d: { name: string; isDirectory: () => boolean }) => {
        const fp = path.join(dir, d.name)
        if (d.isDirectory()) return { name: d.name, type: 'dir', path: fp.replace(/\\/g, '/'), children: walk(fp) }
        const stat = fs.statSync(fp)
        return { name: d.name, type: 'file', path: fp.replace(/\\/g, '/'), size: stat.size }
      })
    }
    res.json(walk(base))
  })

  // Read a generated file
  app.get('/api/files', (req, res) => {
    const filePath = req.query.path as string
    if (!filePath) return res.status(400).json({ error: 'path required' })
    try {
      const fs = require('fs')
      const fullPath = require('path').resolve(filePath)
      if (!fullPath.includes('output')) return res.status(403).json({ error: 'Access denied' })
      if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File not found' })
      res.json({ content: fs.readFileSync(fullPath, 'utf-8'), size: fs.statSync(fullPath).size })
    } catch (e) { res.status(500).json({ error: (e as Error).message }) }
  })

  app.put('/api/files', (req, res) => {
    const { path: filePath, content } = req.body
    if (!filePath || content === undefined) return res.status(400).json({ error: 'path and content required' })
    try {
      const fs = require('fs')
      const p = require('path')
      const fullPath = p.resolve(filePath)
      if (!fullPath.includes('output')) return res.status(403).json({ error: 'Access denied' })
      const dir = p.dirname(fullPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(fullPath, content, 'utf-8')
      res.json({ path: filePath, size: content.length })
    } catch (e) { res.status(500).json({ error: (e as Error).message }) }
  })

  // File tree for a project or agent
  app.get('/api/projects/:id/tree', (req, res) => {
    try {
      const fs = require('fs')
      const p = require('path')
      const project = db.prepare('SELECT output_path FROM projects WHERE id=?').get(req.params.id) as Record<string,unknown> | undefined
      const base = p.resolve(project?.output_path as string || 'output')
      if (!fs.existsSync(base)) return res.json([])
      const walk = (dir: string): Record<string,unknown>[] => {
        return fs.readdirSync(dir, { withFileTypes: true }).map((d: { name: string; isDirectory: () => boolean }) => {
          const fp = p.join(dir, d.name)
          return d.isDirectory() ? { name: d.name, type: 'dir', children: walk(fp) } : { name: d.name, type: 'file', path: fp, size: fs.statSync(fp).size }
        })
      }
      res.json(walk(base))
    } catch (e) { res.status(500).json({ error: (e as Error).message }) }
  })

  app.delete('/api/agents/:id', (req, res) => {
    db.prepare('DELETE FROM agents WHERE id=?').run(req.params.id)
    saveDB(); res.json({ success: true })
  })

  app.get('/api/relationships', (req, res) => {
    const pid = req.query.projectId as string | undefined
    const rels = pid
      ? db.prepare('SELECT ar.* FROM agent_relationships ar JOIN agents a ON ar.source_agent_id=a.id WHERE a.project_id=?').all(pid)
      : db.prepare('SELECT * FROM agent_relationships').all()
    res.json(rels)
  })

  app.post('/api/relationships', (req, res) => {
    const { sourceAgentId, targetAgentId, relationshipType, description } = req.body
    if (!sourceAgentId || !targetAgentId) return res.status(400).json({ error: 'sourceAgentId and targetAgentId required' })
    const type = relationshipType || 'depends_on'
    if (!['depends_on', 'communicates_with', 'shares_data'].includes(type)) {
      return res.status(400).json({ error: `Invalid relationship type: ${type}` })
    }
    const id = rnd()
    try {
      db.prepare('INSERT INTO agent_relationships (id,source_agent_id,target_agent_id,relationship_type,description,created_at) VALUES (?,?,?,?,?,?)')
        .run(id, sourceAgentId, targetAgentId, type, description || '', now())
      saveDB()
      const rel = db.prepare('SELECT * FROM agent_relationships WHERE id=?').get(id)
      broadcast('relationship:created', { relationship: rel })
      res.json(rel)
    } catch (e) {
      if ((e as Error).message?.includes('UNIQUE')) return res.status(409).json({ error: 'Relationship already exists' })
      throw e
    }
  })

  app.delete('/api/relationships/:id', (req, res) => {
    const rel = db.prepare('SELECT * FROM agent_relationships WHERE id=?').get(req.params.id)
    if (!rel) return res.status(404).json({ error: 'Relationship not found' })
    db.prepare('DELETE FROM agent_relationships WHERE id=?').run(req.params.id)
    saveDB()
    broadcast('relationship:deleted', { relationshipId: req.params.id })
    res.json({ success: true })
  })

  // Auto-analyze and create relationships using LLM
  app.post('/api/projects/:id/analyze-relationships', async (req, res) => {
    const projectId = req.params.id
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as Record<string,unknown> | undefined
    if (!project) return res.status(404).json({ error: 'Project not found' })

    // Get active LLM config
    let row = db.prepare('SELECT * FROM llm_configurations WHERE is_default=1 AND is_active=1').get() as Record<string,unknown> | undefined
    if (!row) row = db.prepare('SELECT * FROM llm_configurations WHERE is_active=1 LIMIT 1').get() as Record<string,unknown> | undefined
    if (!row?.api_key) return res.status(400).json({ error: 'No active LLM config. Go to Settings to add one.' })

    const config: LLMConfig = {
      id: row.id as string, name: row.name as string, provider: row.provider as LLMConfig['provider'],
      apiKey: row.api_key as string, baseUrl: (row.base_url as string) || null,
      modelName: row.model_name as string, maxTokens: row.max_tokens as number || 8192,
      temperature: row.temperature as number || 0.7,
      enableThinking: (row.enable_thinking as number) !== 0,
      isDefault: (row.is_default as number) === 1, isActive: (row.is_active as number) === 1,
      createdAt: row.created_at as string || '', updatedAt: row.updated_at as string || ''
    }

    try {
      const llm = createLLMProvider(config)
      const decomposer = createDecomposer(llm)

      // Get all agents with their specs and interfaces
      const agents = db.prepare('SELECT id, name, description, spec_json, interface_json FROM agents WHERE project_id=?').all(projectId) as Record<string,unknown>[]
      if (agents.length < 2) return res.json({ relationships: [], created: 0, message: 'Need at least 2 agents to analyze relationships' })

      const agentSpecs: Array<{
        id: string; name: string; description: string
        inputs: Array<{ name: string; type: string; source: string }>
        outputs: Array<{ name: string; type: string; destination: string }>
      }> = agents.map(a => {
        const spec = (() => { try { return JSON.parse((a.spec_json as string) || '{}') } catch { return {} } })()
        const iface = (() => { try { return JSON.parse((a.interface_json as string) || '{}') } catch { return {} } })()
        return {
          id: a.id as string,
          name: a.name as string,
          description: (a.description as string) || '',
          inputs: (iface.inputs || []).map((i: Record<string,unknown>) => ({ name: i.name as string, type: i.type as string, source: String(i.source) })),
          outputs: (iface.outputs || []).map((o: Record<string,unknown>) => ({ name: o.name as string, type: o.type as string, destination: String(o.destination) })),
        }
      })

      const rules = (project.rules as string) || ''
      const result = await decomposer.mapRelationships(agentSpecs, rules, [])

      // Collect active skills for relationship guidance
      const activeSkills = db.prepare('SELECT prompt_content FROM skills WHERE is_active=1').all() as Array<{ prompt_content: string }>
      const skillsCtx = activeSkills.length > 0 ? activeSkills.map(s => s.prompt_content).join('\n\n') : ''

      // Build a richer prompt if skills are available
      let enrichedResult = result
      if (skillsCtx) {
        const relPrompt = `CRITICAL: Analyze these agents and ALL possible relationships:\n${JSON.stringify(agentSpecs)}\n\nUse these relationship types:\n- depends_on: one agent requires another to START (dependency)\n- communicates_with: agents exchange data at runtime\n- shares_data: agents read/write shared data store\n\n${skillsCtx}\n\nOutput JSON:\n{"relationships":[{"sourceId":"id","targetId":"id","type":"depends_on","dataFlow":"what flows"}],"generationOrder":["id1"]}`
        try {
          enrichedResult = await llm.json<{ relationships: { sourceId: string; targetId: string; type: string; dataFlow: string }[]; generationOrder: string[] }>([
            { role: 'system', content: 'You analyze microservice agent relationships. Only output valid JSON.' },
            { role: 'user', content: relPrompt }
          ])
        } catch { /* use basic result */ }
      }

      // Save relationships to DB
      let created = 0
      const createdRels: Record<string,unknown>[] = []
      for (const rel of enrichedResult.relationships || []) {
        const srcAgent = agents.find(a => a.id === rel.sourceId || a.name === rel.sourceId)
        const tgtAgent = agents.find(a => a.id === rel.targetId || a.name === rel.targetId)
        if (!srcAgent || !tgtAgent || srcAgent.id === tgtAgent.id) continue
        const type = rel.type || 'depends_on'
        if (!['depends_on', 'communicates_with', 'shares_data'].includes(type)) continue
        try {
          const rid = rnd()
          db.prepare('INSERT INTO agent_relationships (id,source_agent_id,target_agent_id,relationship_type,description,created_at) VALUES (?,?,?,?,?,?)')
            .run(rid, srcAgent.id as string, tgtAgent.id as string, type, (rel.dataFlow as string) || '', now())
          const saved = db.prepare('SELECT * FROM agent_relationships WHERE id=?').get(rid)
          createdRels.push(saved as Record<string,unknown>)
          created++
        } catch { /* dup — skip */ }
      }
      saveDB()
      if (created > 0) broadcast('project:relationships-updated', { projectId, count: created })
      res.json({ relationships: createdRels, created, generationOrder: enrichedResult.generationOrder || [] })
    } catch (e) {
      res.status(500).json({ error: 'Relationship analysis failed: ' + (e as Error).message })
    }
  })

  // ========================================
  // CONVERSATIONS
  // ========================================
  app.post('/api/conversations', (req, res) => {
    const { title, projectId } = req.body
    const id = rnd(); const t = now()
    db.prepare('INSERT INTO conversations (id,project_id,title,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run(id, projectId || null, title || 'New Conversation', t, t)
    res.json(db.prepare('SELECT * FROM conversations WHERE id=?').get(id)); saveDB()
  })

  app.get('/api/conversations', (_req, res) => {
    res.json(db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all())
  })

  app.delete('/api/conversations/:id', (req, res) => {
    db.prepare('DELETE FROM conversations WHERE id=?').run(req.params.id)
    saveDB(); res.json({ success: true })
  })

  app.get('/api/conversations/:id/messages', (req, res) => {
    res.json(db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY sort_order').all(req.params.id))
  })

  app.post('/api/conversations/:id/stop', (req, res) => {
    const ac = activeStreams.get(req.params.id)
    if (ac) { ac.abort(); res.json({ stopped: true }) }
    else { res.json({ stopped: false }) }
  })

  app.post('/api/build/confirm', (req, res) => {
    const { projectId, agentIds } = req.body
    if (!projectId || !agentIds?.length) return res.status(400).json({ error: 'projectId and agentIds required' })
    // Get LLM config for code generation
    const row = db.prepare('SELECT * FROM llm_configurations WHERE is_default=1 AND is_active=1').get() as Record<string,unknown> | undefined
    if (!row?.api_key) return res.status(400).json({ error: 'No LLM config' })
    const cfg = { apiKey: row.api_key as string, baseUrl: (row.base_url as string) || 'https://api.deepseek.com/v1', modelName: row.model_name as string, maxTokens: row.max_tokens as number || 8192, temperature: row.temperature as number || 0, enableThinking: (row.enable_thinking as number) !== 0 }
    const out = db.prepare('SELECT output_path FROM projects WHERE id=?').get(projectId) as Record<string,unknown> | undefined
    // Update pending agents to queued and start generation
    const ids: string[] = []
    for (const aid of agentIds as string[]) {
      const agent = db.prepare('SELECT * FROM agents WHERE id=? AND project_id=?').get(aid, projectId) as Record<string,unknown> | undefined
      if (agent && agent.status === 'pending') {
        db.prepare("UPDATE agents SET status='queued', updated_at=? WHERE id=?").run(now(), aid)
        ids.push(aid)
      }
    }
    saveDB()
    if (ids.length > 0) {
      generateAllAgents(ids, cfg, (out?.output_path as string) || 'output', wssClients)
    }
    res.json({ confirmed: ids.length })
  })

  // ========================================
  // CHAT (the core)
  // ========================================
  app.post('/api/conversations/:id/chat', async (req, res) => {
    const { content } = req.body
    const convId = req.params.id
    if (!content?.trim()) return res.status(400).json({ error: 'Content required' })

    try {
      // 1. Save user message immediately (before long-running decomposition)
      const count = (db.prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_id=?').get(convId) as Record<string,unknown>).c as number || 0
      const userMsgId = rnd()
      db.prepare('INSERT INTO messages (id,conversation_id,role,content,sort_order,created_at) VALUES (?,?,?,?,?,?)')
        .run(userMsgId, convId, 'user', content, count + 1, now())
      db.prepare('UPDATE conversations SET message_count=message_count+1, updated_at=? WHERE id=?').run(now(), convId)
      saveDB()
      broadcast('conversation:message-new', { conversationId: convId, message: db.prepare('SELECT * FROM messages WHERE id=?').get(userMsgId) })

      // 2. Get LLM config
      let row = db.prepare('SELECT * FROM llm_configurations WHERE is_default=1 AND is_active=1').get()
      if (!row) row = db.prepare('SELECT * FROM llm_configurations WHERE is_active=1 LIMIT 1').get()
      if (!row) return res.status(400).json({ error: 'No AI model configured. Go to Settings.' })
      if (!row.api_key) return res.status(400).json({ error: 'No API key configured. Go to Settings.' })

      const config: LLMConfig = {
        id: row.id as string, name: row.name as string, provider: row.provider as LLMConfig['provider'],
        apiKey: row.api_key as string, baseUrl: (row.base_url as string) || null,
        modelName: row.model_name as string, maxTokens: row.max_tokens as number || 8192,
        temperature: row.temperature as number || 0.7,
        enableThinking: (row.enable_thinking as number) !== 0,
        isDefault: (row.is_default as number) === 1, isActive: (row.is_active as number) === 1,
        createdAt: row.created_at as string || '', updatedAt: row.updated_at as string || ''
      }

      // 3. Get conversation's project + rules
      const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(convId) as Record<string,unknown> | undefined
      const projectId = (conv?.project_id as string) || null
      const project = projectId ? db.prepare('SELECT name, rules FROM projects WHERE id=?').get(projectId) as Record<string,unknown> | undefined : null

      // 4. Create streaming assistant message placeholder
      const streamMsgId = rnd()
      db.prepare('INSERT INTO messages (id,conversation_id,role,content,sort_order,created_at,model_used) VALUES (?,?,?,?,?,?,?)')
        .run(streamMsgId, convId, 'assistant', '', count + 2, now(), config.modelName)

      // Streaming helper — save content incrementally for crash recovery
      let streamContent = ''
      let lastFlush = 0
      const push = (text: string) => {
        streamContent += text
        broadcast('chat:stream', { conversationId: convId, messageId: streamMsgId, content: streamContent })
        // Flush to DB every 3 seconds so crashes don't lose the entire response
        const n = Date.now()
        if (n - lastFlush > 3000) {
          lastFlush = n
          db.prepare('UPDATE messages SET content=? WHERE id=?').run(streamContent, streamMsgId)
          saveDB()
        }
      }

      // 5. Get conversation history (last 20 messages) for context
      const history = db.prepare('SELECT role, content FROM messages WHERE conversation_id=? ORDER BY sort_order ASC LIMIT 20').all(convId) as {role:string,content:string}[]

      // 6. Get existing project agents + LLM
      const existingAgents = projectId
        ? db.prepare('SELECT id, name, description, status, spec_json, interface_json FROM agents WHERE project_id=?').all(projectId) as Record<string,unknown>[]
        : []
      const existingContext = existingAgents.map(a => {
        try {
          const spec = JSON.parse((a.spec_json as string) || '{}')
          return { id: spec.id || a.id, name: a.name, description: a.description, status: a.status, inputs: (JSON.parse((a.interface_json as string) || '{}')).inputs || [], outputs: (JSON.parse((a.interface_json as string) || '{}')).outputs || [] }
        } catch { return { name: a.name, description: a.description, status: a.status } }
      })

      // Store user message in vector memory
      rememberMessage(convId, userMsgId, content, config.apiKey, config.baseUrl || 'https://api.deepseek.com/v1').catch(() => {})
      // Index message for RAG
      indexMessage(convId, userMsgId, content).catch(() => {})

      // Get conversation context for the LLM
      const memoryCtx = getRecentContext(convId, 15)
      // Try RAG context — don't crash if embedder isn't ready
      let ragCtx: string[] = []
      try { ragCtx = await retrieveContext(content, projectId, 6) } catch { /* RAG not available */ }

      const llm = createLLMProvider(config)
      const decomposer = createDecomposer(llm)

      // Track this stream for stop capability
      const ac = new AbortController()
      activeStreams.set(convId, ac)

      // Stream the answer
      const buildMode = req.body.buildMode === true

      // ---- BUILD MODE: Claude Code CLI + MCP Tools ----
      if (buildMode) {
        activeStreams.set(convId, ac)
        const outDir = (project?.output_path as string) || 'output'
        startClaudeCodeAction({
          conversationId: convId,
          messageId: streamMsgId,
          prompt: content,
          projectId,
          outputDir: outDir,
          signal: ac.signal,
        }, wssClients)

        // Poll DB for Claude Code to finish writing the message
        await new Promise<void>((resolve) => {
          const checkInterval = setInterval(() => {
            const agent = db.prepare('SELECT content FROM messages WHERE id=?').get(streamMsgId) as Record<string,unknown> | undefined
            if (agent && typeof agent.content === 'string' && (agent.content as string).length > 0) {
              clearInterval(checkInterval)
              resolve()
            }
          }, 500)
          setTimeout(() => { clearInterval(checkInterval); resolve() }, 300000)
          ac.signal.addEventListener('abort', () => { clearInterval(checkInterval); resolve() }, { once: true })
        })
        activeStreams.delete(convId)
        const finalMsg = db.prepare('SELECT * FROM messages WHERE id=?').get(streamMsgId)
        db.prepare('UPDATE conversations SET message_count=message_count+1, updated_at=? WHERE id=?').run(now(), convId)
        broadcast('chat:stream-done', { conversationId: convId, messageId: streamMsgId })
        res.json({ message: finalMsg, agents: [], relationships: [], projectId })
      } else {
      // ---- CHAT MODE: DeepSeek API direct ----

      // Inject RAG context into user message for better answers
      const enrichedContent = ragCtx.length > 0
        ? `${content}\n\n[Relevant context from project - use this to answer accurately]:\n${ragCtx.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
        : content

      let stopped = false
      const streamFn = decomposer.answerQuestion(enrichedContent, existingAgents as Array<Record<string,unknown>>, (project?.rules as string) || '', memoryCtx, ac.signal)
      try {
        for await (const chunk of streamFn) {
          if (!chunk.done && chunk.token) push(chunk.token)
        }
      } catch (e: unknown) {
        if ((e as Error).name !== 'AbortError') throw e
        stopped = true
        push('\n\n*[Stopped]*')
      } finally {
        activeStreams.delete(convId)
      }
      db.prepare('UPDATE messages SET content=? WHERE id=?').run(streamContent, streamMsgId)
      saveDB()
      rememberMessage(convId, streamMsgId, streamContent, config.apiKey, config.baseUrl || 'https://api.deepseek.com/v1').catch(() => {})
      indexMessage(convId, streamMsgId, streamContent).catch(() => {})
      broadcast('chat:stream-done', { conversationId: convId, messageId: streamMsgId })
      db.prepare('UPDATE conversations SET message_count=message_count+1, updated_at=? WHERE id=?').run(now(), convId)
      res.json({ message: db.prepare('SELECT * FROM messages WHERE id=?').get(streamMsgId), agents: [], relationships: [], projectId, plan: null })

      } // end else (chat mode)

    } catch (err) {
      activeStreams.delete(convId)
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[chat]', msg)
      const errId = rnd()
      const cnt = (db.prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_id=?').get(convId) as Record<string,unknown>).c as number || 0
      db.prepare('INSERT INTO messages (id,conversation_id,role,content,sort_order,created_at) VALUES (?,?,?,?,?,?)')
        .run(errId, convId, 'assistant', '❌ ' + msg, cnt + 1, now())
      saveDB()
      res.status(500).json({ error: msg })
    }
  })

  // ========================================
  // LLM CONFIGURATIONS
  // ========================================
  app.get('/api/llm-configs', (_req, res) => {
    const rows = db.prepare('SELECT * FROM llm_configurations ORDER BY is_default DESC').all() as Record<string,unknown>[]
    res.json(rows.map(r => {
      const key = r.api_key as string || ''
      return { ...r, api_key: key ? key.slice(0,4) + '••••' + key.slice(-4) : '' }
    }))
  })

  app.post('/api/llm-configs', (req, res) => {
    if (req.body.isDefault) db.prepare('UPDATE llm_configurations SET is_default=0').run()
    const id = rnd(); const t = now()
    db.prepare('INSERT INTO llm_configurations (id,name,provider,api_key,base_url,model_name,max_tokens,temperature,is_default,is_active,enable_thinking,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?)')
      .run(id, req.body.name, req.body.provider, req.body.apiKey || '', req.body.baseUrl || null, req.body.modelName, req.body.maxTokens || 8192, req.body.temperature ?? 0.7, req.body.isDefault ? 1 : 0, req.body.enableThinking !== false ? 1 : 0, t, t)
    res.json(db.prepare('SELECT * FROM llm_configurations WHERE id=?').get(id)); saveDB()
  })

  app.put('/api/llm-configs/:id', (req, res) => {
    if (req.body.isDefault) db.prepare('UPDATE llm_configurations SET is_default=0').run()
    // Filter out empty apiKey to prevent wiping user's key
    const cols = fields(req.body, ['name', 'provider', 'baseUrl', 'modelName', 'maxTokens', 'temperature', 'isDefault', 'isActive', 'enableThinking'])
      .filter(c => c !== 'apiKey' || (typeof req.body.apiKey === 'string' && req.body.apiKey.trim()))
    if (typeof req.body.apiKey === 'string' && req.body.apiKey.trim()) cols.push('apiKey')
    if (cols.length) {
      const sets = cols.map(c => `${snake(c)} = ?`).join(',')
      const vals = cols.map(c => req.body[c])
      db.prepare(`UPDATE llm_configurations SET ${sets}, updated_at=? WHERE id=?`).run(...vals, now(), req.params.id)
    }
    res.json(db.prepare('SELECT * FROM llm_configurations WHERE id=?').get(req.params.id)); saveDB()
  })

  app.delete('/api/llm-configs/:id', (req, res) => {
    const exists = db.prepare('SELECT id FROM llm_configurations WHERE id=?').get(req.params.id)
    if (!exists) return res.status(404).json({ success: false, error: 'LLM config not found' })
    db.prepare('DELETE FROM llm_configurations WHERE id=?').run(req.params.id)
    saveDB()
    res.json({ success: true })
  })

  app.post('/api/llm-configs/:id/test', async (req, res) => {
    const row = db.prepare('SELECT * FROM llm_configurations WHERE id=?').get(req.params.id) as Record<string,unknown> | undefined
    if (!row || !row.api_key) return res.json({ success: false, error: 'No API key configured' })
    try {
      const llm = createLLMProvider({
        id: row.id as string, name: row.name as string, provider: row.provider as LLMConfig['provider'],
        apiKey: row.api_key as string, baseUrl: (row.base_url as string) || null,
        modelName: row.model_name as string, maxTokens: row.max_tokens as number || 8192,
        temperature: row.temperature as number || 0.7,
        enableThinking: (row.enable_thinking as number) !== 0,
        isDefault: (row.is_default as number) === 1, isActive: (row.is_active as number) === 1,
        createdAt: row.created_at as string || '', updatedAt: row.updated_at as string || ''
      })
      const start = Date.now()
      const resp = await llm.chat([{ role: 'user', content: 'Reply "OK" only.' }])
      res.json({ success: true, latency: Date.now() - start, model: row.model_name, preview: resp.slice(0, 100) })
    } catch (e) { res.json({ success: false, error: (e as Error).message }) }
  })

  // ========================================
  // DOCKER COMPOSE
  // ========================================
  app.get('/api/projects/:id/docker-compose', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id) as Record<string,unknown> | undefined
    if (!project) return res.status(404).json({ error: 'Project not found' })

    const agents = db.prepare('SELECT * FROM agents WHERE project_id=? AND status=?').all(req.params.id, 'completed') as Record<string,unknown>[]
    const rels = db.prepare(`SELECT ar.*, sa.name as source_name, ta.name as target_name
      FROM agent_relationships ar
      JOIN agents sa ON ar.source_agent_id=sa.id
      JOIN agents ta ON ar.target_agent_id=ta.id
      WHERE sa.project_id=?`).all(req.params.id) as Record<string,unknown>[]

    // Build docker-compose (no version field — not required by Compose v2+)
    const compose: Record<string, unknown> = {
      services: {} as Record<string, unknown>,
      networks: { 'agent-network': { driver: 'bridge' } }
    }

    const services = compose.services as Record<string, unknown>

    // Generate gateway with real dashboard
    const gatewayDir = (project.output_path as string) || 'output'
    const gwPath = require('path').resolve(gatewayDir, 'gateway')
    const fs = require('fs')
    if (!fs.existsSync(gwPath)) fs.mkdirSync(gwPath, { recursive: true })
    if (!fs.existsSync(require('path').join(gwPath, 'public'))) fs.mkdirSync(require('path').join(gwPath, 'public'))

    const agentListForGw = agents.map(a => ({
      name: a.name, id: a.id,
      svc: (a.name as string).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase(),
      desc: a.description
    }))

    // Gateway server
    fs.writeFileSync(require('path').join(gwPath, 'index.ts'), `
import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { join } from 'path'

const app = express()
const PORT = process.env.PORT || 8080
const SERVICES = ${JSON.stringify(agentListForGw, null, 2)}

app.use(express.static(join(__dirname, 'public')))

// Dashboard data API
app.get('/api/dashboard', (_req, res) => {
  res.json({ name: '${project.name}', services: SERVICES, totalAgents: ${agents.length} })
})

// Health check per service
app.get('/api/health/:service', async (req, res) => {
  try {
    const resp = await fetch(\`http://\${req.params.service}:3000/health\`, { signal: AbortSignal.timeout(3000) })
    res.json({ service: req.params.service, status: resp.ok ? 'up' : 'down' })
  } catch { res.json({ service: req.params.service, status: 'down' }) }
})

// Proxy API calls to services
app.use('/api/:service', (req, _res, next) => {
  const svc = SERVICES.find(s => s.svc === req.params.service)
  if (svc) {
    createProxyMiddleware({ target: \`http://\${svc.svc}:3000\`, changeOrigin: true, pathRewrite: { [\`^/api/\${svc.svc}\`]: '' } })(req, _res, next)
  } else { next() }
})

app.get('*', (_req, res) => res.sendFile(join(__dirname, 'public', 'dashboard.html')))
app.listen(PORT, () => console.log(\`Gateway + Dashboard ready: http://localhost:\${PORT}\`))
`)

    // Dashboard HTML
    fs.writeFileSync(require('path').join(gwPath, 'public', 'dashboard.html'), `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${project.name} - Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#c9d1d9;min-height:100vh}
.header{background:#161b22;border-bottom:1px solid #30363d;padding:16px 24px;display:flex;align-items:center;justify-content:space-between}
.header h1{font-size:18px;color:#58a6ff}
.header .badge{background:#238636;color:#fff;padding:4px 12px;border-radius:12px;font-size:12px}
.main{max-width:1200px;margin:0 auto;padding:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px}
.card h3{font-size:14px;margin-bottom:8px;color:#58a6ff}
.card p{font-size:12px;color:#8b949e;line-height:1.5}
.card .status{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.status.up{background:#238636}.status.down{background:#da3633}.status.unknown{background:#6e7681}
.health-bar{display:flex;gap:8px;margin:16px 0;flex-wrap:wrap}
.health-dot{width:10px;height:10px;border-radius:50%}
.refresh{background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:6px 16px;border-radius:6px;cursor:pointer;font-size:12px}
.refresh:hover{background:#30363d}
.empty{text-align:center;padding:60px 20px;color:#8b949e}
</style></head>
<body>
<div class="header">
  <h1>${project.name}</h1>
  <div style="display:flex;gap:12px;align-items:center">
    <span id="stat">0 / ${agents.length} running</span>
    <span class="badge" id="gatewayStatus">Gateway</span>
    <button class="refresh" onclick="checkAll()">Refresh</button>
  </div>
</div>
<div class="main">
  <div class="grid" id="grid"></div>
  <div class="empty" id="empty">Loading services...</div>
</div>
<script>
const SERVICES = ${JSON.stringify(agentListForGw)};
async function check(service) {
  try{const r=await fetch('/api/health/'+service);return await r.json()}
  catch(e){return{service,status:'down'}}
}
async function checkAll(){
  const results=await Promise.all(SERVICES.map(s=>check(s.svc)));
  const up=results.filter(r=>r.status==='up').length;
  document.getElementById('stat').textContent=up+' / '+SERVICES.length+' running';
  document.getElementById('grid').innerHTML=results.map((r,i)=>
    '<div class="card">'+
    '<h3><span class="status '+r.status+'"></span>'+SERVICES[i].name+'</h3>'+
    '<p>'+SERVICES[i].desc+'</p>'+
    '<p style="margin-top:8px;font-size:11px;color:'+(r.status==='up'?'#238636':'#da3633')+'">'+
    (r.status==='up'?'Running':'Not available')+' · <code>'+SERVICES[i].svc+':3000</code></p>'+
    '</div>'
  ).join('');
  document.getElementById('empty').style.display='none';
}
checkAll();
</script>
</body></html>`)

    // Gateway Dockerfile
    fs.writeFileSync(require('path').join(gwPath, 'Dockerfile'), `FROM node-local
WORKDIR /app
COPY package.json .
RUN npm install --registry=https://registry.npmmirror.com
COPY . .
EXPOSE 8080
CMD ["npx", "tsx", "index.ts"]
`)

    // Gateway package.json
    fs.writeFileSync(require('path').join(gwPath, 'package.json'), JSON.stringify({
      name: 'gateway',
      dependencies: { express: '^4.21.0', 'http-proxy-middleware': '^3.0.0', tsx: '^4.0.0' }
    }, null, 2))

    services['gateway'] = {
      build: './gateway',
      container_name: `${(project.name as string).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()}-gateway`,
      ports: ['8080:8080'],
      environment: { PORT: '8080' },
      networks: ['agent-network'],
      restart: 'unless-stopped'
    }

    let port = 4000

    for (const a of agents) {
      const name = (a.name as string).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
      const dir = (a.output_path as string) || `output/${name}`
      const buildPath = dir.replace(/\\/g, '/').replace(/^output\//, './')

      // Find dependencies
      const deps = rels.filter(r => r.source_agent_id === a.id && r.relationship_type === 'depends_on')
      const dependsOn = deps.map(d => (d.target_name as string).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase())

      // Filter: only pass URLs of agents this one actually depends on
      const depAgentNames = new Set(deps.map(d => (d.target_name as string).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()))
      const depEnv: Record<string, string> = {}
      for (const depName of depAgentNames) {
        depEnv[depName.toUpperCase().replace(/-/g, '_') + '_URL'] = `http://${depName}:3000`
      }

      services[name] = {
        build: buildPath,
        container_name: `${(project.name as string).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()}-${name}`,
        ports: [`${port}:3000`],
        environment: {
          PORT: '3000',
          SERVICE_NAME: name,
          ...depEnv
        },
        networks: ['agent-network'],
        restart: 'unless-stopped'
      }

      if (dependsOn.length > 0) {
        (services[name] as Record<string, unknown>).depends_on = dependsOn
      }

      port++
    }

    res.json({
      yaml: toYaml(compose),
      services: Object.keys(services),
      agentCount: agents.length
    })
  })

  // ========================================
  // SHELL EXECUTION
  // ========================================
  app.post('/api/shell/exec', (req, res) => {
    const { cwd, command } = req.body
    if (!command) return res.status(400).json({ error: 'command required' })
    const dir = cwd || 'output'
    try {
      const { spawn } = require('child_process')
      const child = spawn('cmd.exe', ['/d', '/c', command], { cwd: dir, stdio: 'pipe' })
      res.json({ pid: child.pid, cwd: dir })

      child.stdout.on('data', (data: Buffer) => {
        broadcast('shell:stdout', { pid: child.pid, text: data.toString() })
      })
      child.stderr.on('data', (data: Buffer) => {
        broadcast('shell:stderr', { pid: child.pid, text: data.toString() })
      })
      child.on('close', (code: number) => {
        broadcast('shell:exit', { pid: child.pid, code })
      })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // Sync shell exec — waits for command to complete, returns stdout/stderr
  app.post('/api/shell/exec-sync', (req, res) => {
    const { cwd, command } = req.body
    if (!command) return res.status(400).json({ error: 'command required' })
    const dir = cwd || 'output'
    try {
      const { execSync } = require('child_process')
      const output = execSync(command, { cwd: dir, timeout: 30000, encoding: 'utf-8', maxBuffer: 1024 * 1024 })
      res.json({ stdout: output, code: 0 })
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer; status?: number; message: string }
      res.json({ stdout: err.stdout?.toString() || '', stderr: err.stderr?.toString() || err.message, code: err.status || 1 })
    }
  })

  app.get('/api/docker/check', (_req, res) => {
    try {
      const { execSync } = require('child_process')
      const ver = execSync('docker info --format "{{.ServerVersion}}"', { timeout: 5000, encoding: 'utf-8' }).trim()
      res.json({ available: true, version: ver })
    } catch { res.json({ available: false, version: null }) }
  })

  // ========================================
  // SKILLS
  // ========================================
  app.get('/api/skills', (_req, res) => {
    res.json(db.prepare('SELECT * FROM skills ORDER BY sort_order').all())
  })

  app.post('/api/skills', (req, res) => {
    const { name, description, category, prompt: promptField, promptContent, isActive } = req.body
    const content = promptContent || promptField || ''
    const id = rnd(); const t = now()
    db.prepare('INSERT INTO skills (id,name,description,category,prompt_content,is_active,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, name, description || '', category || 'general', content, isActive !== false ? 1 : 0, 99, t, t)
    saveDB()
    res.json(db.prepare('SELECT * FROM skills WHERE id=?').get(id))
  })

  app.put('/api/skills/:id', (req, res) => {
    const { name, description, category, promptContent, isActive, sortOrder } = req.body
    const sets: string[] = []; const vals: unknown[] = []
    if (name !== undefined) { sets.push('name=?'); vals.push(name) }
    if (description !== undefined) { sets.push('description=?'); vals.push(description) }
    if (category !== undefined) { sets.push('category=?'); vals.push(category) }
    if (promptContent !== undefined) { sets.push('prompt_content=?'); vals.push(promptContent) }
    if (isActive !== undefined) { sets.push('is_active=?'); vals.push(isActive ? 1 : 0) }
    if (sortOrder !== undefined) { sets.push('sort_order=?'); vals.push(sortOrder) }
    if (sets.length > 0) {
      db.prepare(`UPDATE skills SET ${sets.join(',')}, updated_at=? WHERE id=?`).run(...vals, now(), req.params.id)
    }
    saveDB()
    res.json(db.prepare('SELECT * FROM skills WHERE id=?').get(req.params.id))
  })

  app.delete('/api/skills/:id', (req, res) => {
    const result = db.prepare('DELETE FROM skills WHERE id=?').run(req.params.id)
    if (!result) return res.status(404).json({ success: false, error: 'Skill not found' })
    saveDB()
    res.json({ success: true })
  })

  // ========================================
  // SETTINGS
  // ========================================
  app.get('/api/settings', (_req, res) => {
    const rows = db.prepare('SELECT key,value FROM settings').all() as Record<string,unknown>[]
    const s: Record<string,unknown> = {}
    for (const r of rows) s[r.key as string] = r.value
    res.json(s)
  })

  app.put('/api/settings/:key', (req, res) => {
    db.prepare("INSERT INTO settings (key,value,category,updated_at) VALUES (?,?,'general',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
      .run(req.params.key, String(req.body.value), now())
    saveDB(); res.json({ key: req.params.key, value: req.body.value })
  })
}

// ---- Helpers ----
function snake(camel: string): string {
  return camel.replace(/[A-Z]/g, m => '_' + m.toLowerCase())
}

function toYaml(obj: unknown, indent = ''): string {
  if (obj === null || obj === undefined) return 'null'
  if (typeof obj === 'string') return obj.includes(':') || obj.includes('#') ? `"${obj}"` : obj
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj)
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]'
    return obj.map(v => `${indent}- ${toYaml(v, indent + '  ').trimStart()}`).join('\n')
  }
  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>)
    if (entries.length === 0) return '{}'
    return entries.map(([k, v]) => {
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        return `${indent}${k}:\n${toYaml(v, indent + '  ')}`
      }
      if (Array.isArray(v)) {
        return `${indent}${k}:\n${toYaml(v, indent + '  ')}`
      }
      return `${indent}${k}: ${toYaml(v, indent)}`
    }).join('\n')
  }
  return String(obj)
}

function fields(body: Record<string,unknown>, allowed: string[]): string[] {
  return allowed.filter(k => k in body)
}
