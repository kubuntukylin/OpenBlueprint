// ============================================================
// OpenBlueprint Server — Express + WebSocket
// ============================================================
import express from 'express'
import cors from 'cors'
import http from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { spawn } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { getDB, initDB } from './db'
import { registerRoutes } from './routes'
import { APP_NAME } from '../shared/constants'
import { logger, traceStorage, shortId, setGenLogWriter, dumpCrashReport, type GenLogEvent } from './log'
import { drain, setShuttingDown, isShuttingDown, startQueuePoller } from './generator'

const PORT = parseInt(process.env.PORT || '3001', 10)
const isDev = process.env.NODE_ENV !== 'production'

async function main() {
  const app = express()
  const server = http.createServer(app)

  // WebSocket — all connected clients
  const wss = new WebSocketServer({ server, path: '/ws' })
  const clients = new Set<WebSocket>()
  wss.on('connection', (ws) => {
    clients.add(ws)
    ws.on('close', () => clients.delete(ws))
  })

  // Middleware
  app.use(cors())
  app.use(express.json({ limit: '10mb' }))

  // Static files (production)
  const root = process.cwd()
  const distPath = join(root, 'out/renderer')
  if (!isDev && existsSync(distPath)) app.use(express.static(distPath))

  // Database
  await initDB()

  // Recover agents stuck in queued/generating state from previous crash
  const db = getDB()

  // Wire generation_logs persister (after DB is ready)
  setGenLogWriter((evt: GenLogEvent) => {
    try {
      db.prepare(`INSERT INTO generation_logs (id,session_id,agent_id,log_level,message,phase,metadata_json,created_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(randomUUID(), evt.sessionId, evt.agentId || null, evt.level, evt.message, evt.phase || null,
          JSON.stringify(evt.metadata || {}), new Date().toISOString())
    } catch { /* best-effort */ }
  })

  const stuckAgents = db.prepare("SELECT * FROM agents WHERE status IN ('queued','generating')").all() as Record<string,unknown>[]
  if (stuckAgents.length > 0) {
    logger.warn({ count: stuckAgents.length }, 'recovering stuck agents from previous crash')

    // Phase-aware recovery: check checkpoints before resetting
    for (const a of stuckAgents) {
      const agentId = a.id as string
      const t = new Date().toISOString()

      // Check latest generation checkpoint
      const checkpoint = db.prepare('SELECT * FROM generation_checkpoints WHERE agent_id=? ORDER BY created_at DESC LIMIT 1').get(agentId) as Record<string,unknown> | undefined

      if (checkpoint) {
        const phase = checkpoint.phase as string
        if (phase === 'complete') {
          // Agent finished but status wasn't updated before crash — mark completed
          const cpData = JSON.parse((checkpoint.checkpoint_json as string) || '{}')
          db.prepare("UPDATE agents SET status=?, updated_at=? WHERE id=?")
            .run(cpData.status === 'failed' ? 'failed' : 'completed', t, agentId)
          logger.info({ agentId, phase, status: cpData.status }, 'agent checkpoint recovered as complete')
          continue
        }
        if (phase === 'generate') {
          // Worker was spawned but crashed mid-generation.
          // Check if the spec file still exists, and if so, re-enqueue.
          const cpData = JSON.parse((checkpoint.checkpoint_json as string) || '{}')
          const specFile = cpData.specFile as string | undefined
          if (specFile && existsSync(specFile)) {
            // Spec file exists — re-enqueue for regeneration
            db.prepare("UPDATE agents SET status='pending', error_message='Server restarted — resuming from checkpoint', updated_at=? WHERE id=?")
              .run(t, agentId)
            // The queue poller will pick this up on startup
            logger.info({ agentId, phase, specFile }, 'agent re-enqueued from checkpoint')
            continue
          }
        }
      }

      // Default: reset to pending — no usable checkpoint found
      db.prepare("UPDATE agents SET status='pending', error_message='Server restarted — re-confirm to regenerate', updated_at=? WHERE id=?")
        .run(t, agentId)
    }

    // Clean up generation_queue for stuck claimed/running jobs (released by queue poller on startup)
    db.prepare(`DELETE FROM generation_queue WHERE status='completed' AND updated_at < ?`).run(new Date(Date.now() - 7 * 86400000).toISOString())
    db.saveDebounced()
  }

  // Clean up orphaned relationships (source or target agent no longer exists)
  const orphanedBefore = db.prepare("SELECT COUNT(*) as c FROM agent_relationships WHERE source_agent_id NOT IN (SELECT id FROM agents) OR target_agent_id NOT IN (SELECT id FROM agents)").get() as Record<string,unknown> | undefined
  db.prepare("DELETE FROM agent_relationships WHERE source_agent_id NOT IN (SELECT id FROM agents) OR target_agent_id NOT IN (SELECT id FROM agents)").run()
  const orphanCount = orphanedBefore?.c as number || 0
  if (orphanCount > 0) logger.info({ count: orphanCount }, 'cleaned up orphaned relationships')

  // Clean up empty assistant placeholder messages from crashed Build sessions
  const emptyBefore = db.prepare("SELECT COUNT(*) as c FROM messages WHERE role='assistant' AND content=''").get() as Record<string,unknown> | undefined
  db.prepare("DELETE FROM messages WHERE role='assistant' AND content=''").run()
  const emptyCount = emptyBefore?.c as number || 0
  if (emptyCount > 0) logger.info({ count: emptyCount }, 'cleaned up empty placeholder messages')
  db.saveDebounced()

  // Three-phase graceful shutdown
  const doShutdown = async () => {
    if (isShuttingDown) return // prevent double-trigger
    setShuttingDown()
    logger.info('phase 1: stopping HTTP server and notifying clients')

    // Phase 1: Stop accepting new requests
    for (const ws of clients) {
      try { ws.send(JSON.stringify({ type: 'server:shutting-down', payload: {} })) } catch { /* ok */ }
      try { ws.close() } catch { /* ok */ }
    }
    clients.clear()
    server.close()

    // Phase 2: Drain in-flight generations (max 15s grace period)
    if (typeof drain === 'function') {
      logger.info('phase 2: draining in-flight generations')
      try { await Promise.race([drain(15_000), new Promise(r => setTimeout(r, 20_000))]) }
      catch { /* ignore drain errors */ }
      logger.info('phase 2: drain complete')
    }

    // Phase 3: Final save and exit
    logger.info('phase 3: final checkpoint and exit')
    db.checkpoint()
    process.exit(0)
  }

  // Restart sequence
  const doRestart = () => {
    db.checkpoint()
    const script = process.argv[1]
    const child = spawn(process.execPath,
      script?.endsWith('.ts') ? ['--require', 'tsx/cjs', script] : [script],
      { detached: true, stdio: 'inherit', cwd: root, env: { ...process.env } }
    )
    child.unref()
    setTimeout(doShutdown, 600)
  }

  // Routes
  registerRoutes(app, clients, doShutdown, doRestart)

  // SPA fallback
  if (!isDev) {
    app.get('*', (_req, res) => {
      const indexPath = join(root, 'out/renderer/index.html')
      existsSync(indexPath) ? res.sendFile(indexPath) : res.status(404).send('Not found')
    })
  }

  // OS signals — delegate to graceful shutdown
  process.on('SIGINT', () => { logger.info('received SIGINT'); doShutdown() })
  process.on('SIGTERM', () => { logger.info('received SIGTERM'); doShutdown() })
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception')
    dumpCrashReport(err)
    db.checkpoint()
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'unhandled rejection')
    if (reason instanceof Error) dumpCrashReport(reason)
    db.checkpoint()
    process.exit(1)
  })

  server.listen(PORT, () => {
    console.log(`\n  ${APP_NAME}  http://localhost:${PORT}  |  ws://localhost:${PORT}/ws\n`)
    logger.info({ port: PORT }, 'server started')
    // Start persistent queue poller for crash-survivable generation
    startQueuePoller(clients)
  })
}

main().catch(console.error)
