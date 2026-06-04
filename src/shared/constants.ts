export const APP_NAME = 'OpenBlueprint'
export const APP_VERSION = '0.1.0'
export const DEFAULT_OUTPUT_DIR = 'output'
export const MAX_GENERATION_RETRIES = 3
export const GENERATION_TIMEOUT_MS = 120_000
export const DEFAULT_MODEL = 'deepseek-chat'
export const DEFAULT_PROVIDER = 'deepseek'
export const MAX_CONVERSATION_TOKENS = 128_000

export const AGENT_STATUS = {
  PENDING: 'pending',
  QUEUED: 'queued',
  GENERATING: 'generating',
  VALIDATING: 'validating',
  COMPLETED: 'completed',
  FAILED: 'failed',
  RETRYING: 'retrying'
} as const

export const PROJECT_STATUS = {
  IDLE: 'idle',
  GENERATING: 'generating',
  COMPLETED: 'completed',
  ERROR: 'error'
} as const

export const PROJECT_MODE = {
  PROJECT: 'project',
  STANDALONE: 'standalone'
} as const

export const RELATIONSHIP_TYPE = {
  DEPENDS_ON: 'depends_on',
  COMMUNICATES_WITH: 'communicates_with',
  SHARES_DATA: 'shares_data'
} as const

export const GENERATION_SESSION_STATUS = {
  RUNNING: 'running',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed'
} as const

export const LOG_LEVEL = {
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  DEBUG: 'debug'
} as const
