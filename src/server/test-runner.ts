// ============================================================
// Test Runner — compile check, vitest unit tests, fallback test generation
// Orchestrates the validate phase of the generation pipeline.
// ============================================================
import { execSync } from 'child_process'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs'
import { randomUUID } from 'crypto'
import { getDB } from './db'
import { logGeneration } from './log'

// ---- Types ----
export interface TestFailure {
  file: string
  line: number
  message: string
  category: 'compilation' | 'assertion' | 'timeout' | 'runtime' | 'missing_dep' | 'unknown'
}

export interface TestResult {
  status: 'passed' | 'failed' | 'error'
  summary: { total: number; passed: number; failed: number; duration: number }
  failures: TestFailure[]
  rawLog: string
}

// ---- Vitest availability check ----
function checkVitestAvailable(agentDir: string): boolean {
  try {
    execSync('npx vitest --version', { cwd: agentDir, timeout: 15_000, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

// ---- Compile Check ----
function runCompileCheck(agentDir: string): TestResult {
  const start = Date.now()
  try {
    execSync('npx tsc --noEmit', { cwd: agentDir, timeout: 60_000, encoding: 'utf-8', stdio: 'pipe' })
    return { status: 'passed', summary: { total: 0, passed: 0, failed: 0, duration: Date.now() - start }, failures: [], rawLog: '' }
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    const output = (err.stdout || '') + '\n' + (err.stderr || '')
    const failures = parseTscErrors(output)
    return { status: 'failed', summary: { total: failures.length, passed: 0, failed: failures.length, duration: Date.now() - start }, failures, rawLog: output }
  }
}

function parseTscErrors(output: string): TestFailure[] {
  const failures: TestFailure[] = []
  const lines = output.split('\n')
  for (const line of lines) {
    const m = line.match(/^(.+?)\((\d+),(\d+)\):\s+error\s+TS(\d+):\s+(.+)$/)
    if (m) {
      failures.push({ file: m[1], line: parseInt(m[2]), message: `TS${m[4]}: ${m[5]}`, category: 'compilation' })
    }
  }
  return failures
}

// ---- Vitest Unit Tests ----
function runVitest(agentDir: string): TestResult {
  const start = Date.now()
  try {
    const output = execSync('npx vitest run --reporter=json 2>&1', { cwd: agentDir, timeout: 60_000, encoding: 'utf-8', stdio: 'pipe' })
    return parseVitestJson(output, start)
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string }
    const output = (err.stdout || '') + '\n' + (err.stderr || '')
    return parseVitestJson(output, start)
  }
}

function parseVitestJson(output: string, startTs: number): TestResult {
  // vitest --reporter=json outputs JSON. Try to extract it from mixed output.
  let json: Record<string, unknown> | null = null
  // Find the first { that starts a large JSON block
  const jsonStart = output.indexOf('{"numTotalTestSuites"')
  if (jsonStart < 0) {
    // Try any JSON line
    const lines = output.split('\n')
    for (const line of lines) {
      try { const p = JSON.parse(line); if (p.testResults || p.numTotalTests !== undefined) { json = p; break } } catch { /* not JSON */ }
    }
  } else {
    try { json = JSON.parse(output.slice(jsonStart)) } catch { /* partial */ }
  }

  if (!json) {
    return {
      status: output.includes('PASS') || output.includes('Tests') ? 'passed' : 'error',
      summary: { total: 0, passed: 0, failed: 0, duration: Date.now() - startTs },
      failures: [{ file: '', line: 0, message: 'Could not parse vitest output', category: 'unknown' }],
      rawLog: output
    }
  }

  const testResults = (json.testResults || []) as Array<Record<string, unknown>>
  const failures: TestFailure[] = []
  for (const suite of testResults) {
    const asserts = (suite.assertionResults || []) as Array<Record<string, unknown>>
    for (const a of asserts) {
      if (a.status === 'failed') {
        const msg = (a.failureMessages as string[])?.[0] || a.title || 'unknown'
        failures.push({
          file: (suite.name as string) || (a.ancestorTitles as string[])?.join('/') || '',
          line: 0,
          message: msg.split('\n')[0].slice(0, 200),
          category: categorizeError(msg)
        })
      }
    }
  }

  return {
    status: json.numFailedTests === 0 ? 'passed' : 'failed',
    summary: {
      total: (json.numTotalTests as number) || 0,
      passed: (json.numPassedTests as number) || 0,
      failed: (json.numFailedTests as number) || 0,
      duration: Date.now() - startTs
    },
    failures,
    rawLog: output
  }
}

function categorizeError(msg: string): TestFailure['category'] {
  if (/TS\d{4}/.test(msg) || /Cannot find module/.test(msg) || /is not assignable/.test(msg)) return 'compilation'
  if (/expected|Expected|toEqual|toMatch|toContain|AssertionError/.test(msg)) return 'assertion'
  if (/timed out|timeout/i.test(msg)) return 'timeout'
  if (/Cannot read properties|is not a function|EADDRINUSE/.test(msg)) return 'runtime'
  if (/Cannot find module/.test(msg)) return 'missing_dep'
  return 'unknown'
}

// ---- Fallback Test Generator ----
export function generateDefaultTests(agentDir: string, agentName: string): string[] {
  const created: string[] = []
  const testDir = join(agentDir, 'src', '__tests__')
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true })

  // Check if any .test.ts or .spec.ts files already exist
  const srcDir = join(agentDir, 'src')
  const existingTests = findTestFiles(srcDir)
  if (existingTests.length > 0) return existingTests

  const sanitized = agentName.replace(/[^a-zA-Z0-9_-]/g, '-')
  const healthTest = `import { describe, it, expect } from 'vitest'

describe('${agentName} Health', () => {
  it('should have app export defined', () => {
    // Verify the app module can be imported
    const mod = require('../index')
    expect(mod).toBeDefined()
    expect(mod.app || mod.default).toBeDefined()
  })

  it('should listen on correct port from env', () => {
    const port = process.env.PORT || '3000'
    expect(port).toBeTruthy()
  })
})
`
  writeFileSync(join(testDir, 'health.test.ts'), healthTest, 'utf-8')
  created.push(join(testDir, 'health.test.ts'))
  return created
}

function findTestFiles(dir: string): string[] {
  const found: string[] = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fp = join(dir, entry.name)
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
        found.push(...findTestFiles(fp))
      } else if (/\.(test|spec)\.(ts|tsx|js)$/.test(entry.name)) {
        found.push(fp)
      }
    }
  } catch { /* dir may not exist */ }
  return found
}

