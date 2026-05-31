# DD Platform

AI-Powered Agent Generation & Management Platform — 可视化的低代码微服务开发平台，集成 Claude Code 能力，通过自然语言描述自动生成、构建和管理微服务 Agent。

## 系统架构

```
┌──────────────────────────────────────────────────────┐
│                   Browser (React 19)                  │
│   ChatPanel │ AgentGraph │ ProcessPanel │ Sidebar    │
│        WebSocket ↔ REST API ↕ Vite HMR               │
├──────────────────────────────────────────────────────┤
│              Express Server (port 3001)               │
│   routes.ts │ generator.ts │ llm.ts │ memory.ts      │
│        sql.js (SQLite in-memory + 持久化)             │
├──────────────────────────────────────────────────────┤
│                 Claude Code CLI                       │
│   --mcp-config → MCP Server (stdio JSON-RPC)         │
│   Write/Edit/Read/Bash 工具 → 直接操作文件系统        │
└──────────────────────────────────────────────────────┘
```

## 功能概览

| 模块 | 功能 |
|------|------|
| **Chat** | DeepSeek 驱动的自然语言对话，理解项目上下文 |
| **Build** | Claude Code + MCP 工具链，AI 自主执行 Agent CRUD |
| **Agent 图** | 可视化 Agent 依赖关系图（React Flow） |
| **Process** | Agent 生成/构建进度监控，Docker 管理 |
| **Settings** | 多 LLM 配置（DeepSeek/OpenAI）、系统参数 |

---

## 快速开始

### 环境要求

- Node.js >= 18
- npm >= 9
- Docker Desktop（可选，用于容器化运行）
- Claude Code CLI（Build 模式需要）

### 安装

```bash
git clone https://github.com/kubuntukylin/DD-platform.git
cd DD-platform
npm install
```

### 启动

```bash
npm run dev
```

启动后访问：
- **前端界面**：`http://localhost:5173`
- **API 服务**：`http://localhost:3001`
- **WebSocket**：`ws://localhost:3001/ws`

### 配置 LLM

1. 打开 Settings 页面
2. 添加 LLM 配置（支持 DeepSeek、OpenAI）
3. 填入 API Key
4. 点击 Test 验证连接

---

## 界面说明

> 以下截图标注了界面各区域的功能。截图时请打开 `http://localhost:5173`，确认界面已完全加载。

### 1. 主界面总览

<img width="1754" height="940" alt="245ae75646ec698ae49e2299ffa8fcef" src="https://github.com/user-attachments/assets/5c1d2ca1-43a9-4b2f-aea0-341cf5fd690f" />


| 编号 | 区域 | 说明 |
|------|------|------|
| A | **Sidebar（左侧栏）** | 项目列表、Agent 列表，支持创建/删除/筛选 |
| B | **Agent Graph（中央）** | Agent 依赖关系可视化，节点拖拽，连线编辑 |
| C | **Chat Panel（右侧）** | Chat/Build 模式切换，对话历史，流式输出 |
| D | **Status Bar（底部）** | LLM 连接状态、当前项目信息 |

### 2. 创建项目


**操作步骤：**
1. 点击 Sidebar 顶部的 `+ Project` 按钮
2. 输入项目名称和描述
3. 选择模式：`project`（含 Agent 管理）或 `standalone`（独立服务）
4. 点击 Create

### 3. Agent 管理

<img width="1226" height="805" alt="image" src="https://github.com/user-attachments/assets/c5faebc8-1bc0-489a-8ca4-95c0b9bf69ae" />


**Agent 是平台的核心单元**，每个 Agent 代表一个微服务：

- **节点**：显示 Agent 名称、状态颜色（pending=灰、queued=蓝、generating=黄、completed=绿、failed=红）
- **连线**：`depends_on`（实线）、`communicates_with`（虚线）、`shares_data`（点线）
- **右键菜单**：Generate、Regenerate、Delete、View Files

### 4. Chat 模式

