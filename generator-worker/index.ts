// ============================================================
// LLM API Generator Worker — lets LLM decide what files to create
// ============================================================
import OpenAI from 'openai'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { isValidCode } from './validate'

function out(obj: Record<string, unknown>) { process.stdout.write(JSON.stringify(obj) + '\n') }

async function main() {
  const specFile = process.argv[2]
  if (!specFile) { out({ type: 'error', message: 'No spec file' }); process.exit(1) }

  let cfg: Record<string, unknown> = {}
  try { cfg = JSON.parse(readFileSync(specFile, 'utf-8')) } catch (e) {
    out({ type: 'error', message: 'Bad spec: ' + (e as Error).message }); process.exit(1)
  }

  const agentName = cfg.agentName as string
  const specJson = cfg.specJson as string || '{}'
  const outputDir = cfg.outputDir as string || 'output'
  const llmConfig = cfg.llmConfig as Record<string, unknown>
  let spec: Record<string, unknown> = {}
  try { spec = JSON.parse(specJson) } catch { /* ok */ }

  const agentDir = join(outputDir, agentName.replace(/[^a-zA-Z0-9一-鿿_-]/g, '-'))
  if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true })

  out({ type: 'progress', phase: 'init', message: `Generating: ${agentName} (LLM API)`, timestamp: Date.now() })
  out({ type: 'terminal', text: `\n\x1b[36m▶ LLM API: ${agentName}\x1b[0m  \x1b[90mModel: ${llmConfig.modelName || ''}  Output: ${agentDir}\x1b[0m\n\n`, stream: 'stdout', timestamp: Date.now() })

  const constraints = cfg.constraints as Record<string, unknown> | undefined
  const extraDeps = (constraints?.extraDependencies as string[]) || []
  const baseBackend = ['express', 'cors', 'axios', 'dotenv', 'uuid', 'express-validator', 'tsx', 'typescript', '@types/express', '@types/node']
  const baseFrontend = ['react', 'react-dom', '@types/react', '@types/react-dom', 'vue', 'vite', '@vitejs/plugin-react', 'ejs', 'pug', 'express-handlebars', 'tailwindcss', 'postcss', 'autoprefixer']
  const allowedPkgs = [...new Set([...baseBackend, ...baseFrontend, ...extraDeps])]

  const resp = (spec.responsibilities as string[])?.join(', ') || ''
  const technologies = ((spec.technologies as string[]) || []).join(', ') || 'express, typescript'
  const ins = JSON.stringify((spec as Record<string,unknown>).inputs || [])
  const outs = JSON.stringify((spec as Record<string,unknown>).outputs || [])

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

  const isWebFrontend = /react|vue|angular|html|css|frontend|web\s*page|website|browser|dashboard|网页|前端|网站|页面|界面|图形化|浏览器|可视化/i.test(technologies + ' ' + (spec.description || '') + ' ' + resp)

  let taskPrompt = ''
  if (isWebFrontend) {
    taskPrompt = `This is a WEB FRONTEND or FULLSTACK application. Create a complete browser-based application with HTML/CSS/JS (or a React/Vue SPA). Include an Express server to serve static files and proxy API calls. Users open a browser to use it.`
  } else {
    taskPrompt = `This is a backend API microservice. Create an Express + TypeScript REST API server. It does NOT need HTML/browser UI.`
  }

  const prompt = `You are generating the complete source code for a microservice agent.

## AGENT DEFINITION
Name: ${agentName}
Description: ${spec.description || ''}
Technologies: ${technologies}
Responsibilities: ${resp}
Inputs: ${ins}
Outputs: ${outs}
${depCtx}

## TASK
${taskPrompt}

## OUTPUT FORMAT
Create ALL necessary files. Output each file using this EXACT format:

FILE: path/to/filename.ts
\`\`\`typescript
// complete source code here
\`\`\`

You MUST include AT LEAST:
- An entry point (index.ts) with GET /health route returning { success: true, service: '${agentName}' }
- Type definitions (types.ts)
- Business logic / components
- Configuration (config.ts)

If web frontend, also create:
- HTML page(s), CSS styles, client-side JS
- Express server (index.ts) that serves static files + /health endpoint

## RULES
- ALLOWED packages: ${allowedPkgs.join(', ')}
- DO NOT import any package outside this list
- API response format: { success: boolean, data?: any, error?: string }
- Use TypeScript. No plain JavaScript.
- Listen on process.env.PORT || 3000 (or 8080 for frontends)
- Output COMPLETE, runnable code — no placeholders, no "// TODO"
- NO explanatory text between files — only the FILE: blocks

## TESTING REQUIREMENTS
After all source files, you MUST also create test files:
1. Create a FILE: src/__tests__/health.test.ts that tests the /health endpoint
2. Use vitest: import { describe, it, expect } from 'vitest'
3. For Express agents, test that routes return correct status codes
4. Export the app (without listening) from index.ts for testability`

  const client = new OpenAI({
    apiKey: llmConfig.apiKey as string,
    baseURL: (llmConfig.baseUrl as string) || undefined
  })

  out({ type: 'progress', phase: 'generating', message: 'Calling LLM API...', timestamp: Date.now() })

  try {
    const params: Record<string, unknown> = {
      model: llmConfig.modelName as string,
      messages: [
        { role: 'system', content: 'You are a code generator. Output files in FILE: format. Follow all rules exactly.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: (llmConfig.maxTokens as number) || 16384,
      stream: true
    }
    if (llmConfig.enableThinking) {
      params.thinking = { type: 'enabled' }
    } else {
      params.temperature = (llmConfig.temperature as number) || 0.7
    }

    const stream = await client.chat.completions.create(params as never)
    let rawOutput = ''

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content || ''
      if (token) rawOutput += token
    }

    // Parse FILE: sections
    const allFiles: string[] = []
    const sections = rawOutput.split(/(?:^|\n)FILE:\s*/i)
    for (let i = 1; i < sections.length; i++) {
      const section = sections[i]
      const nl = section.indexOf('\n')
      if (nl === -1) continue
      const filename = section.slice(0, nl).trim()
      let content = section.slice(nl + 1).trim()
      content = content.replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim()
      if (filename && content.length > 20) {
        if (filename.endsWith('.ts') || filename.endsWith('.tsx')) {
          const validation = isValidCode(content)
          if (!validation.valid) {
            out({ type: 'terminal', text: `\n  \x1b[31m✗ ${filename}:\x1b[0m ${validation.reason}\n`, stream: 'stderr', timestamp: Date.now() })
            continue
          }
        }
        const filePath = join(agentDir, filename)
        const dir = filePath.substring(0, filePath.lastIndexOf('\\'))
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(filePath, content, 'utf-8')
        allFiles.push(filename)
        out({ type: 'file:generated', path: filePath, size: content.length, timestamp: Date.now() })
        out({ type: 'terminal', text: `\n  \x1b[32m✓\x1b[0m ${filename} (${content.length} chars)\n`, stream: 'stdout', timestamp: Date.now() })
      }
    }

    // Fallback: extract code blocks
    if (allFiles.length === 0) {
      const pattern = /(\w+\.ts)\s*\n```[\w]*\n([\s\S]*?)```/g
      let m
      while ((m = pattern.exec(rawOutput)) !== null) {
        const code = m[2].trim()
        if (isValidCode(code).valid) {
          writeFileSync(join(agentDir, m[1]), code, 'utf-8')
          allFiles.push(m[1])
          out({ type: 'terminal', text: `\n  \x1b[33m→ extracted ${m[1]}\x1b[0m\n`, stream: 'stdout', timestamp: Date.now() })
        }
      }
      if (allFiles.length === 0) {
        const blocks = rawOutput.match(/```[\w]*\n([\s\S]*?)```/g)
        if (blocks) {
          for (let j = 0; j < blocks.length && j < 6; j++) {
            const code = blocks[j].replace(/```[\w]*\n?/, '').replace(/```$/, '').trim()
            if (isValidCode(code).valid && code.length > 50) {
              const name = `generated-${j + 1}.ts`
              writeFileSync(join(agentDir, name), code, 'utf-8')
              allFiles.push(name)
              out({ type: 'terminal', text: `\n  \x1b[33m→ extracted ${name}\x1b[0m\n`, stream: 'stdout', timestamp: Date.now() })
            }
          }
        }
      }
    }

    // Auto-detect imports and build package.json
    const NODE_BUILTINS = new Set(['fs','path','http','https','url','crypto','stream','events','buffer','util','os','child_process'])
    const baseDeps: Record<string, string> = { express: '^4.21.0', typescript: '^5.7.0', '@types/express': '^5.0.0', '@types/node': '^22.0.0', tsx: '^4.19.0', dotenv: '^16.4.0', axios: '^1.7.0', cors: '^2.8.5', uuid: '^10.0.0', 'express-validator': '^7.0.0' }
    for (const pkg of extraDeps) { if (!baseDeps[pkg]) baseDeps[pkg] = '*' }

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

    const sanitizedName = agentName.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
    const hasReact = allFiles.some(f => f.endsWith('.tsx'))
    const startCmd = hasReact ? 'npx vite --host 0.0.0.0' : 'npx tsx index.ts'
    const pkgJson = JSON.stringify({
      name: sanitizedName, version: '1.0.0', private: true,
      scripts: { start: startCmd, build: 'npx tsc --noEmit', test: 'npx vitest run', 'test:watch': 'npx vitest' },
      dependencies: baseDeps,
      devDependencies: { vitest: '^4.0.0' }
    }, null, 2)
    const dockerfile = `FROM node-local\nWORKDIR /app\nCOPY package.json .\nRUN npm install --registry=https://registry.npmmirror.com\nCOPY . .\nEXPOSE ${isWebFrontend ? '8080' : '3000'}\nCMD ["npx", "tsx", "index.ts"]`
    const vitestConfig = `import { defineConfig } from 'vitest/config'
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

    for (const [name, content] of [['package.json', pkgJson], ['vitest.config.ts', vitestConfig], ['Dockerfile', dockerfile]] as [string, string][]) {
      const fp = join(agentDir, name)
      writeFileSync(fp, content, 'utf-8')
      allFiles.push(name)
      out({ type: 'file:generated', path: fp, size: content.length, timestamp: Date.now() })
      out({ type: 'terminal', text: `  \x1b[32m✓\x1b[0m ${name} (template)\n`, stream: 'stdout', timestamp: Date.now() })
    }

    const success = allFiles.length > 0
    const codeFiles = allFiles.filter(f => f !== 'package.json' && f !== 'Dockerfile')
    out({ type: 'terminal', text: `\n  ${success ? '\x1b[32m✓ COMPLETE\x1b[0m' : '\x1b[31m✗ FAILED\x1b[0m'} ${codeFiles.length} source files in ${agentDir}\n\n`, stream: 'stdout', timestamp: Date.now() })
    out({ type: 'result', success, agentName, outputDir: agentDir, files: allFiles, timestamp: Date.now() })
    process.exit(success ? 0 : 1)

  } catch (e) {
    out({ type: 'terminal', text: `\n  \x1b[31m✗ API Error: ${(e as Error).message}\x1b[0m\n\n`, stream: 'stderr', timestamp: Date.now() })
    out({ type: 'result', success: false, agentName, outputDir: agentDir, files: [], error: (e as Error).message, timestamp: Date.now() })
    process.exit(1)
  }
}

main()
