// ============================================================
// MCP Server — stdio JSON-RPC 2.0 proxy to OpenBlueprint HTTP API
// Spawned by Claude Code CLI via --mcp-config
// Does NOT import db.ts/llm.ts — uses fetch to call localhost:3001
// ============================================================

const OB_API = process.env.OB_API_URL || 'http://localhost:3001'
const TIMEOUT_MS = 30000

// ---- JSON-RPC 2.0 helpers ----
type JsonRpcRequest = { jsonrpc: '2.0'; id: number | null; method: string; params?: Record<string,unknown> }
type JsonRpcResponse = { jsonrpc: '2.0'; id: number | null; result?: unknown; error?: { code: number; message: string; data?: unknown } }

function ok(id: number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}
function err(id: number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}
function write(resp: JsonRpcResponse) {
  process.stdout.write(JSON.stringify(resp) + '\n')
}

// ---- HTTP helper ----
async function apiFetch(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = OB_API + path
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }
  if (body !== undefined) opts.body = JSON.stringify(body)
  const resp = await fetch(url, opts)
  const text = await resp.text()
  if (!resp.ok) {
    let msg = text
    try { msg = JSON.parse(text).error || text } catch { /* raw text */ }
    throw new Error(`${resp.status}: ${msg}`)
  }
  try { return JSON.parse(text) } catch { return text }
}

// ---- Tool definitions ----
interface ToolDef {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, { type: string; description: string; items?: { type: string } }>
    required?: string[]
  }
}

