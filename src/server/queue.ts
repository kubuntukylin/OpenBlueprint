// ============================================================
// Persistent Job Queue — SQLite-backed, lease-based claiming
// Survives server restarts. Idempotency keys prevent duplicates.
// ============================================================
import { randomUUID, createHash } from 'crypto'
import { getDB } from './db'

// ---- Types ----
export type QueueType = 'claude_code' | 'llm_api' | 'action'

export interface QueueJob {
  id: string
  agentId: string
  queueType: QueueType
  status: string
  priority: number
  leaseToken: string | null
  leaseExpiresAt: string | null
  attemptCount: number
  maxAttempts: number
  lastError: string | null
}

// ---- Idempotency key ----
export function idempotencyKey(agentId: string, attemptNumber: number): string {
  const round = Math.floor(Date.now() / 60000)
  return createHash('sha256').update(`${agentId}|${attemptNumber}|${round}`).digest('hex').slice(0, 32)
}

function now() { return new Date().toISOString() }
function d() { return getDB() }

const QC = 'id, agent_id as agentId, queue_type as queueType, status, priority, lease_token as leaseToken, lease_expires_at as leaseExpiresAt, attempt_count as attemptCount, max_attempts as maxAttempts, last_error as lastError'

function qJob(row: Record<string,unknown> | undefined): QueueJob | null {
  if (!row) return null
  return {
    id: row.id as string, agentId: row.agentId as string, queueType: row.queueType as QueueType,
    status: row.status as string, priority: (row.priority as number) || 0,
    leaseToken: (row.leaseToken as string) || null, leaseExpiresAt: (row.leaseExpiresAt as string) || null,
    attemptCount: (row.attemptCount as number) || 0, maxAttempts: (row.maxAttempts as number) || 3,
    lastError: (row.lastError as string) || null
  }
}

// ---- Queue Operations ----