**Chat 模式**使用 DeepSeek 进行对话：
- 理解项目架构和 Agent 关系
- 回答技术问题
- 提供建议和分析
- 不执行实际操作

### 5. Build 模式

<img width="1770" height="461" alt="image" src="https://github.com/user-attachments/assets/8f081bea-da02-43dc-ac05-3e1acdab4058" />


**Build 模式**使用 Claude Code + MCP 工具链：
- 创建/修改/删除 Agent
- 查询项目状态
- 执行 Shell 命令
- 读取/写入文件

工具调用过程以卡片形式实时显示：
- 🔵 **蓝色边框**：工具调用请求（tool-use），显示工具名和参数 JSON
- 🟢 **绿色边框**：工具执行结果（tool-result）
- 🔴 **红色边框**：执行错误
- 💭 **思考文本**：AI 的中间推理过程

### 6. Agent 代码生成

`[SCREENSHOT: agent-generate.png]`
*截取 Process Panel 的 Agent 详情页，展示代码生成进度和输出文件列表*

**生成方式：**
- **Claude Code Generate**：调用 Claude Code CLI，AI 自主创建完整项目文件
- **API Generate**：通过 DeepSeek API 生成代码

生成过程中会显示：
- 实时终端输出（stdout/stderr）
- 文件生成列表（✓ 绿色标记）
- 编译验证结果
- package.json / Dockerfile 自动生成

### 7. Process 面板

`[SCREENSHOT: process-panel.png]`
*截取 Process Panel 的 Agent Tab 视图，展示各 Agent 的状态、生成进度、Build/Re 按钮*

- 每个 Agent 一个 Tab
- 状态标签：`pending` / `queued` / `generating` / `completed` / `failed`
- **Build** 按钮：Docker 构建
- **Re** 按钮：重新生成代码
- 终端输出实时滚动

### 8. Settings 配置

`[SCREENSHOT: settings-llm.png]`
*截取 Settings 页面，展示 LLM 配置表单，注意 API Key 以掩码形式显示*

**可配置项：**
- **LLM Configurations**：Provider、API Key（掩码显示）、Model、Base URL、Temperature、Max Tokens、Thinking 开关
- **System Settings**：Theme（dark/light）、Font Size、Default Output Path、Max Retries、Generation Timeout
- **Test** 按钮验证 API 连通性

### 9. Skills 管理

`[SCREENSHOT: skills-panel.png]`
*截取 Skills Panel，展示系统预置的 30+ 技能模板列表*

系统预置了 30+ 技能模板：
- Build Mode Output Format
- Microservices Architecture
- REST API Pattern
- Health Check Endpoint
- Docker Ready
- TypeScript Strict Mode
- JWT Authentication
- OWASP Top 10 Defense
- API Security Headers
- 等等

每个 Skill 包含 `name`、`category`、`prompt_content`，在 Agent 生成时作为系统提示词注入。

---

## API 参考

基地址：`http://localhost:3001`

### Projects

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/projects` | 列出所有项目 |
| POST | `/api/projects` | 创建项目 |
| GET | `/api/projects/:id` | 获取项目详情 |
| PUT | `/api/projects/:id` | 更新项目 |
| DELETE | `/api/projects/:id` | 删除项目（需 `?confirm=true`） |
| GET | `/api/projects/:id/tree` | 项目文件树 |
| GET | `/api/projects/:id/docker-compose` | 生成 Docker Compose |

### Agents

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/agents?projectId=X` | 列出项目下 Agent |
| POST | `/api/agents` | 创建 Agent |
| GET | `/api/agents/:id` | 获取 Agent 详情 |
| PUT | `/api/agents/:id` | 更新 Agent（自动同步 spec_json） |
| DELETE | `/api/agents/:id` | 删除 Agent |
| POST | `/api/agents/:id/generate-claude` | Claude Code 生成代码 |
| POST | `/api/agents/:id/regenerate` | 重新生成代码 |
| GET | `/api/agents/:id/files` | 列出生成文件 |
| GET | `/api/agents/:id/file-tree` | 递归文件树 |

