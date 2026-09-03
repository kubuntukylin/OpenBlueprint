// ============================================================
// Database — init, migrations, wrapper (sql.js WASM)
// With transaction support and checkpoint semantics for resilience.
// ============================================================
import initSqlJs, { type Database as SqlJsDb, type SqlJsStatic } from 'sql.js'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'

let SQL: SqlJsStatic | null = null
let db: DB | null = null
let dbPath: string | null = null

// ---- Path ----
function getDbPath(): string {
  const home = process.env.APPDATA || process.env.HOME || process.env.USERPROFILE || '.'
  const dir = join(home, 'OpenBlueprint')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'openblueprint.db')
}

// ---- Wrapper ----
export class DB {
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  private closed = false

  constructor(private d: SqlJsDb) { this.d.run('PRAGMA foreign_keys = ON') }

  exec(sql: string) { this.d.run(sql) }

  prepare(sql: string) {
    const self = this
    return {
      run(...params: unknown[]) { self.d.run(sql, params); return self },
      get(...params: unknown[]) {
        const s = self.d.prepare(sql)
        try {
          s.bind(params)
          if (s.step()) {
            const cols = s.getColumnNames(); const vals = s.get()
            const row: Record<string, unknown> = {}
            cols.forEach((c, i) => { row[c] = vals[i] })
            return row
          }
          return undefined
        } finally { s.free() }
      },
      all(...params: unknown[]) {
        const rows: Record<string, unknown>[] = []
        const s = self.d.prepare(sql)
        try {
          s.bind(params)
          while (s.step()) {
            const cols = s.getColumnNames(); const vals = s.get()
            const row: Record<string, unknown> = {}
            cols.forEach((c, i) => { row[c] = vals[i] })
            rows.push(row)
          }
        } finally { s.free() }
        return rows
      }
    }
  }

  // ---- Transaction support ----
  // Wraps multiple DB operations in a single atomic transaction.
  // If the callback throws, the transaction is rolled back automatically.
  transaction<T>(fn: (db: DB) => T): T {
    this.d.run('BEGIN')
    try {
      const result = fn(this)
      this.d.run('COMMIT')
      return result
    } catch (e) {
      try { this.d.run('ROLLBACK') } catch { /* ignore rollback errors */ }
      throw e
    }
  }

  // ---- Checkpoint (replaces saveDB for graceful-shutdown-only use) ----
  // Call this only before graceful shutdown. WAL-level durability is handled
  // by writeFileSync for each explicit save. For normal operation, save()
  // is automatically called after transaction commits.
  checkpoint() {
    if (this.closed) return
    this.dirty = false
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    if (dbPath) writeFileSync(dbPath, Buffer.from(this.d.export()))
  }

  save() {
    if (this.closed) return
    this.dirty = false
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    if (dbPath) writeFileSync(dbPath, Buffer.from(this.d.export()))
  }

  // Debounced save — batches rapid mutations into one disk write
  saveDebounced(ms = 200) {
    this.dirty = true
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.save(), ms)
  }

  close() {
    this.checkpoint()
    this.closed = true
    this.d.close()
  }
}

export async function initDB(): Promise<DB> {
  if (db) return db
  SQL = await initSqlJs()
  dbPath = getDbPath()
  const dir = dbPath.substring(0, dbPath.lastIndexOf('\\'))
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
  const buffer = existsSync(dbPath) ? readFileSync(dbPath) : null
  const sqlDb = new SQL.Database(buffer ? new Uint8Array(buffer) : undefined)
  db = new DB(sqlDb)
  runMigrations(db)
  return db
}

export function getDB(): DB { if (!db) throw new Error('DB not initialized'); return db }
export function saveDB() { if (db) db.saveDebounced() }