const TOOLS: Record<string, { def: ToolDef; handler: (args: Record<string,unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> }> = {
  list_agents: {
    def: {
      name: 'list_agents',
      description: 'List all agents in an OpenBlueprint project. Returns each agent\'s id, name, description, status, technologies, inputs, outputs, and dependencies. Use this FIRST whenever the user asks about agents — never assume you know what agents exist.',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string', description: 'Optional project ID to filter by. If omitted, lists all agents across all projects.' } },
      },
    },
    handler: async (args) => {
      const pid = args.projectId as string | undefined
      const agents = await apiFetch('GET', '/api/agents' + (pid ? '?projectId=' + pid : '')) as Record<string,unknown>[]
      // Return a concise but complete view — id, name, status, description
      const summary = agents.map(a => ({
        id: a.id,
        name: a.name,
        status: a.status,
        description: a.description,
        projectId: a.projectId,
        technologies: (() => { try { return JSON.parse((a.specJson as string) || '{}').technologies || [] } catch { return [] } })(),
        inputs: (() => { try { return JSON.parse((a.interfaceJson as string) || '{}').inputs || [] } catch { return [] } })(),
        outputs: (() => { try { return JSON.parse((a.interfaceJson as string) || '{}').outputs || [] } catch { return [] } })(),
      }))
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] }
    },
  },

  create_agent: {
    def: {
      name: 'create_agent',
      description: 'Create a new agent in an OpenBlueprint project. The agent is created as "pending" and will appear in the project graph. Do NOT create agents that already exist — use update_agent instead.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project ID to create the agent in' },
          name: { type: 'string', description: 'Human-readable agent name (Title Case)' },
          description: { type: 'string', description: 'What this agent does (1-2 sentences)' },
          responsibilities: { type: 'array', items: { type: 'string' }, description: 'List of specific tasks this agent performs' },
          technologies: { type: 'array', items: { type: 'string' }, description: 'npm packages / technologies used' },
          dependencies: { type: 'array', items: { type: 'string' }, description: 'IDs or names of agents this one depends on' },
          inputs: { type: 'array', items: { type: 'object' }, description: 'Data inputs: [{name, type, source}] where source is an agent ID' },
          outputs: { type: 'array', items: { type: 'object' }, description: 'Data outputs: [{name, type, destination}] where destination is an agent ID' },
          complexity: { type: 'string', description: 'low, medium, or high' },
        },
        required: ['projectId', 'name'],
      },
    },
    handler: async (args) => {
      const spec = {
        id: (args.name as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        name: args.name,
        description: args.description || '',
        responsibilities: args.responsibilities || [],
        technologies: args.technologies || [],
        complexity: args.complexity || 'medium',
      }
      const iface = { inputs: args.inputs || [], outputs: args.outputs || [] }
      const body = {
        projectId: args.projectId,
        name: args.name,
        description: args.description || '',
        specJson: spec,
        interfaceJson: iface,
        dependencies: args.dependencies || [],
      }
      const agent = await apiFetch('POST', '/api/agents', body)
      return { content: [{ type: 'text', text: JSON.stringify(agent, null, 2) }] }
    },
  },

  update_agent: {
    def: {
      name: 'update_agent',
      description: 'Modify an EXISTING agent. Use this to rename, change description, update dependencies, or modify I/O interfaces. Only specify the fields you want to change — unspecified fields are left unchanged.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'The agent\'s ID (from list_agents). Required.' },
          name: { type: 'string', description: 'New name for the agent' },
          description: { type: 'string', description: 'New description' },
          responsibilities: { type: 'array', items: { type: 'string' }, description: 'Updated responsibilities' },
          technologies: { type: 'array', items: { type: 'string' }, description: 'Updated technologies' },
          dependencies: { type: 'array', items: { type: 'string' }, description: 'Updated dependency agent IDs' },
          inputs: { type: 'array', items: { type: 'object' }, description: 'Updated inputs' },
          outputs: { type: 'array', items: { type: 'object' }, description: 'Updated outputs' },
          complexity: { type: 'string', description: 'Updated complexity level' },
        },
        required: ['agentId'],
      },
    },
    handler: async (args) => {
      // Separate agent fields from dependencies
      const body: Record<string,unknown> = {}
      const passthrough = ['agentId','name','description','responsibilities','technologies','inputs','outputs','complexity']
      for (const k of passthrough) { if (args[k] !== undefined) body[k] = args[k] }
      // dependencies is a special case — requires relationship management in the route
      if (Array.isArray(args.dependencies)) body['dependencies'] = args.dependencies
      const agent = await apiFetch('PUT', '/api/agents/' + args.agentId, body)
      return { content: [{ type: 'text', text: JSON.stringify(agent, null, 2) }] }
    },
  },

  delete_agent: {
    def: {
      name: 'delete_agent',
      description: 'PERMANENTLY delete an agent and all its relationships. This cannot be undone. Only delete agents the user explicitly asked to remove. Use list_agents first to confirm the agent ID.',
      inputSchema: {
        type: 'object',
        properties: { agentId: { type: 'string', description: 'The agent\'s ID to delete (from list_agents)' } },
        required: ['agentId'],
      },
    },
    handler: async (args) => {
      await apiFetch('DELETE', '/api/agents/' + args.agentId)
      return { content: [{ type: 'text', text: `Agent ${args.agentId} deleted successfully.` }] }
    },
  },

  list_agent_files: {
    def: {
      name: 'list_agent_files',
      description: 'List all generated source files for a specific agent. Returns file names, paths, and sizes. Use this FIRST before reading files — you need to know what files exist before you can read them. Use the agent ID from list_agents results.',
      inputSchema: {
        type: 'object',
        properties: { agentId: { type: 'string', description: 'Agent ID from list_agents' } },
        required: ['agentId'],
      },
    },
    handler: async (args) => {
      const files = await apiFetch('GET', '/api/agents/' + args.agentId + '/files')
      return { content: [{ type: 'text', text: JSON.stringify(files, null, 2) }] }
    },
  },

  list_file_tree: {
    def: {
      name: 'list_file_tree',
      description: 'Get the full recursive file tree of an agent\'s output directory. Shows all files and subdirectories with sizes. Use this to understand the complete structure of an agent\'s code before modifying multiple files.',
      inputSchema: {
        type: 'object',
        properties: { agentId: { type: 'string', description: 'Agent ID from list_agents' } },
        required: ['agentId'],
      },
    },
    handler: async (args) => {
      const tree = await apiFetch('GET', '/api/agents/' + args.agentId + '/file-tree')
      return { content: [{ type: 'text', text: JSON.stringify(tree, null, 2) }] }
    },
  },

  read_file: {
    def: {
      name: 'read_file',
      description: 'Read the content of a generated file from an agent\'s output directory.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path relative to the output directory' } },
        required: ['path'],
      },
    },
    handler: async (args) => {
      const result = await apiFetch('GET', '/api/files?path=' + encodeURIComponent(args.path as string)) as Record<string,unknown> | null
      return { content: [{ type: 'text', text: (result && typeof result.content === 'string' ? result.content : '(empty)') }] }
    },
  },

  write_file: {
    def: {
      name: 'write_file',
      description: 'Write or overwrite a file in an agent\'s output directory. Use this to create or update generated code files.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the output directory' },
          content: { type: 'string', description: 'File content to write' },
        },
        required: ['path', 'content'],
      },
    },
    handler: async (args) => {
      await apiFetch('PUT', '/api/files', { path: args.path, content: args.content })
      return { content: [{ type: 'text', text: `File written: ${args.path} (${(args.content as string).length} bytes)` }] }
    },
  },

  exec_shell: {
    def: {
      name: 'exec_shell',
      description: 'Execute a shell command in the project\'s output directory. Use this to install npm packages, run builds, start services, or check system state. Long-running commands will time out after 30 seconds.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          cwd: { type: 'string', description: 'Working directory. Defaults to "output"' },
        },
        required: ['command'],
      },
    },
    handler: async (args) => {
      // This is a fire-and-forget command — we get the PID back
      // For MCP purposes, we use a synchronous variant via the API
      const result = await apiFetch('POST', '/api/shell/exec-sync', {
        command: args.command,
        cwd: args.cwd || 'output',
      }) as Record<string,unknown>
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  },

  list_projects: {
    def: {
      name: 'list_projects',
      description: 'List all OpenBlueprint projects. Use this to get project IDs and names before operating on agents within a project.',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: async () => {
      const projects = await apiFetch('GET', '/api/projects') as Record<string,unknown>[]
      const summary = projects.map(p => ({ id: p.id, name: p.name, description: p.description, status: p.status, mode: p.mode }))
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] }
    },
  },

  get_project_context: {
    def: {
      name: 'get_project_context',
      description: 'Get full project context: all agents with relationships, project rules, active skills. Use this at the START of any action to understand the current state before making changes.',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string', description: 'Project ID' } },
        required: ['projectId'],
      },
    },
    handler: async (args) => {
      const project = await apiFetch('GET', '/api/projects/' + args.projectId) as Record<string,unknown>
      const agents = await apiFetch('GET', '/api/agents?projectId=' + args.projectId) as Record<string,unknown>[]
      const rels = await apiFetch('GET', '/api/relationships?projectId=' + args.projectId) as Record<string,unknown>[]
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ project, agents, relationships: rels }, null, 2),
        }],
      }
    },

    create_relationship: {
      def: {
        name: 'create_relationship',
        description: 'Create a relationship between two agents. Types: depends_on (Agent A depends on B being ready first), communicates_with (runtime data exchange), shares_data (shared data store). Creating relationships is ESSENTIAL for correct build order and service discovery.',
        inputSchema: {
          type: 'object',
          properties: {
            sourceAgentId: { type: 'string', description: 'The source agent ID (the one that depends on or communicates with the target)' },
            targetAgentId: { type: 'string', description: 'The target agent ID (the one being depended on / communicated with)' },
            relationshipType: { type: 'string', description: 'depends_on, communicates_with, or shares_data' },
            description: { type: 'string', description: 'What data flows between them (e.g., "Auth tokens", "Device telemetry")' },
          },
          required: ['sourceAgentId', 'targetAgentId', 'relationshipType'],
        },
      },
      handler: async (args) => {
        const body = {
          sourceAgentId: args.sourceAgentId,
          targetAgentId: args.targetAgentId,
          relationshipType: args.relationshipType || 'depends_on',
          description: args.description || '',
        }
        const rel = await apiFetch('POST', '/api/relationships', body)
        return { content: [{ type: 'text', text: JSON.stringify(rel, null, 2) }] }
      },
    },

    delete_relationship: {
      def: {
        name: 'delete_relationship',
        description: 'Delete a relationship between two agents. Use this to remove incorrect or outdated connections.',
        inputSchema: {
          type: 'object',
          properties: {
            relationshipId: { type: 'string', description: 'The relationship ID to delete (from get_project_context relationships)' },
          },
          required: ['relationshipId'],
        },
      },
      handler: async (args) => {
        await apiFetch('DELETE', '/api/relationships/' + args.relationshipId)
        return { content: [{ type: 'text', text: `Relationship ${args.relationshipId} deleted.` }] }
      },
    },

    analyze_relationships: {
      def: {
        name: 'analyze_relationships',
        description: 'CRITICAL — Call this AFTER creating ALL agents in a project. Uses AI to analyze agent interfaces (inputs/outputs) and automatically create depends_on, communicates_with, and shares_data relationships. This MUST be called before code generation to ensure correct build order.',
        inputSchema: {
          type: 'object',
          properties: {
            projectId: { type: 'string', description: 'Project ID to analyze' },
          },
          required: ['projectId'],
        },
      },
      handler: async (args) => {
        const result = await apiFetch('POST', '/api/projects/' + args.projectId + '/analyze-relationships', {})
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      },
    },
  },
}

