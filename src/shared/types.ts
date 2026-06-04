// ============================================================
// OpenBlueprint — Shared Types
// Single source of truth for all data structures
// ============================================================

// ---- Project ----
export interface Project {
  id: string
  name: string
  description: string
  outputPath: string
  status: 'idle' | 'generating' | 'completed' | 'error'
  mode: 'project' | 'standalone'
  parentId: string | null
  createdAt: string
  updatedAt: string
}

// ---- Agent ----
export interface Agent {
  id: string
  projectId: string | null
  name: string
  description: string
  status: 'pending' | 'queued' | 'generating' | 'validating' | 'completed' | 'failed' | 'retrying'
  agentType: 'generated' | 'manual' | 'template'
  specJson: string
  interfaceJson: string
  outputPath: string | null
  generationAttempts: number
  maxRetries: number
  errorMessage: string | null
  sortOrder: number
  createdAt: string
  updatedAt: string
}

// ---- Agent Relationship ----
export interface AgentRelationship {
  id: string
  sourceAgentId: string
  targetAgentId: string
  relationshipType: 'depends_on' | 'communicates_with' | 'shares_data'
  description: string
  createdAt: string
}

// ---- Conversation ----
export interface Conversation {
  id: string
  projectId: string | null
  title: string
  systemPrompt: string
  modelConfigId: string | null
  messageCount: number
  createdAt: string
  updatedAt: string
}

// ---- Message ----
export interface Message {
  id: string
  conversationId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  tokensIn: number | null
  tokensOut: number | null
  modelUsed: string | null
  parentMessageId: string | null
  sortOrder: number
  createdAt: string
}

// ---- LLM Configuration ----
export interface LLMConfig {
  id: string
  name: string
  provider: 'deepseek' | 'openai' | 'anthropic' | 'google' | 'custom'
  apiKey: string
  baseUrl: string | null
  modelName: string
  maxTokens: number
  temperature: number
  enableThinking: boolean
  isDefault: boolean
  isActive: boolean
  createdAt: string
  updatedAt: string
}

// ---- Generation Log ----
export interface GenerationLog {
  id: string
  sessionId: string
  agentId: string | null
  logLevel: 'info' | 'warn' | 'error' | 'debug'
  message: string
  phase: string | null
  metadataJson: string
  createdAt: string
}

// ---- Terminal Output ----
export interface TerminalEntry {
  sessionId: string
  text: string
  stream: 'stdout' | 'stderr'
  timestamp: number
}

// ---- Code Generation Constraints ----
export interface CodeGenConstraints {
  packageAllowlist: string[]
  requiredFiles: string[]
  responseFormat: { successKey: string; dataKey: string; errorKey: string }
  moduleRules: { file: string; canImport: string[] }[]
  extraDependencies: string[]
}

export const DEFAULT_CONSTRAINTS: CodeGenConstraints = {
  packageAllowlist: ['express', 'cors', 'axios', 'dotenv', 'uuid', 'express-validator', 'tsx'],
  requiredFiles: ['types.ts', 'config.ts', 'service.ts', 'index.ts', 'README.md'],
  responseFormat: { successKey: 'success', dataKey: 'data', errorKey: 'error' },
  moduleRules: [
    { file: 'config.ts', canImport: ['types.ts'] },
    { file: 'service.ts', canImport: ['types.ts', 'config.ts'] },
    { file: 'index.ts', canImport: ['service.ts', 'config.ts', 'types.ts'] },
  ],
  extraDependencies: []
}

// ---- Help Documentation ----
export interface HelpDoc {
  id: string
  category: 'docker' | 'deployment' | 'code-gen' | 'troubleshooting' | 'architecture'
  title: string
  content: string
  tags: string[]
  severity: 'info' | 'warning' | 'critical'
  author: string
  createdAt: string
  updatedAt: string
}

export const HELP_CATEGORIES: Record<string, string> = {
  docker: 'Docker & 容器', deployment: '部署流程', 'code-gen': '代码生成',
  troubleshooting: '故障排查', architecture: '架构设计'
}

// ---- Constants ----
export const THINKING_MODELS = new Set<string>([])  // disabled: no R1 reasoning mode
export const AGENT_STATUS_COLORS: Record<string, string> = {
  pending: '#6b7280', queued: '#e5a50a', generating: '#e5a50a',
  validating: '#3b82f6', completed: '#22c55e', failed: '#ef4444', retrying: '#e5a50a'
}
export const EDGE_COLORS: Record<string, string> = {
  depends_on: '#ef4444', communicates_with: '#3b82f6', shares_data: '#22c55e'
}