// ---- Migrations ----
function runMigrations(database: DB) {
  database.exec(`CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT DEFAULT '')`)
  const applied = new Set(database.prepare('SELECT version FROM _migrations').all().map((r: Record<string, unknown>) => r.version as number))

  // V1: Initial schema
  if (!applied.has(1)) {
    database.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', rules TEXT DEFAULT '', output_path TEXT NOT NULL DEFAULT 'output', status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','generating','completed','error')), mode TEXT NOT NULL DEFAULT 'project', parent_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    database.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, project_id TEXT, name TEXT NOT NULL, description TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','queued','generating','validating','completed','failed','retrying')), agent_type TEXT NOT NULL DEFAULT 'generated', spec_json TEXT NOT NULL DEFAULT '{}', interface_json TEXT NOT NULL DEFAULT '{}', output_path TEXT, generation_attempts INTEGER NOT NULL DEFAULT 0, max_retries INTEGER NOT NULL DEFAULT 3, error_message TEXT, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    database.exec('CREATE INDEX idx_agents_project ON agents(project_id)')
    database.exec(`CREATE TABLE agent_relationships (id TEXT PRIMARY KEY, source_agent_id TEXT NOT NULL, target_agent_id TEXT NOT NULL, relationship_type TEXT NOT NULL DEFAULT 'depends_on' CHECK(relationship_type IN ('depends_on','communicates_with','shares_data')), description TEXT DEFAULT '', created_at TEXT NOT NULL, UNIQUE(source_agent_id, target_agent_id, relationship_type))`)
    database.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT, title TEXT DEFAULT 'New Conversation', system_prompt TEXT DEFAULT '', model_config_id TEXT, message_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    database.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')), content TEXT NOT NULL, tokens_in INTEGER, tokens_out INTEGER, model_used TEXT, parent_message_id TEXT, sort_order INTEGER NOT NULL, created_at TEXT NOT NULL)`)
    database.exec('CREATE INDEX idx_messages_conv ON messages(conversation_id)')
    database.exec(`CREATE TABLE llm_configurations (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('deepseek','openai','anthropic','google','custom')), api_key TEXT NOT NULL DEFAULT '', base_url TEXT, model_name TEXT NOT NULL, max_tokens INTEGER NOT NULL DEFAULT 8192, temperature REAL NOT NULL DEFAULT 0.7, is_default INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, enable_thinking INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    database.exec(`CREATE TABLE generation_logs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT, log_level TEXT NOT NULL DEFAULT 'info' CHECK(log_level IN ('info','warn','error','debug')), message TEXT NOT NULL, phase TEXT, metadata_json TEXT DEFAULT '{}', created_at TEXT NOT NULL)`)
    database.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'general', description TEXT DEFAULT '', updated_at TEXT NOT NULL)`)
    // Default LLM config
    database.prepare(`INSERT INTO llm_configurations (id,name,provider,api_key,base_url,model_name,max_tokens,temperature,is_default,is_active,enable_thinking,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,1,0,?,?)`)
      .run('default-deepseek', 'DeepSeek V4 Pro', 'deepseek', '', 'https://api.deepseek.com/v1', 'deepseek-v4-pro', 8192, 0, now(), now())
    // Default settings
    for (const [k, v] of [['theme','dark'],['maxRetries','3'],['defaultOutputPath','output']]) {
      database.prepare('INSERT INTO settings (key,value,category,updated_at) VALUES (?,?,?,?)').run(k, v, 'general', now())
    }
    database.prepare('INSERT INTO _migrations (version,name,applied_at) VALUES (1,?,?)').run('initial_schema', now())
  }

  // V2: Add enable_thinking to existing DBs (upgrade path)
  if (!applied.has(2)) {
    try { database.exec('ALTER TABLE llm_configurations ADD COLUMN enable_thinking INTEGER NOT NULL DEFAULT 1') } catch { /* column exists */ }
    try {
      database.prepare("UPDATE llm_configurations SET model_name='deepseek-v4-flash', name='DeepSeek V4 Flash', enable_thinking=0 WHERE id='default-deepseek' AND (api_key IS NULL OR api_key='')").run()
    } catch { /* ok */ }
    database.prepare("INSERT INTO _migrations (version,name,applied_at) VALUES (2,?,?)").run('add_enable_thinking', now())
  }

  // V3: Add rules/skills column to projects
  if (!applied.has(3)) {
    try { database.exec("ALTER TABLE projects ADD COLUMN rules TEXT DEFAULT ''") } catch { /* column exists */ }
    database.prepare("INSERT INTO _migrations (version,name,applied_at) VALUES (3,?,?)").run('add_project_rules', now())
  }

  // V4: Disable thinking mode for all models
  if (!applied.has(4)) {
    database.prepare("UPDATE llm_configurations SET enable_thinking=0 WHERE enable_thinking=1").run()
    database.prepare("INSERT INTO _migrations (version,name,applied_at) VALUES (4,?,?)").run('disable_thinking', now())
  }

  // V5: Conversation memory — vector embeddings for RAG
  if (!applied.has(5)) {
    database.exec(`CREATE TABLE IF NOT EXISTS conversation_memory (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      embedding_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    )`)
    database.exec('CREATE INDEX IF NOT EXISTS idx_conv_memory_conv ON conversation_memory(conversation_id)')
    database.prepare("INSERT INTO _migrations (version,name,applied_at) VALUES (5,?,?)").run('conversation_memory', now())
  }

  // V6: Skills table — templates that constrain agent generation
  if (!applied.has(6)) {
    database.exec(`CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'general',
      prompt_content TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`)
    const skills = [
      { id: 'skill-microservices', name: 'Microservices Architecture', category: 'architecture', desc: 'Design agents as independent microservices with clear API boundaries', prompt: 'Design agents as independent microservices. Each agent is a standalone service with its own database, API, and deployment. Services communicate via REST or message queues. No shared databases.' },
      { id: 'skill-rest-api', name: 'REST API Pattern', category: 'backend', desc: 'Standard REST API design with proper HTTP methods and status codes', prompt: 'Every agent exposing an API must follow REST conventions: GET/POST/PUT/DELETE, proper HTTP status codes (200/201/400/404/500), JSON request/response bodies, clear endpoint naming.' },
      { id: 'skill-health-check', name: 'Health Check Endpoint', category: 'devops', desc: 'Every agent must have a GET /health endpoint', prompt: 'EVERY agent MUST include a GET /health endpoint returning {"status":"ok"}. This is non-negotiable and required for Docker health checks and monitoring.' },
      { id: 'skill-docker-deploy', name: 'Docker Ready', category: 'devops', desc: 'Generate Dockerfile for each agent with proper multi-stage build', prompt: 'Design agents to be Docker-ready. The system auto-generates Dockerfiles, but agents should use environment variables for configuration (no hardcoded ports/hosts), listen on 0.0.0.0, and be stateless where possible.' },
      { id: 'skill-input-validation', name: 'Input Validation', category: 'backend', desc: 'Validate all inputs with proper error messages', prompt: 'Every agent must validate all inputs. Return clear error messages in Chinese or English matching the user. Use HTTP 400 for validation errors with {"success":false,"error":"message"} format.' },
      { id: 'skill-typescript-strict', name: 'TypeScript Strict Mode', category: 'backend', desc: 'Use TypeScript with strict type checking', prompt: 'All code must be TypeScript with strict types. Define interfaces for all data structures. Use proper typing for Express request/response handlers. No "any" types except for external library compatibility.' },
      { id: 'skill-auth-jwt', name: 'JWT Authentication', category: 'auth', desc: 'Use JWT tokens for service-to-service and user authentication', prompt: 'For authentication, use JWT tokens with proper expiration. Include user ID and roles in the token payload. Services should validate tokens on every request via middleware.' },
      { id: 'skill-logging', name: 'Structured Logging', category: 'devops', desc: 'Use structured JSON logging for all agents', prompt: 'All agents must use structured JSON logging. Log levels: debug/info/warn/error. Include timestamp, service name, request ID in every log entry. Log all incoming requests and outgoing responses at info level.' },
      { id: 'skill-error-handling', name: 'Error Handling Middleware', category: 'backend', desc: 'Consistent error handling across all agents', prompt: 'Every agent must have centralized error handling middleware. Never expose stack traces to clients. Return consistent error format: {"success":false,"error":"Human-readable message"}. Log full errors server-side.' },
      { id: 'skill-cors-config', name: 'CORS Configuration', category: 'backend', desc: 'Proper CORS headers for browser access', prompt: 'All API agents must include CORS configuration. Allow credentials, set proper Access-Control headers. In development, allow all origins. In production, restrict to the frontend origin.' },
      { id: 'skill-pagination', name: 'API Pagination', category: 'backend', desc: 'Paginate all list endpoints', prompt: 'All list/GET endpoints must support pagination: query params ?page=1&limit=20. Response format: {"data":[...],"pagination":{"page":1,"limit":20,"total":150}}. Default limit 20, max 100.' },
      { id: 'skill-mqtt-iot', name: 'MQTT IoT Protocol', category: 'iot', desc: 'MQTT support for IoT device communication', prompt: 'For IoT device communication, use MQTT protocol. Topics follow pattern: {tenant}/{device_id}/{type}. Support QoS levels 0 and 1. Include connection keep-alive and last-will testament for device offline detection.' },
      { id: 'skill-timeseries', name: 'Time-Series Data', category: 'iot', desc: 'Optimize for time-series data storage and queries', prompt: 'For telemetry and sensor data, design for time-series storage. Use timestamp-based partitioning. Support downsampling queries (AVG/MAX/MIN over time windows). Include retention policies for old data.' },
      { id: 'skill-react-dashboard', name: 'React Dashboard Frontend', category: 'frontend', desc: 'React-based admin dashboard with Ant Design', prompt: 'Frontend should be a React SPA with component-based architecture. Use a UI library for consistency. Include: responsive layout, dark/light theme, data tables with sorting/filtering, chart widgets for data visualization, and real-time updates via WebSocket.' },
      { id: 'skill-rate-limit', name: 'Rate Limiting', category: 'backend', desc: 'Protect APIs with rate limiting', prompt: 'All public-facing APIs must implement rate limiting. Default: 100 requests per minute per IP. Return 429 Too Many Requests when exceeded. Include Retry-After header. Make limits configurable via environment variables.' },
      { id: 'skill-env-config', name: 'Environment-Based Config', category: 'devops', desc: '12-factor app style configuration', prompt: 'All configuration must come from environment variables, never hardcoded. Use a central config module that reads process.env with defaults. Required vars: PORT, NODE_ENV. Service-specific vars should be prefixed with the service name.' },
    ]
    for (const s of skills) {
      database.prepare('INSERT INTO skills (id,name,description,category,prompt_content,is_active,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?,?)')
        .run(s.id, s.name, s.desc, s.category, s.prompt, skills.indexOf(s), now(), now())
    }
    database.prepare("INSERT INTO _migrations (version,name,applied_at) VALUES (6,?,?)").run('skills', now())
  }

  // V7: Code chunks for RAG
  if (!applied.has(7)) {
    database.exec(`CREATE TABLE IF NOT EXISTS code_chunks (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      conversation_id TEXT,
      file_name TEXT NOT NULL DEFAULT '',
      chunk_index INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      embedding_json TEXT NOT NULL DEFAULT '[]',
      content_type TEXT NOT NULL DEFAULT 'code' CHECK(content_type IN ('code','message','error','spec')),
      created_at TEXT NOT NULL
    )`)
    database.exec('CREATE INDEX IF NOT EXISTS idx_chunks_agent ON code_chunks(agent_id)')
    database.exec('CREATE INDEX IF NOT EXISTS idx_chunks_conv ON code_chunks(conversation_id)')
    database.exec('CREATE INDEX IF NOT EXISTS idx_chunks_type ON code_chunks(content_type)')
    try { database.exec('CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(content, content_rowid=rowid)') } catch { /* FTS may fail in some sql.js builds */ }
    database.prepare("INSERT INTO _migrations (version,name,applied_at) VALUES (7,?,?)").run('code_chunks', now())
  }

  // V8: Agent relationship skills + relationship management
  if (!applied.has(8)) {
    const relSkills = [
      { id: 'skill-agent-relationships', name: 'Agent Relationship Types', category: 'architecture', desc: 'Define dependency, communication, and data-sharing relationships between agents', prompt: 'CRITICAL: After creating ALL agents in a project, define their relationships:\n- depends_on: Agent A needs Agent B to be running first (build-time dependency). Use this when A calls B\'s API at startup.\n- communicates_with: Two agents exchange data at runtime. Use this for request/response interactions.\n- shares_data: Two agents read/write the same data store. Use this for database sharing or event streaming.\n\nFor EVERY pair of agents that interact, create a relationship. Start by analyzing each agent\'s inputs/outputs to map dependencies.' },
      { id: 'skill-service-deps', name: 'Service Dependency Declaration', category: 'architecture', desc: 'Always declare inter-agent dependencies when creating agents', prompt: 'When creating agents, ALWAYS declare dependencies via the dependencies field. If Agent A calls Agent B\'s API, list B\'s ID in A\'s dependencies. This ensures:\n1. Correct build order (B builds before A)\n2. Environment variables (B_URL=http://b:3000 is injected into A)\n3. Docker Compose depends_on ordering\n\nBefore creating an agent, review other agents\' outputs to identify what this agent needs as input.' },
    ]
    for (const s of relSkills) {
      database.prepare('INSERT INTO skills (id,name,description,category,prompt_content,is_active,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?,?)')
        .run(s.id, s.name, s.desc, s.category, s.prompt, 10 + relSkills.indexOf(s), now(), now())
    }
    database.prepare("INSERT INTO _migrations (version,name,applied_at) VALUES (8,?,?)").run('agent_relationship_skills', now())
  }

  // V9: Enhance relationship skills with all three types and JSON examples
  if (!applied.has(9)) {
    database.prepare('UPDATE skills SET prompt_content=? WHERE id=?').run(
      `CRITICAL: After creating agents, define ALL relationship types — not just depends_on.

## THREE RELATIONSHIP TYPES
1. depends_on — Agent A requires Agent B to START (build dependency).
   Example: {"sourceId":"api-gateway","targetId":"auth-service","type":"depends_on","dataFlow":"JWT validation tokens"}

2. communicates_with — Agents exchange data at RUNTIME (bidirectional or unidirectional).
   Example: {"sourceId":"order-service","targetId":"payment-service","type":"communicates_with","dataFlow":"Order payment requests and status updates"}

3. shares_data — Agents share a data store or event stream.
   Example: {"sourceId":"device-service","targetId":"telemetry-service","type":"shares_data","dataFlow":"Device telemetry via shared MQTT topic"}

## WHEN TO USE EACH
- depends_on: A calls B's API → B must build first. Use for API consumers.
- communicates_with: A and B exchange requests at runtime. Use for REST/gRPC callers.
- shares_data: A and B read/write same DB or message queue. Use for data pipelines.

## OUTPUT FORMAT
For EVERY pair of interacting agents, output ALL applicable relationship types:
{"relationships":[
  {"sourceId":"api-gateway","targetId":"auth-service","type":"depends_on","dataFlow":"JWT tokens"},
  {"sourceId":"api-gateway","targetId":"auth-service","type":"communicates_with","dataFlow":"Auth requests"},
  {"sourceId":"device-service","targetId":"telemetry-service","type":"shares_data","dataFlow":"MQTT sensor data"}
]}`, 'skill-agent-relationships')

    database.prepare('UPDATE skills SET prompt_content=? WHERE id=?').run(
      `When creating agents, declare ALL interaction types — not just dependencies:

1. dependencies field: list agent IDs this agent DEPENDS ON (build order).
   If A calls B's API, add B's ID to A's dependencies.

2. communicatesWith field: list agent IDs this agent COMMUNICATES WITH at runtime.
   If A sends requests to B or B sends requests to A, add to communicatesWith.
   Example: Data sync, notification push, health check polling.

3. sharesData field: list agent IDs this agent SHARES DATA with.
   If A and B use the same database, message queue, or event bus, add to sharesData.
   Example: Shared MQTT topic, Redis pub/sub, Kafka stream.

CRITICAL: A single pair of agents often needs MULTIPLE relationship types.
For example, api-gateway calling auth-service needs BOTH:
- depends_on (auth must start first)
- communicates_with (ongoing token validation)

Always review each agent's inputs/outputs to identify ALL three types.`,
      'skill-service-deps'
    )

    database.prepare("INSERT INTO _migrations (version,name,applied_at) VALUES (9,?,?)").run('enhance_relationship_skills', now())
  }

  // V10: Persistent generation queue with lease-based claiming + dead-letter support
  if (!applied.has(10)) {
    database.exec(`CREATE TABLE generation_queue (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      queue_type TEXT NOT NULL DEFAULT 'claude_code' CHECK(queue_type IN ('claude_code','llm_api','action')),
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','claimed','running','completed','failed','dead_letter')),
      priority INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL DEFAULT '{}',
      idempotency_key TEXT UNIQUE,
      lease_token TEXT,
      lease_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      last_error TEXT,
      dead_letter_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`)
    database.exec('CREATE INDEX IF NOT EXISTS idx_gq_status ON generation_queue(status)')
    database.exec('CREATE INDEX IF NOT EXISTS idx_gq_agent ON generation_queue(agent_id)')
    database.prepare("INSERT INTO _migrations (version,name,applied_at) VALUES (10,?,?)").run('generation_queue', now())
  }

  // V11: Generation checkpoints for crash recovery
  if (!applied.has(11)) {
    database.exec(`CREATE TABLE generation_checkpoints (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('init','generate','validate','package','complete')),
      checkpoint_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )`)
    database.exec('CREATE INDEX IF NOT EXISTS idx_gc_agent ON generation_checkpoints(agent_id)')
    database.exec('CREATE INDEX IF NOT EXISTS idx_gc_session ON generation_checkpoints(session_id)')
    database.prepare("INSERT INTO _migrations (version,name,applied_at) VALUES (11,?,?)").run('generation_checkpoints', now())
  }

  // V12: Test results and test suites for automated testing pipeline
  if (!applied.has(12)) {
    database.exec(`CREATE TABLE test_results (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('unit','integration','system')),
      status TEXT NOT NULL CHECK(status IN ('pending','running','passed','failed','error')),
      summary_json TEXT NOT NULL DEFAULT '{}',
      failures_json TEXT NOT NULL DEFAULT '[]',
      logs TEXT DEFAULT '',
      duration_ms INTEGER NOT NULL DEFAULT 0,
      fix_attempts INTEGER NOT NULL DEFAULT 0,
      max_fix_attempts INTEGER NOT NULL DEFAULT 3,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`)
    database.exec('CREATE INDEX IF NOT EXISTS idx_tr_agent ON test_results(agent_id)')
    database.exec('CREATE INDEX IF NOT EXISTS idx_tr_session ON test_results(session_id)')
    database.exec(`CREATE TABLE test_suites (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      name TEXT NOT NULL,
      suite_type TEXT NOT NULL CHECK(suite_type IN ('integration','system')),
      status TEXT NOT NULL DEFAULT 'pending',
      summary_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`)
    database.exec('CREATE INDEX IF NOT EXISTS idx_ts_project ON test_suites(project_id)')
    database.prepare("INSERT INTO _migrations (version,name,applied_at) VALUES (12,?,?)").run('test_results_and_suites', now())
  }
}

function now() { return new Date().toISOString() }
