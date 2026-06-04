import { useState, useMemo } from 'react'
import type { HelpDoc } from '../shared/types'
import { HELP_CATEGORIES } from '../shared/types'

const SEED_DOCS: HelpDoc[] = [
  {
    id: 'docker-network-wsl2',
    category: 'docker',
    title: 'WSL2 网络大文件传输卡死',
    content: `## 问题
在 WSL2 后端模式下，Docker 拉取大于 5MB 的镜像时，TCP 连接永远卡在 "Pulling fs layer"，不传输任何数据。小镜像（如 alpine 3MB）可以正常拉取。

## 根因
WSL2 NAT 模式下，TCP 大包传输不稳定。Docker registry 协议（HTTPS）的 chunked transfer 在 WSL2 虚拟网卡上有 MTU/分片问题。

## 解决方案
**切换到 Hyper-V 后端**：
1. Docker Desktop → Settings → General
2. 取消勾选 "Use WSL 2 based engine"
3. Apply & Restart

Hyper-V 后端使用独立网络栈，虽然下载速度较慢但稳定可靠。

## 验证方法
\`\`\`bash
docker pull alpine:latest  # 应该秒下
docker pull node:22-alpine  # 应该持续下载（约 5-15 分钟）
\`\`\``,
    tags: ['WSL2', '网络', '镜像拉取', 'Docker Desktop'],
    severity: 'critical',
    author: 'system',
    createdAt: '2026-05-27T14:30:00Z',
    updatedAt: '2026-05-27T14:30:00Z'
  },
  {
    id: 'docker-hyperv-images-lost',
    category: 'docker',
    title: 'Hyper-V 后端重启后镜像丢失',
    content: `## 问题
切换 Docker Desktop 后端（WSL2 ↔ Hyper-V）或重启 Docker Desktop 后，之前构建的 Docker 镜像全部消失。

## 根因
WSL2 和 Hyper-V 后端有完全独立的镜像存储，不共享数据。Hyper-V VM 的磁盘在某些情况下也会被回收。

## 解决方案

### 方案 A：导出/导入镜像（推荐）
构建完基础镜像后立即导出：
\`\`\`bash
# 导出
docker save node-local alpine -o output/.docker-cache/dd-base-images.tar

# 导入（系统启动时）
docker load -i output/.docker-cache/dd-base-images.tar
\`\`\`

### 方案 B：Dockerfile 用 build cache
Docker 的构建缓存（BuildKit cache）不受后端切换影响。Dockerfile 保持 \`FROM alpine\` + \`RUN apk add nodejs npm\`，第二次构建时所有层都是 CACHED。

## 验证方法
\`\`\`bash
docker images node-local  # 检查镜像是否存在
docker build -t node-local .  # 如果 CACHED 则无需重新下载
\`\`\``,
    tags: ['Hyper-V', '镜像', '持久化', 'Docker Desktop'],
    severity: 'warning',
    author: 'system',
    createdAt: '2026-05-27T15:00:00Z',
    updatedAt: '2026-05-27T15:00:00Z'
  },
  {
    id: 'port-conflict-3001',
    category: 'deployment',
    title: '容器端口与 OpenBlueprint 后端冲突',
    content: `## 问题
docker-compose up 时报错：
\`\`\`
Error: exposing port TCP 0.0.0.0:3001: bind: Only one usage of each socket address is normally permitted.
\`\`\`

## 根因
OpenBlueprint 后端运行在 3001 端口。docker-compose.yml 的端口映射从 3000 起顺序分配（3000, 3001, 3002...），第二个 agent 就会占用 3001，与后端冲突。

## 解决方案
**容器端口从 4000 起分配**（已在代码中修复）。

端口规划：
- 3000-3999：保留给开发工具（OpenBlueprint 后端 3001，前端 5173）
- 4000-4999：Agent 容器（支持 1000 个 agent）
- 5000+：其他服务

## 验证方法
\`\`\`bash
docker ps --format "{{.Names}}\t{{.Ports}}"  # 检查端口分配
curl http://localhost:4000/health  # 测试第一个 agent
\`\`\``,
    tags: ['端口', 'docker-compose', '冲突'],
    severity: 'critical',
    author: 'system',
    createdAt: '2026-05-27T16:45:00Z',
    updatedAt: '2026-05-27T16:45:00Z'
  },
  {
    id: 'cross-platform-node-modules',
    category: 'docker',
    title: 'Windows node_modules 在 Linux 容器中不兼容',
    content: `## 问题
在 Windows 上 \`npm install\` 后 COPY node_modules 到 Linux 容器，esbuild/tsx 等原生模块报错：
\`\`\`
Error: Transform failed with 1 error: Expected ";" but found "to"
\`\`\`

## 根因
esbuild 包含平台特定的原生二进制文件。Windows 版本的 .exe/.dll 无法在 Linux (Alpine/musl) 上运行。

## 解决方案
**Dockerfile 使用容器内 npm install**：
\`\`\`dockerfile
FROM node-local
WORKDIR /app
COPY package.json .
RUN npm install --registry=https://registry.npmmirror.com
COPY . .
EXPOSE 3000
CMD ["npx", "tsx", "index.ts"]
\`\`\`
容器内安装的 npm 包包含正确的 Linux 原生模块。

## 验证方法
\`\`\`bash
docker build -t test .
docker run --rm test npx tsx --version  # 如果 tsx 正常输出版本号则成功
\`\`\``,
    tags: ['node_modules', '跨平台', 'esbuild', 'Dockerfile'],
    severity: 'critical',
    author: 'system',
    createdAt: '2026-05-27T17:30:00Z',
    updatedAt: '2026-05-27T17:30:00Z'
  },
  {
    id: 'claude-code-garbage-output',
    category: 'code-gen',
    title: 'Claude Code worker 生成对话文本而非代码',
    content: `## 问题
使用 "Claude Code Generate" 生成的 agent 代码是 Claude 的对话文本（如 "Ready to write. The file will set up:..."），不是真正的 TypeScript 代码。14 个 agent 中 13 个的代码无效。

## 根因
1. Claude Code CLI 的 \`--print\` 模式下，\`--allowedTools Write\` 无法正常工作
2. Claude 输出 "Ready to write" 等描述性文本，不实际执行文件写入
3. Worker 的 fallback 逻辑不校验内容质量，直接写入对话文本

## 解决方案（已修复）
1. 代码质量校验（validate.ts）：检测聊天模式 vs 代码模式，拒绝非代码内容
2. 使用 "Regenerate (API)" 代替 "Claude Code Generate"（API worker 走 FILE: 格式，稳定可靠）
3. Claude Code worker prompt 优化为 "Output ONLY raw source code. No markdown, no explanations."

## 验证方法
\`\`\`bash
head -1 output/<agent-name>/index.ts
# 应该是 import/const/export 等代码，不是 "Ready"/"The file" 等英文
\`\`\``,
    tags: ['Claude Code', '代码生成', '质量', 'LLM'],
    severity: 'critical',
    author: 'system',
    createdAt: '2026-05-28T01:00:00Z',
    updatedAt: '2026-05-28T01:00:00Z'
  },
  {
    id: 'docker-registry-mirrors',
    category: 'docker',
    title: '国内 Docker 镜像源选择',
    content: `## 问题
Docker Hub (registry-1.docker.io) 在国内访问极慢或完全不通。

## 可用镜像源
| 镜像源 | 地址 | 速度 | 状态 |
|--------|------|------|------|
| Docker Hub 直连 | docker.io | 极慢/不通 | 需要 VPN 或代理 |
| 1ms.run | docker.1ms.run | ~100KB/s | 可用，较慢 |
| 道云 | docker.m.daocloud.io | 不稳定 | 时好时坏 |
| 网易 | hub-mirror.c.163.com | 已下线 | ❌ 不可用 |
| 腾讯云 | mirror.ccs.tencentyun.com | 需要账号 | ❌ 需认证 |

## 解决方案
**不用第三方镜像源**。OpenBlueprint 使用自建的 \`node-local\` 基础镜像：
\`\`\`dockerfile
FROM alpine:latest
RUN apk add --no-cache nodejs npm
\`\`\`
- Alpine 只有 3MB，走 HTTPS 下载（不走 Docker registry 协议）
- apk 安装 nodejs+npm 走 HTTP，速度稳定
- \`node-local\` 构建一次（22 分钟），永久缓存

## 配置
Settings → Docker Registry Mirror：仅影响 \`FROM xxxx/node:22-alpine\` 格式，已弃用。留空即可。`,
    tags: ['镜像源', 'Docker Hub', '国内网络'],
    severity: 'warning',
    author: 'system',
    createdAt: '2026-05-27T14:00:00Z',
    updatedAt: '2026-05-28T01:30:00Z'
  },
  {
    id: 'deployment-workflow',
    category: 'deployment',
    title: '完整部署流程（已验证可用）',
    content: `## 已验证的端到端流程

### 1. 环境准备（一次性）
- Docker Desktop → Hyper-V 后端（Settings → General → 取消 "Use WSL 2 based engine"）
- 构建基础镜像：\`node-local\` (alpine + nodejs + npm, 127MB)
- 保留构建缓存（BuildKit cache 跨后端持久化）

### 2. 代码生成
- 在 Chat 面板描述需求 → AI 分解为 Agent 模块
- Agent 列表中点击 "Regenerate (API)"（**推荐**，可靠）
- 或用 "Claude Code Generate"（需要本地 Claude Code CLI）

### 3. 部署
- Process 面板 → "1. 生成 docker-compose.yml"
- Process 面板 → "2. Build & Start"
- 等待构建完成（首次 5-15 分钟，后续秒级）
- 看到 "✓ 全部容器启动成功"

### 4. 验证
- "3. ps (查看状态)" → 所有容器 STATUS 为 Up
- 浏览器访问 http://localhost:4000/health（第一个 agent）
- 其他 agent 端口：4001, 4002, ...

### 5. 停止
- "5. down (停止并清理)" → 停止所有容器
- 镜像保留，下次启动秒级`,
    tags: ['部署', '流程', 'docker-compose'],
    severity: 'info',
    author: 'system',
    createdAt: '2026-05-28T02:00:00Z',
    updatedAt: '2026-05-28T02:00:00Z'
  },
  {
    id: '100-agent-scaling',
    category: 'architecture',
    title: '100+ Agent 大规模部署考虑',
    content: `## 当前能力
- 14 个 Agent 容器已在 Hyper-V + docker-compose 下成功运行
- 端口 4000-4999 支持 1000 个 agent
- Docker DNS 服务发现（http://service-name:3000）

## 100 Agent 的挑战
| 问题 | 影响 | 应对 |
|------|------|------|
| 并行构建 | 100 个同时 npm install 会 OOM | \`COMPOSE_PARALLEL_LIMIT=4\` |
| env var 膨胀 | 100 agent = 9900 条 URL 映射 | 已改为只传直接依赖的 URL |
| 容器内存 | 100 × 100MB = 10GB+ | 设置 \`mem_limit: 64m\` |
| 启动顺序 | 依赖链需要有序启动 | depends_on 控制 |
| 单机限制 | docker-compose 不适合 100+ 容器 | 考虑 Kubernetes/Docker Swarm |

## 升级路径
1. **50 agent 以内**：docker-compose 单机（当前架构 OK）
2. **50-200 agent**：docker-compose + 分批部署 + 内存限制
3. **200+ agent**：迁移到 Kubernetes + Helm charts
4. **生产环境**：CI/CD pipeline + 镜像 registry + 监控`,
    tags: ['规模化', '性能', '架构'],
    severity: 'info',
    author: 'system',
    createdAt: '2026-05-28T02:30:00Z',
    updatedAt: '2026-05-28T02:30:00Z'
  },
  {
    id: 'llm-code-quality-imports',
    category: 'code-gen',
    title: 'LLM 生成代码的模块引用错误（MODULE_NOT_FOUND）',
    content: `## 问题
容器启动后 30 秒内 crash，日志显示：
\`\`\`
Error: Cannot find module '/app/config.ts'
Error: Cannot find module '/app/service.ts'
\`\`\`

## 根因
LLM 生成的代码中 import 路径不正确。常见模式：
1. 文件引用了不存在或路径错误的模块：\`import { X } from './config'\` 但 config.ts 不存在
2. 循环依赖：A 引用 B，B 引用 A
3. 默认导出 vs 命名导出不匹配：\`import X from\` vs \`import { X } from\`
4. 文件名大小写不匹配（Linux 区分大小写，Windows 不区分）

## 验证一致性
成功的 Agent 具有一致的代码结构：
- \`types.ts\` — 所有接口和类型
- \`config.ts\` — 配置（导入 types，导出 config 对象）
- \`service.ts\` — 业务逻辑（导入 types + config，导出 Service class）
- \`index.ts\` — Express 入口（导入 service + config，导出 app）
- 不存在跨文件的不必要依赖

失败的 Agent 通常：
- 引用了未生成的文件（如 \`./utils\` 或 \`./database\`）
- config.ts 导入 service.ts（循环依赖）
- 默认导出 vs 命名导出混乱

## 排查方法
\`\`\`bash
# 1. 查看崩溃原因
docker logs iot-<agent-name> --tail 20

# 2. 检查文件完整性
ls -la output/<Agent-Name>/
head -5 output/<Agent-Name>/*.ts

# 3. 检查 import 引用
grep -r "from './" output/<Agent-Name>/
# 确保所有 from 后面的路径对应的文件都存在

# 4. 检查默认/命名导出匹配
grep "export default" output/<Agent-Name>/*.ts
grep "import.*from" output/<Agent-Name>/*.ts | grep -v "{"
\`\`\`

## 解决方案
1. **重新生成**：用 Regenerate (API) 重新生成该 agent
2. **手动修复 import**：用 "Edit Agent" 功能直接修代码
3. **改进 prompt**：优化 LLM worker 的 GEN_SKILL，约束模块依赖模式`,
    tags: ['代码质量', 'LLM', 'import', 'Module not found'],
    severity: 'warning',
    author: 'system',
    createdAt: '2026-05-28T03:30:00Z',
    updatedAt: '2026-05-28T03:30:00Z'
  },
]

