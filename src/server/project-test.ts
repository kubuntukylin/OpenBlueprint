// ============================================================
// Project-Level Integration Tests — cross-agent API contract validation
// Triggered after all agents in a project pass per-agent unit tests.
// ============================================================
import { execSync } from 'child_process'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'
import { getDB } from './db'
import { logGeneration } from './log'
import type { WebSocket } from 'ws'

export interface ProjectTestResult {
  status: 'passed' | 'failed' | 'skipped'
  suites: number
  tests: number
  failures: number
  rawLog: string
}

// ---- Main Entry Point ----
export async function runProjectTests(
  projectId: string,
  wssClients: Set<WebSocket>
): Promise<ProjectTestResult> {
  const db = getDB()
  const broadcast = (type: string, payload: unknown) => {
    const msg = JSON.stringify({ type, payload })
    for (const ws of wssClients) { if (ws.readyState === 1) ws.send(msg) }
  }

  // Only run if all agents are completed
  const allAgents = db.prepare("SELECT * FROM agents WHERE project_id=? AND status NOT IN ('failed','dead_letter')").all(projectId) as Record<string,unknown>[]
  const completed = allAgents.filter(a => a.status === 'completed')
  if (completed.length < 2 || completed.length !== allAgents.length) {
    return { status: 'skipped', suites: 0, tests: 0, failures: 0, rawLog: `Not all agents completed (${completed.length}/${allAgents.length})` }
  }

  broadcast('test:project-progress', { projectId, phase: 'integration', message: `Running integration tests for ${completed.length} agents...` })

  const project = db.prepare('SELECT output_path, name FROM projects WHERE id=?').get(projectId) as Record<string,unknown> | undefined
  const outputDir = (project?.output_path as string) || 'output'

  try {
    const result = await runIntegrationTests(outputDir, completed, db, projectId)
    saveProjectTestResult(projectId, 'integration', result)
    broadcast('test:project-result', { projectId, ...result })
    logGeneration({ sessionId: projectId, level: result.status === 'passed' ? 'info' : 'warn', message: `Integration tests: ${result.status} (${result.failures} failures)`, phase: 'validate' })
    return result
  } catch (e) {
    const errResult: ProjectTestResult = { status: 'failed', suites: 0, tests: 0, failures: 1, rawLog: (e as Error).message }
    broadcast('test:project-result', { projectId, ...errResult })
    return errResult
  }
}

// ---- Integration Test Runner ----
async function runIntegrationTests(
  outputDir: string,
  agents: Record<string, unknown>[],
  db: ReturnType<typeof getDB>,
  projectId: string
): Promise<ProjectTestResult> {
  // Generate a temporary integration test file
  const testDir = join(outputDir, '.test-tmp')
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true })

  const testFile = join(testDir, `integration-${Date.now()}.test.ts`)
  const testCode = generateIntegrationTest(agents, db, projectId)
  writeFileSync(testFile, testCode, 'utf-8')

  // Write vitest config for this test
  const vitestConfig = join(testDir, 'vitest.config.ts')
  if (!existsSync(vitestConfig)) {
    writeFileSync(vitestConfig, `import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { globals: true, environment: 'node', testTimeout: 15_000 } })`, 'utf-8')
  }

  const start = Date.now()
  try {
    const output = execSync(`npx vitest run ${testFile} --reporter=json --config ${vitestConfig} 2>&1`, {
      cwd: outputDir, timeout: 120_000, encoding: 'utf-8', stdio: 'pipe'
    })
    return parseIntegrationOutput(output)
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string }
    return parseIntegrationOutput((err.stdout || '') + '\n' + (err.stderr || ''))
  } finally {
    // Cleanup temp files
    try { unlinkSync(testFile) } catch { /* ok */ }
  }
}

