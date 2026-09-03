// ============================================================
// Error Analyzer — categorizes test failures and selects fix strategies
// ============================================================
import { readFileSync } from 'fs'
import { join } from 'path'
import type { TestFailure } from './test-runner'

// ---- Types ----
export type ErrorCategory =
  | 'compilation' | 'assertion' | 'timeout' | 'runtime'
  | 'missing_dep' | 'missing_file' | 'api_contract' | 'unknown'

export type FixStrategy =
  | 'edit_file' | 'create_file' | 'add_dependency' | 'modify_test'
  | 'install_deps' | 'escalate'

export interface AnalyzedFailure {
  original: TestFailure
  category: ErrorCategory
  fixStrategy: FixStrategy
  context: string
}

// ---- Pattern Matchers ----
const COMPILATION = [/TS\d{4}/, /Cannot find module/, /Type .* is not assignable/, /Property .* does not exist/, /is declared but/, /Argument of type/]
const ASSERTION = [/expected.*to.*be/i, /Expected.*Received/, /toEqual|toMatchObject|toContain/, /AssertionError/]
const TIMEOUT = [/timed out after/i, /aborted because/i, /Test timeout/i, /exceeded timeout/i]
const RUNTIME = [/Cannot read properties of/, /is not a function/, /Cannot set properties of/, /ERR_UNHANDLED_REJECTION/, /listen EADDRINUSE/]
const MISSING_DEP = [/Cannot find module '(?!\.\/|\.\.\/)/, /ERR_MODULE_NOT_FOUND/]
const API_CONTRACT = [/Expected.*200.*but got|Expected.*success.*but got|invalid.*response/i]

// ---- Core Analyzer ----
export function analyzeFailure(f: TestFailure, agentDir: string): AnalyzedFailure {
  const category = classifyError(f.message)
  const strategy = chooseStrategy(category)
  const context = gatherContext(f, agentDir, category)
  return { original: f, category, fixStrategy: strategy, context }
}

function classifyError(message: string): ErrorCategory {
  if (MISSING_DEP.some(r => r.test(message))) return 'missing_dep'
  if (COMPILATION.some(r => r.test(message))) return 'compilation'
  if (ASSERTION.some(r => r.test(message))) return 'assertion'
  if (TIMEOUT.some(r => r.test(message))) return 'timeout'
  if (RUNTIME.some(r => r.test(message))) return 'runtime'
  if (API_CONTRACT.some(r => r.test(message))) return 'api_contract'
  if (/ENOENT|no such file/i.test(message)) return 'missing_file'
  return 'unknown'
}

function chooseStrategy(category: ErrorCategory): FixStrategy {
  switch (category) {
    case 'compilation': return 'edit_file'
    case 'assertion': return 'modify_test'
    case 'timeout': return 'edit_file'
    case 'runtime': return 'edit_file'
    case 'missing_dep': return 'add_dependency'
    case 'missing_file': return 'create_file'
    case 'api_contract': return 'edit_file'
    default: return 'escalate'
  }
}

function gatherContext(f: TestFailure, agentDir: string, category: ErrorCategory): string {
  if (!f.file) return f.message
  try {
    const fullPath = join(agentDir, f.file)
    const content = readFileSync(fullPath, 'utf-8')
    const lines = content.split('\n')
    // Show ~5 lines around the failing line
    const start = Math.max(0, f.line - 3)
    const end = Math.min(lines.length, f.line + 2)
    return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n')
  } catch {
    return f.message
  }
}

// ---- Batch analysis ----
export function analyzeAll(failures: TestFailure[], agentDir: string): AnalyzedFailure[] {
  return failures.map(f => analyzeFailure(f, agentDir))
}

// ---- Group by strategy ----
export function groupByStrategy(failures: AnalyzedFailure[]): Map<FixStrategy, AnalyzedFailure[]> {
  const groups = new Map<FixStrategy, AnalyzedFailure[]>()
  for (const f of failures) {
    const list = groups.get(f.fixStrategy) || []
    list.push(f)
    groups.set(f.fixStrategy, list)
  }
  return groups
}
