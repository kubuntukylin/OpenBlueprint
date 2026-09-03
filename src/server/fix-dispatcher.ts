// ============================================================
// Fix Dispatcher — automated fix loop for failing tests
// Uses Claude Code CLI for intelligent code fixes.
// ============================================================
import { execSync } from 'child_process'
import { join } from 'path'
import { existsSync } from 'fs'
import { getDB } from './db'
import { logGeneration } from './log'
import { runTestPipeline } from './test-runner'
import { analyzeAll, groupByStrategy, type FixStrategy, type AnalyzedFailure } from './error-analyzer'
import { startClaudeCodeAction } from './generator'
import type { WebSocket } from 'ws'

const MAX_FIX_ATTEMPTS = 3

// ---- Fix Loop Entry Point ----
export async function runFixLoop(
  agentId: string,
  agentDir: string,
  sessionId: string,
  wssClients: Set<WebSocket>,
  broadcast: (type: string, payload: unknown) => void
): Promise<boolean> {
  const db = getDB()

  for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
    broadcast('test:fix-attempt', { agentId, attempt, maxAttempts: MAX_FIX_ATTEMPTS })
    logGeneration({ sessionId, agentId, level: 'info', message: `Fix attempt ${attempt}/${MAX_FIX_ATTEMPTS}`, phase: 'validate' })

    // Step 1: Run test pipeline to get fresh failures
    const pipelineResult = await runTestPipeline(agentId, agentDir, sessionId, broadcast)
    if (pipelineResult.passed) {
      logGeneration({ sessionId, agentId, level: 'info', message: 'All tests passed after fix', phase: 'validate' })
      db.prepare("UPDATE test_results SET fix_attempts=?, status='passed', updated_at=? WHERE agent_id=? AND session_id=?")
        .run(attempt, new Date().toISOString(), agentId, sessionId)
      broadcast('test:fix-result', { agentId, attempt, status: 'passed' })
      return true
    }

    // Step 2: Analyze all failures
    const allFailures = pipelineResult.results.flatMap(r => r.failures)

    // Fast escalation: if all failures are infrastructure-related, don't waste fix attempts
    const infraFailures = allFailures.filter(f => f.category === 'missing_dep' || f.category === 'unknown')
    if (infraFailures.length === allFailures.length && allFailures.length > 0) {
      logGeneration({ sessionId, agentId, level: 'warn', message: 'Infrastructure issues detected — skipping fix loop', phase: 'validate', metadata: { failures: allFailures.map(f => f.message) } })
      broadcast('test:escalated', { agentId, reason: 'Infrastructure issues (vitest/npm) — skipping auto-fix' })
      return false
    }

    const analyzed = analyzeAll(allFailures, agentDir)

    // Step 3: Escalate if any failure can't be auto-fixed
    if (analyzed.some(a => a.fixStrategy === 'escalate')) {
      logGeneration({ sessionId, agentId, level: 'error', message: 'Unfixable errors detected — escalating', phase: 'validate' })
      broadcast('test:escalated', { agentId, reason: 'Unclassifiable error — manual review needed' })
      return false
    }

    // Step 4: Group by strategy and apply fixes (batched by strategy)
    const grouped = groupByStrategy(analyzed)
    let allFixed = true

    for (const [strategy, items] of grouped) {
      const success = await applyFix(agentId, agentDir, strategy, items, broadcast)
      if (!success) { allFixed = false; break }
    }

    // Step 5: Update fix attempt count
    db.prepare(`UPDATE test_results SET fix_attempts=?, last_error=?, updated_at=? WHERE agent_id=? AND session_id=?`)
      .run(attempt, analyzed.map(f => f.original.message).join('; ').slice(0, 500), new Date().toISOString(), agentId, sessionId)

    broadcast('test:fix-result', { agentId, attempt, status: allFixed ? 'retrying' : 'partial' })

    if (!allFixed) continue // try next round
  }

  logGeneration({ sessionId, agentId, level: 'error', message: `All ${MAX_FIX_ATTEMPTS} fix attempts exhausted`, phase: 'validate' })
  return false
}

// ---- Apply Fix per Strategy ----
async function applyFix(
  agentId: string,
  agentDir: string,
  strategy: FixStrategy,
  failures: AnalyzedFailure[],
  broadcast: (type: string, payload: unknown) => void
): Promise<boolean> {
  switch (strategy) {
    case 'add_dependency': {
      const pkgs = extractMissingPackages(failures)
      for (const pkg of pkgs) {
        try { execSync(`npm install ${pkg}`, { cwd: agentDir, timeout: 30_000, stdio: 'pipe' }) }
        catch { /* skip failed install */ }
      }
      return pkgs.length > 0
    }

    case 'install_deps': {
      try { execSync('npm install', { cwd: agentDir, timeout: 60_000, stdio: 'pipe' }); return true }
      catch { return false }
    }

    case 'create_file': {
      // Create missing file with minimal content
      const missing = failures[0]
      if (missing.original.file && !existsSync(join(agentDir, missing.original.file))) {
        try {
          const { generateDefaultTests } = require('./test-runner')
          generateDefaultTests(agentDir, agentId)
          return true
        } catch { return false }
      }
      return false
    }

    case 'edit_file':
    case 'modify_test': {
      // Use Claude Code to fix code errors
      const errors = failures.map(f => `- ${f.original.file}:${f.original.line}: ${f.original.message}`).join('\n')
      const context = failures.map(f => f.context).join('\n\n')
      return applyFixViaClaudeCode(agentId, agentDir, errors, context, broadcast)
    }

    default:
      return false
  }
}

// ---- Fix via Claude Code CLI ----
function applyFixViaClaudeCode(
  agentId: string,
  agentDir: string,
  errors: string,
  context: string,
  broadcast: (type: string, payload: unknown) => void
): Promise<boolean> {
  const prompt = `Fix all failing tests in this microservice agent. The agent directory is at "${agentDir}".

## Test Failures
${errors}

## Code Context
${context}

## Instructions
1. First, use Read to examine the failing files
2. Identify the root cause of each failure
3. Use Edit to fix the code — make the MINIMAL changes needed
4. After fixing ALL errors, run: cd ${agentDir} && npx tsc --noEmit && npx vitest run
5. If tests still fail, iterate until they pass
6. Do NOT refactor unrelated code. Fix ONLY what's broken.

Be thorough but minimal. Fix all errors in one pass if possible.`

  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 180_000) // 3 min max

    const onDone = (data: unknown) => {
      const d = data as Record<string, unknown>
      if (d.agentId === agentId || !d.agentId) {
        clearTimeout(timeout)
        resolve(d.status === 'completed')
      }
    }

    // Listen for fix completion
    const { api } = require('../renderer/api')
    const unsub = api.on('action:done', onDone)

    try {
      startClaudeCodeAction({
        conversationId: `fix-${agentId}-${Date.now()}`,
        messageId: `fix-msg-${Date.now()}`,
        prompt,
        projectId: null,
        outputDir: agentDir,
      }, new Set())
    } catch {
      clearTimeout(timeout)
      unsub?.()
      resolve(false)
    }
  })
}

// ---- Helper ----
function extractMissingPackages(failures: AnalyzedFailure[]): string[] {
  const pkgs = new Set<string>()
  for (const f of failures) {
    const m = f.original.message.match(/Cannot find module '([^']+)'/)
    if (m && m[1] && !m[1].startsWith('.') && !m[1].startsWith('/')) {
      // Strip subpath: 'express/lib' -> 'express'
      pkgs.add(m[1].split('/')[0])
    }
  }
  return [...pkgs]
}