### Conversations

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/conversations` | 列出会话 |
| POST | `/api/conversations` | 创建会话 |
| POST | `/api/conversations/:id/chat` | 发送消息（`buildMode: true/false`） |
| POST | `/api/conversations/:id/stop` | 停止流式响应 |
| DELETE | `/api/conversations/:id` | 删除会话 |

### 其他

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/llm-configs` | LLM 配置列表（Key 掩码） |
| POST | `/api/llm-configs/:id/test` | 测试 LLM 连通性 |
| GET | `/api/skills` | 技能模板列表 |
| POST | `/api/skills` | 创建技能 |
| GET | `/api/settings` | 系统设置 |
| PUT | `/api/settings/:key` | 更新设置 |
| GET | `/api/files?path=X` | 读取文件 |
| PUT | `/api/files` | 写入文件 |
| POST | `/api/shell/exec` | 异步执行 Shell |
| POST | `/api/shell/exec-sync` | 同步执行 Shell |
| GET | `/api/docker/check` | Docker 可用性检测 |

---

## MCP 工具列表

Build 模式下 Claude Code 可调用的工具：

| 工具 | 说明 |
|------|------|
| `list_agents` | 列出项目所有 Agent |
| `create_agent` | 创建新 Agent |
| `update_agent` | 修改 Agent |
| `delete_agent` | 删除 Agent |
| `list_agent_files` | 列出 Agent 文件 |
| `list_file_tree` | 递归文件树 |
| `read_file` | 读取文件内容 |
| `write_file` | 写入文件 |
| `exec_shell` | 执行 Shell 命令 |
| `list_projects` | 列出所有项目 |
| `get_project_context` | 获取项目完整上下文 |

---

## 项目结构

```
DD-platform/
├── src/
│   ├── renderer/          # React 前端
│   │   ├── App.tsx        # 主布局
│   │   ├── ChatPanel.tsx  # Chat/Build 面板
│   │   ├── AgentGraph.tsx # Agent 关系图
│   │   ├── ProcessPanel.tsx # 生成/构建进度
│   │   ├── Sidebar.tsx    # 项目/Agent 列表
│   │   ├── SettingsPanel.tsx # 设置
│   │   ├── SkillsPanel.tsx # 技能管理
│   │   ├── stores.ts      # Zustand 状态管理
│   │   ├── api.ts         # HTTP + WebSocket 客户端
│   │   └── assets/        # 样式文件
│   ├── server/            # Express 后端
│   │   ├── index.ts       # 入口 + WebSocket
│   │   ├── routes.ts      # 40+ API 端点
│   │   ├── generator.ts   # Agent 代码生成
│   │   ├── llm.ts         # LLM Provider (DeepSeek/OpenAI)
│   │   ├── db.ts          # SQLite 数据库
│   │   ├── memory.ts      # 对话记忆系统
│   │   ├── rag.ts         # RAG 检索增强
│   │   └── mcp-server.ts  # MCP stdio 代理
│   └── shared/            # 共享类型
│       └── types/         # Agent, Conversation, Project 等类型定义
├── generator-worker/      # 代码生成 Worker 子进程
│   ├── claude-worker.ts   # Claude Code 调用
│   └── index.ts           # API 生成
├── mcp-config.json        # MCP Server 配置
├── package.json           # 项目配置
└── vite.config.ts         # Vite 构建配置
```

---

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 19, TypeScript, Zustand 5, React Flow, Monaco Editor, XTerm.js, Tailwind CSS |
| 后端 | Express 5, TypeScript, WebSocket (ws), sql.js (SQLite WASM) |
| AI | DeepSeek V4 Pro, Claude Code CLI, MCP (Model Context Protocol) |
| 构建 | Vite, tsx, concurrently |
| 容器 | Docker, Docker Compose |

---

## License

MIT


作者邮箱：k_ubuntu@hotmail.com
