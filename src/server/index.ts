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
import { getDB, initDB, saveDB } from './db'
import { registerRoutes } from './routes'
import { APP_NAME } from '../shared/constants'

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
  const stuckAgents = db.prepare("SELECT * FROM agents WHERE status IN ('queued','generating')").all() as Record<string,unknown>[]
  if (stuckAgents.length > 0) {
    console.log(`[startup] Recovering ${stuckAgents.length} stuck agents`)
    for (const a of stuckAgents) {
      db.prepare("UPDATE agents SET status='pending', error_message='Server restarted — re-confirm to regenerate', updated_at=? WHERE id=?")
        .run(new Date().toISOString(), a.id)
    }
    saveDB()
  }

  // Clean up orphaned relationships (source or target agent no longer exists)
  const orphaned = db.prepare("DELETE FROM agent_relationships WHERE source_agent_id NOT IN (SELECT id FROM agents) OR target_agent_id NOT IN (SELECT id FROM agents)").run()
  if (orphaned) console.log(`[startup] Cleaned up ${orphaned} orphaned relationships`)
  saveDB()

  // Shutdown sequence
  const doShutdown = () => {
    for (const ws of clients) try { ws.close() } catch { /* ok */ }
    clients.clear()
    server.close(() => { saveDB(); process.exit(0) })
    setTimeout(() => { saveDB(); process.exit(0) }, 2000)
  }

  // Restart sequence
  const doRestart = () => {
    saveDB()
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

  // OS signals
  process.on('SIGINT', () => { saveDB(); process.exit(0) })
  process.on('SIGTERM', () => { saveDB(); process.exit(0) })
  process.on('uncaughtException', (err) => {
    console.error('[FATAL]', err)
    saveDB()
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Unhandled rejection:', reason)
    saveDB()
    process.exit(1)
  })

  server.listen(PORT, () => {
    console.log(`\n  ${APP_NAME}  http://localhost:${PORT}  |  ws://localhost:${PORT}/ws\n`)
  })
}

main().catch(console.error)
