// ============================================================
// Structured Logging — Pino + AsyncLocalStorage
// Every log line auto-includes requestId / sessionId context.
// generation_logs are persisted to DB for post-hoc debugging.
// ============================================================
import pino from 'pino'
import { AsyncLocalStorage } from 'async_hooks'
import { randomUUID } from 'crypto'
import { writeFileSync } from 'fs'
import { join } from 'path'

// ---- Types ----
export interface TraceContext {
  requestId: string
  sessionId?: string
  agentId?: string
}

// ---- AsyncLocalStorage for request tracing ----
export const traceStorage = new AsyncLocalStorage<TraceContext>()

// ---- Logger ----
const isDev = process.env.NODE_ENV !== 'production'

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, ignore: 'pid,hostname', translateTime: 'HH:MM:ss' }
    }
  }),
  mixin() {
    const ctx = traceStorage.getStore()
    return ctx ? { req: ctx.requestId, sid: ctx.sessionId || undefined, aid: ctx.agentId || undefined } : {}
  },
  formatters: {
    level(label) { return { level: label } }
  }
})

// ---- Generation Logging (writes to DB for post-hoc debugging) ----
let _logGenFn: ((evt: GenLogEvent) => void) | null = null

export interface GenLogEvent {
  sessionId: string
  agentId?: string
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
  phase?: string
  metadata?: Record<string, unknown>
}

export function setGenLogWriter(fn: (evt: GenLogEvent) => void) { _logGenFn = fn }

export function logGeneration(evt: GenLogEvent) {
  logger[evt.level]({ phase: evt.phase, ...evt.metadata }, evt.message)
  try { _logGenFn?.(evt) } catch { /* best-effort */ }
}

// ---- Fatal error dump ----
export function dumpCrashReport(err: Error) {
  try {
    const home = process.env.APPDATA || process.env.HOME || process.env.USERPROFILE || '.'
    const report = {
      error: err.message,
      stack: err.stack,
      pid: process.pid,
      time: new Date().toISOString(),
      cwd: process.cwd()
    }
    writeFileSync(
      join(home, 'OpenBlueprint', `crash-${Date.now()}.json`),
      JSON.stringify(report, null, 2)
    )
  } catch { /* best-effort — don't crash the crash handler */ }
}

// ---- Short request ID helper ----
export function shortId() { return randomUUID().slice(0, 8) }