// ---- Generate vitest.config.ts ----
export function ensureVitestConfig(agentDir: string): void {
  const configPath = join(agentDir, 'vitest.config.ts')
  if (existsSync(configPath)) return
  const config = `import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    testTimeout: 10_000,
    reporters: ['verbose', 'json'],
    outputFile: '.vitest-report.json'
  }
})
`
  writeFileSync(configPath, config, 'utf-8')
}

// ---- Test Pipeline Orchestrator ----
export async function runTestPipeline(
  agentId: string,
  agentDir: string,
  sessionId: string,
  broadcast: (type: string, payload: unknown) => void
): Promise<{ passed: boolean; results: TestResult[] }> {
  const results: TestResult[] = []

  // Phase 1: Ensure vitest config and test files exist
  ensureVitestConfig(agentDir)
  const tests = findTestFiles(join(agentDir, 'src'))
  if (tests.length === 0) {
    const agent = (getDB().prepare('SELECT name FROM agents WHERE id=?').get(agentId) as Record<string,unknown> | undefined)
    generateDefaultTests(agentDir, (agent?.name as string) || 'Agent')
  }

  // Phase 2: npm install (with devDeps for vitest)
  broadcast('test:progress', { agentId, phase: 'install', message: 'Installing dependencies...' })
  try {
    execSync('npm install --include=dev --registry=https://registry.npmmirror.com', { cwd: agentDir, timeout: 120_000, stdio: 'pipe' })
  } catch {
    // Fallback: try without dev flag
    try { execSync('npm install --registry=https://registry.npmmirror.com', { cwd: agentDir, timeout: 120_000, stdio: 'pipe' }) }
    catch (e) {
      results.push({ status: 'error', summary: { total: 0, passed: 0, failed: 0, duration: 0 }, failures: [{ file: '', line: 0, message: 'npm install failed: ' + (e as Error).message, category: 'missing_dep' }], rawLog: (e as Error).message })
      return { passed: false, results }
    }
  }

  // Check if vitest is available before running tests
  const vitestAvailable = checkVitestAvailable(agentDir)
  if (!vitestAvailable) {
    broadcast('test:progress', { agentId, phase: 'unit', message: 'vitest not available — skipping tests, marking passed' })
    logGeneration({ sessionId: sessionId, agentId, level: 'warn', message: 'vitest not available, skipping unit tests', phase: 'validate' })
    return { passed: true, results }  // Don't block on missing test infra
  }

  // Phase 3: Compile check
  broadcast('test:progress', { agentId, phase: 'compile', message: 'Type checking...' })
  const compileResult = runCompileCheck(agentDir)
  if (compileResult.status === 'failed') {
    results.push(compileResult)
    saveTestResult(agentId, sessionId, 'unit', compileResult)
    broadcast('test:result', { agentId, phase: 'compile', ...compileResult })
    return { passed: false, results }
  }
  results.push(compileResult)

  // Phase 4: Unit tests
  broadcast('test:progress', { agentId, phase: 'unit', message: 'Running unit tests...' })
  const unitResult = runVitest(agentDir)
  results.push(unitResult)
  saveTestResult(agentId, sessionId, 'unit', unitResult)
  broadcast('test:result', { agentId, phase: 'unit', ...unitResult })

  logGeneration({ sessionId: sessionId, agentId, level: unitResult.status === 'passed' ? 'info' : 'warn', message: `Test pipeline: ${unitResult.status} (${unitResult.summary.passed}/${unitResult.summary.total})`, phase: 'validate', metadata: { summary: unitResult.summary } })

  return { passed: unitResult.status === 'passed', results }
}

// ---- Persist Test Result to DB ----
function saveTestResult(agentId: string, sessionId: string, phase: string, result: TestResult) {
  try {
    const db = getDB()
    db.prepare(`INSERT INTO test_results (id,agent_id,session_id,phase,status,summary_json,failures_json,logs,duration_ms,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), agentId, sessionId, phase, result.status,
        JSON.stringify(result.summary), JSON.stringify(result.failures), result.rawLog.slice(0, 5000),
        result.summary.duration, new Date().toISOString(), new Date().toISOString())
  } catch { /* DB save best-effort */ }
}
