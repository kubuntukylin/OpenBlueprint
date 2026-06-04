// ============================================================
// Claude Code Generator Worker — single call, Claude decides what files to create
// ============================================================
import { spawn } from 'child_process'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'fs'
import { isValidCode } from './validate'

function out(obj: Record<string, unknown>) { process.stdout.write(JSON.stringify(obj) + '\n') }

async function main() {
  const specFile = process.argv[2]
  if (!specFile) { out({ type: 'error', message: 'No spec file' }); process.exit(1) }

  let cfg: Record<string, unknown>
  try { cfg = JSON.parse(readFileSync(specFile, 'utf-8')) } catch (e) {
    out({ type: 'error', message: 'Bad spec: ' + (e as Error).message }); process.exit(1)
  }

  const agentName = cfg.agentName as string
  const specJson = cfg.specJson as string || '{}'
  const outputDir = cfg.outputDir as string || 'output'
  let spec: Record<string, unknown> = {}
  try { spec = JSON.parse(specJson) } catch { /* ok */ }

  const constraints = cfg.constraints as Record<string, unknown> | undefined
  const extraPkgs = (constraints?.extraDependencies as string[]) || []

  // Expanded package list — allows both backend and frontend tech
  const baseBackend = ['express', 'cors', 'axios', 'dotenv', 'uuid', 'express-validator', 'tsx', 'typescript', '@types/express', '@types/node']
  const baseFrontend = ['react', 'react-dom', '@types/react', '@types/react-dom', 'vue', 'vite', '@vitejs/plugin-react', 'ejs', 'pug', 'express-handlebars', 'tailwindcss', 'postcss', 'autoprefixer']
  const allowedPkgs = [...new Set([...baseBackend, ...baseFrontend, ...extraPkgs])]

  const agentDir = join(outputDir, agentName.replace(/[^a-zA-Z0-9一-鿿_-]/g, '-'))
  if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true })

  out({ type: 'progress', phase: 'init', message: `Claude Code: ${agentName}`, timestamp: Date.now() })
  out({ type: 'terminal', text: `\n\x1b[36m▶ Claude Code: ${agentName}\x1b[0m  \x1b[90mOutput: ${agentDir}\x1b[0m\n\n`, stream: 'stdout', timestamp: Date.now() })

  const resp = ((spec.responsibilities as string[]) || []).map((r: string) => `- ${r}`).join('\n') || spec.description || ''
  const technologies = ((spec.technologies as string[]) || []).join(', ') || 'express, typescript'
  const ins = ((spec as Record<string,unknown>).inputs as Array<Record<string,unknown>> || []).map(i => `- ${i.name} (${i.type}) from ${i.source || 'external'}`).join('\n')
  const outs = ((spec as Record<string,unknown>).outputs as Array<Record<string,unknown>> || []).map(o => `- ${o.name} (${o.type}) to ${o.destination || 'output'}`).join('\n')

  // Dependency agent context
  const projectAgents = (cfg.projectAgents as Record<string,unknown>[]) || []
  let depCtx = ''
  if (projectAgents.length > 0) {
    depCtx = '\n## OTHER AGENTS IN THIS PROJECT\n'
    for (const pa of projectAgents) {
      const paName = pa.name as string; const paDesc = pa.description as string; const paEnv = pa.envVar as string
      const paOutputs = (pa.outputs as Array<Record<string,unknown>>) || []
      depCtx += `\n### ${paName} (env: ${paEnv})\n${paDesc || ''}\n`
      if (paOutputs.length > 0) depCtx += `  Exposes: ${paOutputs.map(o => `${o.name}(${o.type})→${o.destination}`).join(', ')}\n`
    }
  }

  // ---- Build the prompt: Claude decides everything ----
  const isWebFrontend = /react|vue|angular|html|css|frontend|web\s*page|website|browser|dashboard|网页|前端|网站|页面|界面|图形化|浏览器|可视化/i.test(technologies + ' ' + (spec.description || '') + ' ' + resp)
  const isFullstack = isWebFrontend && /express|api|backend|server|rest/i.test(technologies + ' ' + (spec.description || ''))

  let taskPrompt = ''
  if (isWebFrontend) {
    taskPrompt = `This is a WEB FRONTEND or FULLSTACK application that users access through a browser.
It needs a web UI — HTML pages, CSS styles, JavaScript/TypeScript components.
If it needs a backend API, include a small Express server to serve static files and proxy API calls.
Users should be able to open a browser and USE the application visually.`
  } else {
    taskPrompt = `This is a backend API microservice (Express + TypeScript).
It exposes REST API endpoints and communicates with other agents via HTTP.
It does NOT need HTML or browser-facing UI — it returns JSON.`
  }

  const prompt = `You are generating the complete source code for a microservice agent in OpenBlueprint.

## AGENT DEFINITION
Name: ${agentName}
Description: ${spec.description || 'No description'}
Technologies: ${technologies}
Responsibilities:
${resp || 'Implement core logic'}

Inputs:
${ins || 'None'}

Outputs:
${outs || 'None'}
${depCtx}

## TASK
${taskPrompt}

## HOW TO WORK
You have Write tool access. Create ALL files directly in the current directory (${agentDir}).
- Use Write to create each file with complete, runnable code
- Create subdirectories as needed (public/, src/, etc.)
- After creating files, use Bash to run: npm install && npx tsc --noEmit
- Fix any compilation errors by editing the files

You MUST create AT LEAST:
- An entry point (index.ts) — the main server or app entry
- Type definitions (types.ts or similar)
- Business logic / components
- Configuration (config.ts)

If web frontend, also include:
- HTML page(s) — public/index.html or similar
- CSS styles — public/style.css or similar
- Client-side JS/TS — public/app.ts or src/*.tsx if using React
- Express server to serve static files and proxy API calls if needed

## RULES
- ALLOWED packages: ${allowedPkgs.join(', ')}
- Do NOT import packages outside this list
- Every service MUST have GET /health returning { success: true, service: '${agentName}' }
- API response format: { success: boolean, data?: any, error?: string }
- Use TypeScript throughout. No plain JavaScript.
- Listen on process.env.PORT || 3000 (or 8080 for web frontends)
- Use axios to call other agents by their env var URLs
- Output COMPLETE, runnable code — no placeholders, no "// TODO"
- Write each file, then npm install && npx tsc --noEmit to verify`

  // Spawn claude.exe directly
  const isWin = process.platform === 'win32'
  const claudeExe = isWin
    ? join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    : 'claude'

  // Remove old generated files before starting (keep node_modules for speed)
  if (existsSync(agentDir)) {
    for (const f of readdirSync(agentDir)) {
      if (f === 'node_modules') continue
      try { rmSync(join(agentDir, f), { recursive: true, force: true }) } catch { /* locked */ }
    }
  }

  out({ type: 'progress', phase: 'generating', message: 'Claude Code generating files...', timestamp: Date.now() })
  out({ type: 'terminal', text: '  Generating...\n', stream: 'stdout', timestamp: Date.now() })

  // Spawn Claude Code WITHOUT --print — let it use Write tool to create files directly
  const child = spawn(claudeExe, [
    '-p', prompt,
    '--output-format', 'text',
    '--permission-mode', 'bypassPermissions',
    '--allowedTools', 'Write,Edit,Read,Bash,Glob,Grep',
    '--no-session-persistence',
  ], { cwd: agentDir, stdio: ['ignore', 'pipe', 'pipe'] })

  child.stdout.on('data', (d: Buffer) => {
    out({ type: 'terminal', text: d.toString(), stream: 'stdout', timestamp: Date.now() })
  })
  child.stderr.on('data', (d: Buffer) => {
    out({ type: 'terminal', text: d.toString(), stream: 'stderr', timestamp: Date.now() })
  })

  let spawnFailed = false
  child.on('error', (err) => {
    spawnFailed = true
    out({ type: 'terminal', text: `\x1b[31mFailed to start Claude Code: ${err.message}\x1b[0m\n`, stream: 'stderr', timestamp: Date.now() })
  })

  const exitCode: number | null = await new Promise(resolve => child.on('close', resolve))

  if (spawnFailed || exitCode === null || exitCode !== 0) {
    // Claude Code didn't run — scan existing files as fallback
    const codeText = exitCode === null ? 'killed' : String(exitCode)
    out({ type: 'terminal', text: `  \x1b[33mClaude Code exited: ${codeText}, scanning existing files...\x1b[0m\n`, stream: 'stdout', timestamp: Date.now() })
  }

  // Scan agentDir for all generated files (Claude Code wrote them via Write tool)
  const allFiles: string[] = []
  const scanDir = (dir: string, prefix: string) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      if (entry.isDirectory()) { scanDir(join(dir, entry.name), prefix + entry.name + '/') }
      else {
        const rel = prefix + entry.name
        const fp = join(agentDir, rel)
        try {
          const content = readFileSync(fp, 'utf-8')
          if (rel.endsWith('.ts') || rel.endsWith('.tsx')) {
            const v = isValidCode(content)
            if (!v.valid) {
              out({ type: 'terminal', text: `  \x1b[31m✗ ${rel}:\x1b[0m ${v.reason}\n`, stream: 'stderr', timestamp: Date.now() })
              continue
            }
          }
          allFiles.push(rel)
          out({ type: 'file:generated', path: fp, size: content.length, timestamp: Date.now() })
          out({ type: 'terminal', text: `  \x1b[32m✓\x1b[0m ${rel} (${content.length} chars)\n`, stream: 'stdout', timestamp: Date.now() })
        } catch { /* skip unreadable */ }
      }
    }
  }
  scanDir(agentDir, '')

  // Auto-detect imports and build package.json
  const NODE_BUILTINS = new Set(['fs','path','http','https','url','crypto','stream','events','buffer','util','os','child_process'])
  const baseDeps: Record<string, string> = { express: '^4.21.0', typescript: '^5.7.0', '@types/express': '^5.0.0', '@types/node': '^22.0.0', tsx: '^4.19.0', dotenv: '^16.4.0', axios: '^1.7.0', cors: '^2.8.5', uuid: '^10.0.0', 'express-validator': '^7.0.0' }
  for (const pkg of extraPkgs) { if (!baseDeps[pkg]) baseDeps[pkg] = '*' }

  for (const fn of allFiles) {
    if (!fn.endsWith('.ts') && !fn.endsWith('.tsx')) continue
    try {
      const content = readFileSync(join(agentDir, fn), 'utf-8')
      const imports = content.matchAll(/(?:import\s+.*?\s+from\s+['"]|require\(['"])([^./][^'"]*)/g)
      for (const m of imports) {
        const pkg = m[1].split('/')[0]
        const scoped = m[1].startsWith('@') ? m[1].split('/').slice(0,2).join('/') : pkg
        if (!NODE_BUILTINS.has(pkg) && !NODE_BUILTINS.has(scoped) && !baseDeps[scoped]) {
          baseDeps[scoped] = '*'
          out({ type: 'terminal', text: `  \x1b[33m→ auto-added dep:\x1b[0m ${scoped}\n`, stream: 'stdout', timestamp: Date.now() })
        }
      }
    } catch { /* ok */ }
  }

  // Generate package.json
  const sanitizedName = agentName.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
  // Detect scripts based on generated files
  const hasReact = allFiles.some(f => f.endsWith('.tsx'))
  const startCmd = hasReact ? 'npx vite --host 0.0.0.0' : 'npx tsx index.ts'
  const pkgJson = JSON.stringify({
    name: sanitizedName, version: '1.0.0', private: true,
    scripts: { start: startCmd, build: 'npx tsc --noEmit' },
    dependencies: baseDeps
  }, null, 2)
  writeFileSync(join(agentDir, 'package.json'), pkgJson, 'utf-8')
  allFiles.push('package.json')
  out({ type: 'file:generated', path: join(agentDir, 'package.json'), size: pkgJson.length, timestamp: Date.now() })
  out({ type: 'terminal', text: `  \x1b[32m✓\x1b[0m package.json\n`, stream: 'stdout', timestamp: Date.now() })

  // Generate Dockerfile
  const defaultPort = isWebFrontend ? '8080' : '3000'
  const dockerfile = `FROM node-local\nWORKDIR /app\nCOPY package.json .\nRUN npm install --registry=https://registry.npmmirror.com\nCOPY . .\nEXPOSE ${defaultPort}\nCMD ["npx", "tsx", "index.ts"]`
  writeFileSync(join(agentDir, 'Dockerfile'), dockerfile, 'utf-8')
  allFiles.push('Dockerfile')
  out({ type: 'file:generated', path: join(agentDir, 'Dockerfile'), size: dockerfile.length, timestamp: Date.now() })
  out({ type: 'terminal', text: `  \x1b[32m✓\x1b[0m Dockerfile\n`, stream: 'stdout', timestamp: Date.now() })

  const success = allFiles.length > 0
  const codeFiles = allFiles.filter(f => f !== 'package.json' && f !== 'Dockerfile')
  out({ type: 'terminal', text: `\n  ${success ? '\x1b[32m✓ COMPLETE\x1b[0m' : '\x1b[31m✗ FAILED\x1b[0m'} ${codeFiles.length} source files in ${agentDir}\n\n`, stream: 'stdout', timestamp: Date.now() })
  out({ type: 'result', success, agentName, outputDir: agentDir, files: allFiles, timestamp: Date.now() })
  process.exit(success ? 0 : 1)
}

main().catch((e) => { out({ type: 'error', message: 'Worker crashed: ' + (e instanceof Error ? e.message : String(e)) }); process.exit(1) })
