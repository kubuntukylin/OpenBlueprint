# OpenBlueprint

> **AI-Powered Agent Generation & Management Platform** | **AI 驱动的智能体生成与管理平台**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19.2-61dafb)](https://react.dev/)
[![Node](https://img.shields.io/badge/Node-18%2B-green)](https://nodejs.org/)

用自然语言描述系统需求，AI 自动设计微服务架构、生成完整代码、建立依赖关系，一键生成 Docker Compose 部署。

*Describe your system in natural language — AI designs the microservice architecture, generates complete code, builds dependency graphs, and produces Docker Compose with one click.*

---

## 目录 / Table of Contents

- [系统架构 / Architecture](#系统架构--architecture)
- [界面截图 / Screenshots](#界面截图--screenshots)
- [核心能力 / Core Capabilities](#核心能力--core-capabilities)
- [快速开始 / Quick Start](#快速开始--quick-start)
- [Chat 与 Build 模式 / Chat & Build Modes](#chat-与-build-模式--chat--build-modes)
- [Agent 代码生成 / Agent Code Generation](#agent-代码生成--agent-code-generation)
- [Skills 技能系统 / Skills System](#skills-技能系统--skills-system)
- [MCP 工具链 / MCP Toolchain](#mcp-工具链--mcp-toolchain)
- [API 参考 / API Reference](#api-参考--api-reference)
- [项目结构 / Project Structure](#项目结构--project-structure)
- [技术栈 / Tech Stack](#技术栈--tech-stack)

---

## 系统架构 / Architecture

```
┌──────────────────────────────────────────────────────────┐
│              Browser (React 19 + TypeScript)              │
│  ChatPanel │ AgentGraph │ ProcessPanel │ Sidebar         │
│       ↕ WebSocket    ↕ REST API    ↕ Vite HMR            │
├──────────────────────────────────────────────────────────┤
│          Express Server (port 3001)                       │
│  routes.ts │ generator.ts │ llm.ts │ memory.ts │ rag.ts  │
│       ↕ sql.js (SQLite WASM — in-memory + persisted)     │
├──────────────────────────────────────────────────────────┤
│            Claude Code CLI (Build Mode)                   │
│  --mcp-config → MCP Server (stdio JSON-RPC)              │
│  Write │ Edit │ Read │ Bash │ Glob │ Grep                │
└──────────────────────────────────────────────────────────┘
```

**数据流 / Data Flow：**

| 层 / Layer | 职责 / Responsibility |
|------------|----------------------|
| **Frontend** | React UI, WebSocket 实时事件, Zustand 状态管理 / React UI, real-time WebSocket events, Zustand state management |
| **Server** | REST API, 流式 LLM 调用, DB 持久化, 代码生成调度 / REST API, streaming LLM calls, DB persistence, generation orchestration |
| **MCP Server** | stdio JSON-RPC, 工具调用代理到主服务 / stdio JSON-RPC, proxies tool calls to main server HTTP API |
| **Claude Code** | AI 自主操作文件、执行命令、管理 Agent / AI autonomously writes files, runs commands, manages agents |

---

## 界面截图 / Screenshots

### 主界面 / Main Interface

<img width="1754" height="940" alt="OpenBlueprint Main Interface" src="https://github.com/user-attachments/assets/5c1d2ca1-43a9-4b2f-aea0-341cf5fd690f" />

| # | 区域 / Panel | 说明 / Description |
|---|-------------|-------------------|
| **A** | Sidebar（侧边栏） | 项目列表、Agent 列表，创建/搜索/筛选 / Projects, agents, create/search/filter |
| **B** | Agent Graph（依赖图） | 依赖关系可视化，节点拖拽，连线编辑 / Dependency visualization, drag nodes, edit edges |
| **C** | Chat Panel（对话面板） | Chat/Build 模式切换，对话历史，流式输出 / Mode toggle, conversation history, streaming output |
| **D** | Status Bar（状态栏） | LLM 连接状态、当前项目 / LLM status, current project |

### Agent 依赖关系图 / Agent Dependency Graph

<img width="1226" height="805" alt="Agent Graph" src="https://github.com/user-attachments/assets/c5faebc8-1bc0-489a-8ca4-95c0b9bf69ae" />

Agent 是平台的核心单元，每个 Agent 代表一个微服务。**节点**显示 Agent 名称和状态颜色（pending=灰/gray、queued=蓝/blue、generating=黄/yellow、completed=绿/green、failed=红/red）。**连线**表示三种关系：`depends_on`（实线/solid — 构建依赖）、`communicates_with`（虚线/dashed — 运行时通信）、`shares_data`（点线/dotted — 数据共享）。

*Each Agent represents a microservice. **Nodes** show agent name and status color. **Edges** represent three relationship types: `depends_on` (solid — build dependency), `communicates_with` (dashed — runtime communication), `shares_data` (dotted — data sharing).*

### Build 模式工具调用 / Build Mode Tool Calls

<img width="1770" height="461" alt="Build Mode" src="https://github.com/user-attachments/assets/8f081bea-da02-43dc-ac05-3e1acdab4058" />

Build 模式使用 Claude Code + MCP 工具链，AI 自主执行 Agent CRUD、文件读写、Shell 命令等操作。工具调用过程以彩色卡片实时显示：🔵 蓝色脉冲边框 = 工具调用（tool-use），🟢 绿色边框 = 执行结果（tool-result），🔴 红色边框 = 错误（tool-error），💭 灰色文本 = AI 推理（thinking）。

*Build mode uses Claude Code + MCP tools. AI autonomously performs agent CRUD, file operations, and shell commands. Tool calls are displayed as colored cards in real time: 🔵 blue pulse = tool-use, 🟢 green = tool-result, 🔴 red = error, 💭 gray = AI reasoning.*

---

## 核心能力 / Core Capabilities

### 架构设计 / Architecture Design

输入自然语言需求，AI 自动拆分微服务并设计接口：/ *Input natural language requirements — AI decomposes into microservices and designs interfaces:*

| 输入 / Input | AI 输出 / AI Output |
|--------------|--------------------|
| *"做一个类似 ThingsBoard 的 IoT 平台"* | API Gateway + Auth Service + Device Service + Telemetry Service + Rule Engine + Alarm Service + Dashboard Service |
| *"I need an e-commerce backend"* | Order Service + Product Service + User Service + Payment Service + Notification Service |

### 代码生成 / Code Generation

每个 Agent 生成完整的 TypeScript 项目：/ *Each Agent produces a complete, runnable TypeScript project:*

```
output/Device-Service/
├── src/
│   ├── index.ts          # Entry point / 入口文件
│   ├── config.ts         # Environment config / 环境配置
│   ├── types.ts          # Type definitions / 类型定义
│   ├── routes/           # API routes / 路由
│   └── services/         # Business logic / 业务逻辑
├── package.json          # Auto-detected dependencies / 自动检测依赖
├── Dockerfile            # Auto-generated / 自动生成
└── tsconfig.json         # TypeScript config
```

### Docker Compose 一键部署 / One-Click Docker Deploy

自动生成完整编排文件 — Gateway（统一入口 + Dashboard）+ 所有 Agent 容器 + 网络配置。

*Automatically generates complete Docker Compose — Gateway (unified entry + dashboard) + all agent containers + network configuration.*

---

## 快速开始 / Quick Start

### 前提条件 / Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- **Docker Desktop** (可选/optional，容器化部署)
- **Claude Code CLI** (Build 模式需要 / required for Build mode)

### 安装与启动 / Install & Launch

```bash
git clone https://github.com/kubuntukylin/OpenBlueprint.git
cd OpenBlueprint
npm install
npm run dev
```

| 服务 / Service | 地址 / URL |
|----------------|------------|
| 前端界面 / Frontend | `http://localhost:5173` |
| API 服务 / API Server | `http://localhost:3001` |
| WebSocket | `ws://localhost:3001/ws` |

### 配置 LLM / Configure LLM

1. 打开 Settings 页面 / *Open Settings*
2. 添加 LLM 配置（支持 DeepSeek、OpenAI 及兼容接口）/ *Add config (DeepSeek, OpenAI, compatible APIs)*
3. 填入 API Key / *Enter API Key*
4. 点击 **Test** 验证连接 / *Click Test to verify*

---

## Chat 与 Build 模式 / Chat & Build Modes

| 特性 / Feature | 🗨️ Chat | 🔧 Build |
|---------------|---------|----------|
| **引擎 / Engine** | DeepSeek API (直接调用 / direct) | Claude Code CLI + MCP Server |
| **能力 / Capability** | 对话、分析、建议 / dialogue, analysis, suggestions | 执行操作 / executes actions |
| **工具调用 / Tool use** | 无 / None | 11 MCP tools |
| **适用场景 / Use case** | 需求分析、架构讨论、Code Review | Agent CRUD、代码生成、系统操作 |
| **影响系统 / Mutates** | 否 / No | 是 / Yes |

**Chat 模式**是对话助手，读取项目上下文（Agent、关系、对话历史），提供分析和建议，但不执行实际操作。/ *Chat mode is a conversational assistant that reads project context (agents, relationships, history) to provide analysis and suggestions without performing actual operations.*

**Build 模式**是执行引擎。AI 通过 MCP 工具自主操作——创建 Agent、修改文件、运行命令——每个动作作为彩色卡片实时显示。/ *Build mode is the execution engine. AI operates autonomously via MCP tools — creating agents, editing files, running commands — with each action displayed as a colored card in real time.*

---

## Agent 代码生成 / Agent Code Generation

### 生成流程 / Pipeline

```
User triggers Generate
       │
       ▼
 Status: queued  (prevents concurrent generation / 防止并发)
       │
       ▼
 Collect context  (sibling Agents, Skills, project rules / 兄弟Agent接口、技能、规则)
       │
       ▼
 Detect agent type  (web frontend vs backend API / 检测Web前端 vs 后端API)
       │
       ▼
 Spawn Claude Code CLI  (Write/Edit/Bash tools create project files)
       │
       ▼
 Post-process  (scan files, build package.json, Dockerfile, validate tsc)
       │
       ▼
 Status: completed  (WebSocket broadcast / WebSocket广播)
```

### Web 前端自动检测 / Web Frontend Detection

系统自动分析 Agent 的 `technologies` + `description` + `responsibilities`：/ *The system analyzes agent metadata to determine the project type:*

- **Web 前端匹配 / Match** → 生成 HTML/CSS/React 组件 + Vite 构建 / *HTML/CSS/React with Vite*
- **后端匹配 / No match** → 生成 Express + TypeScript REST API / *Express + TypeScript REST API*

### 验证清单 / Verification Checklist

- ✅ `package.json` — 自动包含所有 import 依赖 / *Auto-includes all imports*
- ✅ `Dockerfile` — 自动生成 / *Auto-generated*
- ✅ TypeScript — 通过 `tsc --noEmit` 编译检查 / *Passes compilation*
- ✅ `GET /health` — 每个 Agent 包含健康检查 / *Every agent has health endpoint*
- ✅ 无占位符 — 代码完整可运行 / *No placeholders — complete, runnable code*

---

## Skills 技能系统 / Skills System

系统预置 **30+ 技能模板**，Agent 生成时自动注入到 LLM 系统提示词：/ *30+ preset skill templates injected into LLM system prompts during code generation:*

| 分类 / Category | 技能 / Skills |
|-----------------|--------------|
| **架构 / Architecture** | Microservices, Agent Relationships, Service Dependencies, Event-Driven, Single Responsibility, API-First Design, Layered Building |
| **API 规范 / API Standards** | REST API Pattern, Health Check, Pagination, Versioning, Rate Limiting |
| **安全 / Security** | OWASP Top 10, Security Headers, JWT Auth, Least Privilege, Input Validation |
| **前端 / Frontend** | React Dashboard, CORS Configuration |
| **IoT** | MQTT Protocol, Time-Series Data |
| **代码质量 / Quality** | TypeScript Strict, Structured Logging, Error Handling, Env-Based Config, Unit Testing |

每个 Skill 包含 `name`、`category`、`prompt_content`，可在 Skills 面板中自定义或禁用。

*Each Skill has a name, category, and prompt_content. Customize or disable in the Skills panel.*

---

## MCP 工具链 / MCP Toolchain

Build 模式下 Claude Code 通过 MCP (Model Context Protocol) 调用的工具：/ *Tools available to Claude Code in Build mode:*

| 工具 / Tool | 说明 / Description |
|------------|-------------------|
| `list_agents` | 列出项目所有 Agent / List all agents |
| `create_agent` | 创建新 Agent / Create new agent |
| `update_agent` | 修改 Agent 属性（含依赖关系）/ Modify agent (incl. dependencies) |
| `delete_agent` | 删除 Agent / Delete agent |
| `list_agent_files` | 列出生成文件 / List generated files |
| `list_file_tree` | 递归文件树 / Recursive file tree |
| `read_file` | 读取文件 / Read file content |
| `write_file` | 写入文件 / Write file |
| `exec_shell` | 执行 Shell 命令 / Execute shell command |
| `list_projects` | 列出所有项目 / List all projects |
| `get_project_context` | 获取项目完整上下文 / Get full project context |
| `create_relationship` | 创建 Agent 关系 / Create relationship |
| `delete_relationship` | 删除关系 / Delete relationship |
| `analyze_relationships` | 🤖 AI 自动分析创建关系 / AI auto-analyzes & creates relationships |

实现文件 / Implementation: [src/server/mcp-server.ts](src/server/mcp-server.ts)

---

## API 参考 / API Reference

Base URL: `http://localhost:3001`

### Projects

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | 列出所有项目 / List all |
| POST | `/api/projects` | 创建项目 / Create |
| GET | `/api/projects/:id` | 获取详情 / Get by ID |
| PUT | `/api/projects/:id` | 更新项目 / Update |
| DELETE | `/api/projects/:id?confirm=true` | 删除项目（需确认/requires confirmation） |
| GET | `/api/projects/:id/tree` | 文件树 / File tree |
| GET | `/api/projects/:id/docker-compose` | 生成 Docker Compose |

### Agents

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/agents?projectId=X` | 按项目列出 / List by project |
| POST | `/api/agents` | 创建 Agent / Create |
| GET | `/api/agents/:id` | 获取详情 / Get by ID |
| PUT | `/api/agents/:id` | 更新（自动同步 spec_json）/ Update |
| DELETE | `/api/agents/:id` | 删除 / Delete |
| POST | `/api/agents/:id/generate-claude` | Claude Code 生成代码 |
| POST | `/api/agents/:id/regenerate` | 重新生成 / Regenerate |
| GET | `/api/agents/:id/files` | 文件列表 / Generated files |
| GET | `/api/agents/:id/file-tree` | 递归文件树 / Recursive tree |

### Relationships

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/relationships?projectId=X` | 按项目列出 / List by project |
| POST | `/api/relationships` | 创建关系 / Create |
| DELETE | `/api/relationships/:id` | 删除关系 / Delete |
| POST | `/api/projects/:id/analyze-relationships` | 🤖 AI 自动分析创建关系 |

### Conversations

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/conversations` | 列出会话 / List |
| POST | `/api/conversations` | 创建会话 / Create |
| POST | `/api/conversations/:id/chat` | 发送消息 `{content, buildMode}` / Send |
| POST | `/api/conversations/:id/stop` | 停止流式 / Stop streaming |
| DELETE | `/api/conversations/:id` | 删除会话 / Delete |

### Other / 其他

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/llm-configs` | LLM 配置（Key 掩码/masked） |
| POST | `/api/llm-configs/:id/test` | 测试 LLM 连通性 / Test |
| GET/POST/PUT/DELETE | `/api/skills` | 技能 CRUD |
| GET/PUT | `/api/settings` | 系统设置 / Settings |
| GET/PUT | `/api/files` | 文件读写 / File read & write |
| POST | `/api/shell/exec-sync` | 同步 Shell / Sync exec |
| GET | `/api/docker/check` | Docker 可用性检测 |

---

## 项目结构 / Project Structure

```
OpenBlueprint/
├── src/
│   ├── renderer/              # React 前端 / React Frontend
│   │   ├── App.tsx            # 主布局 / Main layout
│   │   ├── ChatPanel.tsx      # Chat + Build 面板
│   │   ├── AgentGraph.tsx     # Agent 依赖关系图 / Dependency graph
│   │   ├── ProcessPanel.tsx   # 生成进度 + Docker 构建 / Generation & build
│   │   ├── Sidebar.tsx        # 项目/Agent 列表 / Project & agent list
│   │   ├── SettingsPanel.tsx  # 设置 / Settings
│   │   ├── SkillsPanel.tsx    # 技能管理 / Skills management
│   │   ├── stores.ts          # Zustand 状态管理 / State
│   │   └── api.ts             # HTTP + WebSocket client
│   ├── server/                # Express 后端 / Express Backend
│   │   ├── index.ts           # 入口 + WebSocket / Entry
│   │   ├── routes.ts          # 40+ API endpoints
│   │   ├── generator.ts       # 代码生成调度 / Generation orchestrator
│   │   ├── llm.ts             # LLM Provider
│   │   ├── db.ts              # SQLite (sql.js)
│   │   ├── memory.ts          # 对话记忆 / Memory
│   │   ├── rag.ts             # RAG 检索增强
│   │   └── mcp-server.ts      # MCP stdio proxy
│   └── shared/types/          # 共享类型定义 / Shared types
├── generator-worker/          # 代码生成 Worker / Generation worker
├── docs/USER_GUIDE.md         # 详细使用指南 / Detailed user guide
├── mcp-config.json            # MCP configuration
└── vite.config.ts             # Vite build config
```

---

## 技术栈 / Tech Stack

| 层 / Layer | 技术 / Technology |
|------------|------------------|
| **Frontend** | React 19, TypeScript 5.8, Zustand 5, React Flow, Monaco Editor, XTerm.js, Tailwind CSS 4 |
| **Backend** | Express 5, WebSocket (ws), sql.js (SQLite WASM), Node.js 24 |
| **AI / LLM** | DeepSeek V4 Pro, Claude Code CLI, MCP (Model Context Protocol), OpenAI SDK |
| **Build** | Vite 7, tsx, concurrently |
| **Container** | Docker, Docker Compose |

---

## License

MIT

📧 k_ubuntu@hotmail.com

---

<p align="center">
  <sub>Built with TypeScript · React · Express · AI</sub>
</p>