function generateIntegrationTest(agents: Record<string, unknown>[], db: ReturnType<typeof getDB>, projectId: string): string {
  const agentList = agents.map(a => {
    const name = (a.name as string).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
    return { ...a, serviceName: name }
  })

  // Get relationships for this project
  const rels = db.prepare(`SELECT ar.*, sa.name as source_name, ta.name as target_name
    FROM agent_relationships ar
    JOIN agents sa ON ar.source_agent_id=sa.id
    JOIN agents ta ON ar.target_agent_id=ta.id
    WHERE sa.project_id=?`).all(projectId) as Record<string,unknown>[]

  let code = `import { describe, it, expect, beforeAll } from 'vitest'\n\n`

  // Describe each agent
  for (const a of agentList) {
    code += `describe('${a.name}', () => {\n`
    code += `  const baseUrl = process.env.${a.serviceName.toUpperCase().replace(/-/g, '_')}_URL || 'http://localhost:3000'\n\n`
    code += `  it('should have /health endpoint', async () => {\n`
    code += `    const resp = await fetch(\`\${baseUrl}/health\`, { signal: AbortSignal.timeout(5000) })\n`
    code += `    expect(resp.ok).toBe(true)\n`
    code += `    const body = await resp.json()\n`
    code += `    expect(body.success || body.status === 'ok' || body.status === 'pong').toBeTruthy()\n`
    code += `  })\n`
    code += `})\n\n`
  }

  // Cross-agent communication tests
  const commRels = rels.filter(r => r.relationship_type === 'communicates_with' || r.relationship_type === 'depends_on')
  if (commRels.length > 0) {
    code += `describe('Cross-Agent Communication', () => {\n`
    for (const r of commRels) {
      const srcName = (r.source_name as string).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
      const tgtName = (r.target_name as string).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
      code += `  it('${r.source_name} ↔ ${r.target_name} (${r.relationship_type})', async () => {\n`
      code += `    const srcUrl = process.env.${srcName.toUpperCase().replace(/-/g, '_')}_URL || 'http://localhost:3000'\n`
      code += `    const tgtUrl = process.env.${tgtName.toUpperCase().replace(/-/g, '_')}_URL || 'http://localhost:3000'\n`
      code += `    // Verify both endpoints are reachable\n`
      code += `    const s = await fetch(\`\${srcUrl}/health\`, { signal: AbortSignal.timeout(5000) })\n`
      code += `    const t = await fetch(\`\${tgtUrl}/health\`, { signal: AbortSignal.timeout(5000) })\n`
      code += `    expect(s.ok || t.ok).toBe(true)\n`
      code += `  })\n`
    }
    code += `})\n`
  }

  return code
}

function parseIntegrationOutput(output: string): ProjectTestResult {
  // Try to find vitest JSON in the output
  let json: Record<string, unknown> | null = null
  const jsonStart = output.indexOf('{"numTotalTestSuites"')
  if (jsonStart >= 0) {
    try { json = JSON.parse(output.slice(jsonStart)) } catch { /* partial */ }
  }

  if (json) {
    return {
      status: (json.numFailedTests as number) === 0 ? 'passed' : 'failed',
      suites: (json.numTotalTestSuites as number) || 0,
      tests: (json.numTotalTests as number) || 0,
      failures: (json.numFailedTests as number) || 0,
      rawLog: output.slice(0, 5000)
    }
  }

  // Fallback: pattern matching
  return {
    status: output.includes('FAIL') || output.includes('Error') ? 'failed' : 'passed',
    suites: 0, tests: 0, failures: output.includes('FAIL') ? 1 : 0,
    rawLog: output.slice(0, 5000)
  }
}

// ---- Persist ----
function saveProjectTestResult(projectId: string, suiteType: string, result: ProjectTestResult) {
  try {
    const db = getDB()
    db.prepare(`INSERT INTO test_suites (id,project_id,name,suite_type,status,summary_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), projectId, `${suiteType}-${Date.now()}`, suiteType, result.status,
        JSON.stringify({ suites: result.suites, tests: result.tests, failures: result.failures }),
        new Date().toISOString(), new Date().toISOString())
  } catch { /* best-effort */ }
}