export function enqueue(agentId: string, queueType: QueueType, payload: Record<string, unknown> = {}): QueueJob | null {
  const db = d()
  const key = idempotencyKey(agentId, 0)
  const existing = db.prepare("SELECT id FROM generation_queue WHERE idempotency_key=? AND status IN ('queued','claimed','running')")
    .get(key) as Record<string,unknown> | undefined
  if (existing) return null

  const id = randomUUID()
  const t = now()
  db.prepare(`INSERT INTO generation_queue (id,agent_id,queue_type,status,payload_json,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, agentId, queueType, 'queued', JSON.stringify(payload), key, t, t)
  return qJob(db.prepare(`SELECT ${QC} FROM generation_queue WHERE id=?`).get(id) as Record<string,unknown> | undefined)
}

export function claimJob(maxConcurrent: number, currentlyRunning: number): QueueJob | null {
  if (currentlyRunning >= maxConcurrent) return null
  const db = d()
  const t = now()
  const leaseExpiry = new Date(Date.now() + 10 * 60_000).toISOString()
  const token = randomUUID()

  const job = db.prepare(`SELECT ${QC} FROM generation_queue WHERE status='queued' ORDER BY priority DESC, created_at ASC LIMIT 1`)
    .get() as Record<string,unknown> | undefined
  if (!job) return null

  db.prepare("UPDATE generation_queue SET status='claimed', lease_token=?, lease_expires_at=?, updated_at=? WHERE id=?")
    .run(token, leaseExpiry, t, job.id)
  return qJob(db.prepare(`SELECT ${QC} FROM generation_queue WHERE id=?`).get(job.id) as Record<string,unknown> | undefined)
}

export function heartbeatJob(leaseToken: string): void {
  const leaseExpiry = new Date(Date.now() + 10 * 60_000).toISOString()
  d().prepare("UPDATE generation_queue SET lease_expires_at=?, updated_at=? WHERE lease_token=? AND status IN ('claimed','running')")
    .run(leaseExpiry, now(), leaseToken)
}

export function markRunning(leaseToken: string): void {
  d().prepare("UPDATE generation_queue SET status='running', updated_at=? WHERE lease_token=?").run(now(), leaseToken)
}

export function completeJob(leaseToken: string): void {
  d().prepare("UPDATE generation_queue SET status='completed', updated_at=? WHERE lease_token=?").run(now(), leaseToken)
}

export function failJob(leaseToken: string, error: string): QueueJob | null {
  const db = d()
  const job = db.prepare(`SELECT ${QC} FROM generation_queue WHERE lease_token=?`).get(leaseToken) as Record<string,unknown> | undefined
  if (!job) return null
  const attempts = (job.attemptCount as number || 0) + 1
  const max = (job.maxAttempts as number) || 3

  if (attempts < max) {
    const newKey = idempotencyKey(job.agentId as string, attempts)
    db.prepare("UPDATE generation_queue SET status='queued', lease_token=NULL, lease_expires_at=NULL, attempt_count=?, last_error=?, idempotency_key=?, updated_at=? WHERE id=?")
      .run(attempts, error, newKey, now(), job.id)
  } else {
    db.prepare("UPDATE generation_queue SET status='dead_letter', last_error=?, dead_letter_reason='Max attempts exhausted', updated_at=? WHERE id=?")
      .run(error, now(), job.id)
  }
  return qJob(db.prepare(`SELECT ${QC} FROM generation_queue WHERE id=?`).get(job.id) as Record<string,unknown> | undefined)
}

export function releaseExpiredLeases(): number {
  const db = d()
  const t = now()
  const expired = db.prepare(`SELECT ${QC} FROM generation_queue WHERE lease_expires_at IS NOT NULL AND lease_expires_at < ? AND status IN ('claimed','running')`)
    .all(t) as Record<string,unknown>[]
  for (const row of expired) {
    const attempts = (row.attemptCount as number || 0) + 1
    const max = (row.maxAttempts as number) || 3
    if (attempts < max) {
      db.prepare("UPDATE generation_queue SET status='queued', lease_token=NULL, lease_expires_at=NULL, attempt_count=?, last_error='Lease expired', updated_at=? WHERE id=?")
        .run(attempts, t, row.id)
    } else {
      db.prepare("UPDATE generation_queue SET status='dead_letter', last_error='Lease expired', dead_letter_reason='Max attempts exhausted', updated_at=? WHERE id=?")
        .run(t, row.id)
    }
  }
  return expired.length
}

export function listDeadLetters(): Record<string,unknown>[] {
  return d().prepare(`SELECT ${QC} FROM generation_queue WHERE status='dead_letter' ORDER BY updated_at DESC`).all()
}

export function retryDeadLetter(jobId: string): QueueJob | null {
  const db = d()
  const job = db.prepare(`SELECT ${QC} FROM generation_queue WHERE id=? AND status='dead_letter'`).get(jobId) as Record<string,unknown> | undefined
  if (!job) return null
  const newKey = idempotencyKey(job.agentId as string, 0)
  db.prepare("UPDATE generation_queue SET status='queued', attempt_count=0, last_error=NULL, dead_letter_reason=NULL, idempotency_key=?, lease_token=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?")
    .run(newKey, now(), jobId)
  return qJob(db.prepare(`SELECT ${QC} FROM generation_queue WHERE id=?`).get(jobId) as Record<string,unknown> | undefined)
}

export function queueStats() {
  const db = d()
  return {
    queued: (db.prepare("SELECT COUNT(*) as c FROM generation_queue WHERE status='queued'").get() as Record<string,unknown>)?.c || 0,
    claimed: (db.prepare("SELECT COUNT(*) as c FROM generation_queue WHERE status IN ('claimed','running')").get() as Record<string,unknown>)?.c || 0,
    dead: (db.prepare("SELECT COUNT(*) as c FROM generation_queue WHERE status='dead_letter'").get() as Record<string,unknown>)?.c || 0,
    completed: (db.prepare("SELECT COUNT(*) as c FROM generation_queue WHERE status='completed'").get() as Record<string,unknown>)?.c || 0,
  }
}