// ---- JSON-RPC method handlers ----
async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  switch (req.method) {
    case 'initialize':
      return ok(req.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'openblueprint-mcp', version: '1.0.0' },
      })

    case 'tools/list':
      return ok(req.id, { tools: Object.values(TOOLS).map(t => t.def) })

    case 'tools/call': {
      const params = req.params || {}
      const toolName = params.name as string
      const toolArgs = (params.arguments || {}) as Record<string,unknown>
      const tool = TOOLS[toolName]
      if (!tool) return err(req.id, -32601, `Unknown tool: ${toolName}`)
      try {
        const result = await tool.handler(toolArgs)
        return ok(req.id, result)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return ok(req.id, { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true })
      }
    }

    case 'notifications/initialized':
      // No response for notifications
      // Return a dummy response that won't be written
      return null as unknown as JsonRpcResponse

    default:
      return err(req.id, -32601, `Method not found: ${req.method}`)
  }
}

// ---- Main stdio loop ----
let buffer = ''

process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk: string) => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() || ''

  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const req: JsonRpcRequest = JSON.parse(line)
      if (req.jsonrpc !== '2.0') continue

      handleRequest(req).then(resp => {
        if (resp) write(resp)
      }).catch(e => {
        console.error('[mcp-server] unhandled error:', e)
        if (req.id !== null) write(err(req.id, -32603, 'Internal error: ' + (e instanceof Error ? e.message : String(e))))
      })
    } catch {
      // Non-JSON line, skip
    }
  }
})

process.stdin.on('end', () => { /* Claude Code closed stdin */ })
process.stderr.write('[mcp-server] OpenBlueprint MCP Server started, API: ' + OB_API + '\n')