export default function HelpPanel() {
  const [search, setSearch] = useState('')
  const [activeCat, setActiveCat] = useState<string>('all')
  const [selected, setSelected] = useState<string | null>(SEED_DOCS[0]?.id || null)
  const [docs] = useState<HelpDoc[]>(SEED_DOCS)

  const filtered = useMemo(() => {
    let d = docs
    if (activeCat !== 'all') d = d.filter(x => x.category === activeCat)
    if (search.trim()) {
      const q = search.toLowerCase()
      d = d.filter(x => x.title.toLowerCase().includes(q) || x.tags.some(t => t.toLowerCase().includes(q)) || x.content.toLowerCase().includes(q))
    }
    return d
  }, [docs, activeCat, search])

  const selectedDoc = docs.find(d => d.id === selected)

  return (
    <div className="h-full flex bg-bg">
      {/* Left: doc list */}
      <div className="w-[300px] border-r border-border flex flex-col flex-shrink-0">
        <div className="p-3 border-b border-border">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search help docs..."
            className="w-full bg-bg-tertiary border border-border rounded px-3 py-1.5 text-[12px] placeholder-text-tertiary outline-none focus:border-accent"
          />
        </div>
        <div className="px-2 py-1.5 border-b border-border flex gap-1 flex-wrap">
          <button onClick={() => setActiveCat('all')}
            className={`px-2 py-0.5 text-[10px] rounded-full ${activeCat === 'all' ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text'}`}>
            All
          </button>
          {Object.entries(HELP_CATEGORIES).map(([k, v]) => (
            <button key={k} onClick={() => setActiveCat(k)}
              className={`px-2 py-0.5 text-[10px] rounded-full ${activeCat === k ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text'}`}>
              {v}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto">
          {filtered.map(d => (
            <button key={d.id} onClick={() => setSelected(d.id)}
              className={`w-full text-left px-3 py-2 border-b border-border/30 transition-colors ${
                selected === d.id ? 'bg-accent/10 border-l-2 border-l-accent' : 'hover:bg-bg-tertiary border-l-2 border-l-transparent'
              }`}>
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  d.severity === 'critical' ? 'bg-error' : d.severity === 'warning' ? 'bg-warning' : 'bg-accent'
                }`} />
                <span className="text-[12px] font-medium text-text truncate">{d.title}</span>
              </div>
              <div className="flex items-center gap-1 ml-3">
                <span className="text-[10px] text-text-tertiary">{HELP_CATEGORIES[d.category]}</span>
                {d.tags.slice(0, 2).map(t => (
                  <span key={t} className="text-[9px] px-1 py-0.5 rounded bg-bg-tertiary text-text-tertiary">{t}</span>
                ))}
                <span className="text-[9px] text-text-tertiary ml-auto">{new Date(d.updatedAt).toLocaleDateString()}</span>
              </div>
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="px-3 py-8 text-center text-[12px] text-text-tertiary">No documents found</div>
          )}
        </div>
      </div>

      {/* Right: doc content */}
      <div className="flex-1 overflow-y-auto">
        {selectedDoc ? (
          <div className="p-6 max-w-3xl">
            <div className="flex items-center gap-2 mb-1">
              <span className={`px-1.5 py-0.5 text-[10px] rounded-full font-medium ${
                selectedDoc.severity === 'critical' ? 'bg-error/20 text-error' :
                selectedDoc.severity === 'warning' ? 'bg-warning/20 text-warning' : 'bg-accent/20 text-accent'
              }`}>
                {selectedDoc.severity.toUpperCase()}
              </span>
              <span className="text-[11px] text-text-tertiary">{HELP_CATEGORIES[selectedDoc.category]}</span>
              <span className="text-[11px] text-text-tertiary ml-auto">
                Updated: {new Date(selectedDoc.updatedAt).toLocaleString()}
              </span>
            </div>
            <h2 className="text-lg font-semibold text-text mb-4">{selectedDoc.title}</h2>
            <div className="flex gap-1.5 mb-4 flex-wrap">
              {selectedDoc.tags.map(t => (
                <span key={t} className="px-2 py-0.5 text-[10px] rounded-full bg-bg-tertiary text-text-secondary">{t}</span>
              ))}
            </div>
            <div className="prose prose-invert prose-sm max-w-none [&_h2]:text-[15px] [&_h2]:font-semibold [&_h2]:mt-6 [&_h2]:mb-2 [&_h3]:text-[13px] [&_h3]:font-medium [&_h3]:mt-4 [&_h3]:mb-1 [&_p]:text-[13px] [&_p]:leading-relaxed [&_p]:mb-3 [&_ul]:my-2 [&_li]:text-[13px] [&_li]:my-0.5 [&_code]:text-[11px] [&_code]:bg-bg-tertiary [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_pre]:bg-bg-tertiary [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:text-[11px] [&_pre]:overflow-x-auto [&_table]:w-full [&_table]:text-[12px] [&_th]:text-left [&_th]:p-1.5 [&_th]:border-b [&_th]:border-border [&_td]:p-1.5 [&_td]:border-b [&_td]:border-border/30 [&_strong]:text-text">
              {renderMarkdown(selectedDoc.content)}
            </div>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-text-tertiary text-sm">
            Select a document to view
          </div>
        )}
      </div>
    </div>
  )
}

// Simple markdown renderer (avoids extra dependency for help docs)
function renderMarkdown(md: string): JSX.Element[] {
  const lines = md.split('\n')
  const elements: JSX.Element[] = []
  let inCode = false
  let codeBuf: string[] = []
  let codeLang = ''
  let i = 0

  const pushCode = () => {
    if (codeBuf.length > 0) {
      elements.push(
        <pre key={`code-${i++}`} className="bg-bg-tertiary p-3 rounded-lg text-[11px] overflow-x-auto my-2">
          <code>{codeBuf.join('\n')}</code>
        </pre>
      )
      codeBuf = []
    }
  }

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        pushCode()
        inCode = false
      } else {
        codeLang = line.slice(3).trim()
        inCode = true
      }
      continue
    }
    if (inCode) { codeBuf.push(line); continue }

    if (line.startsWith('## ')) {
      pushCode()
      elements.push(<h2 key={`h2-${i++}`} className="text-[15px] font-semibold mt-6 mb-2 text-text">{line.slice(3)}</h2>)
    } else if (line.startsWith('### ')) {
      pushCode()
      elements.push(<h3 key={`h3-${i++}`} className="text-[13px] font-medium mt-4 mb-1 text-text">{line.slice(4)}</h3>)
    } else if (line.startsWith('| ')) {
      pushCode()
      const cells = line.split('|').filter(c => c.trim()).map(c => c.trim())
      if (cells.every(c => c.match(/^-+$/))) continue // skip separator
      const isHeader = line.includes('---')
      elements.push(
        <div key={`tr-${i++}`} className="flex gap-2 text-[12px] py-0.5">
          {cells.map((c, ci) => (
            <span key={ci} className={`flex-1 ${ci === 0 ? 'font-medium' : ''}`}>{c}</span>
          ))}
        </div>
      )
    } else if (line.startsWith('- ')) {
      pushCode()
      elements.push(<li key={`li-${i++}`} className="text-[13px] my-0.5 ml-4 list-disc text-text-secondary">{renderInline(line.slice(2))}</li>)
    } else if (line.trim()) {
      pushCode()
      elements.push(<p key={`p-${i++}`} className="text-[13px] leading-relaxed mb-2 text-text-secondary">{renderInline(line)}</p>)
    } else {
      pushCode()
    }
  }
  pushCode()
  return elements
}

function renderInline(text: string): JSX.Element {
  // Bold, code, etc.
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('`') && p.endsWith('`')) return <code key={i} className="bg-bg-tertiary px-1 py-0.5 rounded text-[11px]">{p.slice(1, -1)}</code>
        if (p.startsWith('**') && p.endsWith('**')) return <strong key={i} className="text-text">{p.slice(2, -2)}</strong>
        return <span key={i}>{p}</span>
      })}
    </>
  )
}
