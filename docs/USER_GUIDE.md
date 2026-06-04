# OpenBlueprint 系统详细说明与使用指南

---

## 目录

1. [系统概述](#1-系统概述)
2. [核心概念](#2-核心概念)
3. [界面详解](#3-界面详解)
4. [操作流程](#4-操作流程)
5. [Chat 与 Build 模式](#5-chat-与-build-模式)
6. [Agent 代码生成](#6-agent-代码生成)
7. [Skills 技能系统](#7-skills-技能系统)
8. [Agent 关系管理](#8-agent-关系管理)
9. [设置与配置](#9-设置与配置)
10. [Docker 部署](#10-docker-部署)
11. [常见问题](#11-常见问题)

---

## 1. 系统概述

OpenBlueprint 是一个**AI 驱动的低代码微服务开发平台**。它的核心思路是：

> 你用自然语言描述想要什么系统，AI 自动设计架构、生成代码、管理依赖关系。

### 1.1 它能做什么

| 能力 | 说明 |
|------|------|
| **架构设计** | 输入"做一个 IoT 平台"，AI 自动拆分为 Device Service、Telemetry Service、Rule Engine 等 Agent |
| **代码生成** | 每个 Agent 生成完整的 TypeScript 项目（Express API 或 React 前端） |
| **依赖管理** | 自动建立 Agent 之间的 `depends_on`、`communicates_with`、`shares_data` 关系 |
| **可视化编辑** | 在画布上拖拽 Agent 节点，编辑连线，查看数据流向 |
| **Docker 部署** | 一键生成 Docker Compose，所有 Agent 容器化运行 |
| **持续迭代** | 在 Chat 中说"给 Device Service 加一个批量导入功能"，AI 修改代码 |

### 1.2 与直接使用 Claude Code 的区别

| 对比 | 直接使用 Claude Code | OpenBlueprint |
|------|---------------------|-------------|
| 架构感知 | 无，需要手动描述项目结构 | 自动注入所有 Agent 的接口、依赖、环境变量 |
| 代码管理 | 手动管理文件 | 每个 Agent 独立目录，自动建立依赖关系 |
| 可视化 | 无 | 依赖关系图、生成进度、文件树 |
| 部署 | 手动写 Dockerfile | 自动生成 Dockerfile + Docker Compose |
| 持久化 | 无 | SQLite 持久化所有 Agent 定义、对话历史、关系 |

---

## 2. 核心概念

### 2.1 Project（项目）

Project 是顶级容器，包含一组相关的 Agent。一个典型的 Project 对应一个完整的系统（如"IoT 平台"、"电商后台"）。

**项目模式：**
- `project`：完整项目模式，包含 Agent 管理、图编辑、Docker Compose
- `standalone`：独立服务模式，仅管理单个 Agent

### 2.2 Agent（智能体）

Agent 是平台的核心单元。每个 Agent 代表一个**微服务**，包含完整的代码、配置和依赖关系。

**Agent 的属性：**

```
Agent
├── 基本信息：name, description
├── 技术规格 (spec_json)
│   ├── responsibilities：职责列表 ["用户CRUD", "JWT签发", ...]
│   ├── technologies：技术栈 ["express", "bcrypt", "jsonwebtoken", ...]
│   └── complexity：复杂度 (low / medium / high)
├── 接口定义 (interface_json)
│   ├── inputs：数据输入 [{name, type, source}]
│   └── outputs：数据输出 [{name, type, destination}]
├── 依赖关系 → 其他 Agent
└── 生成代码 → output/<AgentName>/
```

**Agent 状态流转：**

```
pending ──→ queued ──→ generating ──→ completed
                                     └──→ failed ──→ pending (手动重试)
```

### 2.3 Relationship（关系）

Agent 之间的连接定义了系统的**拓扑结构**：

| 关系类型 | 含义 | 图例 |
|----------|------|------|
| `depends_on` | 构建依赖——A 启动前 B 必须先可用 | 实线 → |
| `communicates_with` | 运行时通信——A 调用 B 的 API | 虚线 ⇢ |
| `shares_data` | 数据共享——A 和 B 读写同一数据 | 点线 ⤑ |

### 2.4 Skill（技能）

Skill 是**可复用的系统提示词模板**。Agent 生成时，所有活跃 Skill 的内容会注入到 Claude Code / LLM 的系统提示词中，影响代码生成行为。

系统预置 30+ 技能，涵盖：架构模式、安全规范、IoT 协议、前端框架、代码质量等。

---

## 3. 界面详解

### 3.1 主布局

`[SCREENSHOT: main-layout-annotated.png]`

界面分为四大区域：

| 区域 | 位置 | 功能 |
|------|------|------|
| **Sidebar** | 左侧 | 项目管理、Agent 列表、筛选、创建入口 |
| **Agent Graph** | 中央 | 可视化依赖关系图，支持拖拽、缩放、连线编辑 |
| **Detail Panel** | 右侧 | Chat/Build 对话、Agent 详情、文件浏览 |
| **Status Bar** | 底部 | LLM 连接状态、当前项目、快捷操作 |

### 3.2 Sidebar（侧边栏）

`[SCREENSHOT: sidebar-detail.png]`

**Projects 区域：**
- 显示所有项目列表
- `+ Project` 按钮创建新项目
- 每个项目显示名称、Agent 数量、状态图标
- 右键菜单：Edit / Delete / Set Active

**Agents 区域：**
- 按当前活跃项目筛选 Agent
- 搜索框支持按名称/ID 过滤
- 每个 Agent 显示状态颜色：
  - ⚪ 灰色 = pending
  - 🔵 蓝色 = queued
  - 🟡 黄色 = generating
  - 🟢 绿色 = completed
  - 🔴 红色 = failed
- 点击 Agent 跳转到图中心

### 3.3 Agent Graph（Agent 依赖图）

`[SCREENSHOT: agent-graph-detail.png]`

基于 React Flow 的可视化画布：

**节点操作：**
- **拖拽**：移动 Agent 位置
- **点击**：选中 Agent，右侧显示详情
- **右键菜单**：Generate Code / Regenerate / Delete / View Files

**连线操作：**
- **点击连线**：编辑关系类型（depends_on / communicates_with / shares_data）
- **删除连线**：选中后按 Delete 键

**画布操作：**
- **滚轮缩放**：放大/缩小
- **拖拽空白区**：平移画布
- **Ctrl+0**：重置视图
- **小地图**：右下角缩略图快速导航

**节点详情面板（选中 Agent 后显示）：**
- 基本信息：名称、描述、状态
- 技术规格：responsibilities、technologies
- 接口定义：inputs / outputs 表格
- 依赖列表：上游/下游 Agent
- 操作按钮：Generate、Regenerate、Build Docker

### 3.4 Chat Panel（对话面板）

`[SCREENSHOT: chat-panel-detail.png]`

详细说明见第 5 节。

### 3.5 Process Panel（进程面板）

`[SCREENSHOT: process-panel-detail.png]`

每个 Agent 一个 Tab，展示：

- **状态标签**：pending / queued / generating / completed / failed
- **生成进度**：实时终端输出（stdout/stderr）
- **文件列表**：生成完成后列出所有文件
- **操作按钮**：
  - **Build**：执行 `docker build`
  - **Re**：重新生成代码
  - **Stop**：终止正在进行的生成

### 3.6 Settings Panel（设置面板）

`[SCREENSHOT: settings-panel-detail.png]`

详细说明见第 8 节。

---

## 4. 操作流程

### 4.1 创建你的第一个系统（完整流程）

#### 步骤 1：创建项目

`[SCREENSHOT: workflow-01-create-project.png]`

1. 点击 Sidebar 的 `+ Project` 按钮
2. 输入项目名称，例如：`IoT Platform`
3. 描述项目目标，例如：`类似 ThingsBoard 的物联网平台`
4. 选择模式 `project`
5. 点击 Create

#### 步骤 2：在 Chat 中描述需求

`[SCREENSHOT: workflow-02-chat-requirements.png]`

切换到 **Chat** 模式，用自然语言描述你的系统需求：

```
我需要一个 IoT 平台，包含以下功能：
- 设备注册和管理
- 遥测数据采集和存储（时序数据）
- 告警规则引擎（温度过高、设备离线等触发告警）
- Web 管理界面
- 用户认证和权限管理
- 资产层级管理（站点 → 生产线 → 设备）
```

AI 会分析你的需求，建议架构方案。

#### 步骤 3：切换到 Build 模式创建 Agent

`[SCREENSHOT: workflow-03-build-create-agents.png]`

切换到 **Build** 模式，让 AI 自动创建 Agent：

```
根据上面的需求，创建所有需要的 Agent，建立它们之间的依赖关系
```

AI 会通过 MCP 工具链：
1. 调用 `list_agents` 查看现有 Agent（避免重复）
2. 调用 `create_agent` 逐个创建 Agent（含接口定义和依赖关系）
3. 调用 `get_project_context` 确认创建结果

**你会看到蓝色工具调用卡片**（tool-use）和**绿色结果卡片**（tool-result）实时显示。

#### 步骤 4：审查 Agent 架构

`[SCREENSHOT: workflow-04-review-graph.png]`

在 Agent Graph 中查看 AI 创建的架构：
- 检查 Agent 拆分是否合理
- 检查依赖关系是否正确
- 在 Chat 中提出修改意见："把 Alarm Service 和 Notification Service 合并"

#### 步骤 5：生成代码

`[SCREENSHOT: workflow-05-generate-code.png]`

逐个生成 Agent 代码（两种方式）：

**方式 A：逐个生成（推荐）**
1. 在 Agent Graph 中右键点击 Agent 节点
2. 选择 "Generate (Claude Code)"
3. 在 Process Panel 中观察生成进度
4. 验证文件列表和编译结果

**方式 B：通过 Build 模式批量生成**
```
为所有 completed 状态的 Agent 生成代码
```

#### 步骤 6：验证和部署

`[SCREENSHOT: workflow-06-docker-compose.png]`

1. 代码生成完成后，每个 Agent 目录下有完整的项目文件
2. 点击 "Docker Compose" 生成编排文件
3. 使用 Docker Desktop 启动整个系统

---

## 5. Chat 与 Build 模式

### 5.1 模式对比

`[SCREENSHOT: chat-vs-build.png]`

| 特性 | Chat 模式 | Build 模式 |
|------|-----------|------------|
| **底层引擎** | DeepSeek API（直接调用） | Claude Code CLI + MCP Server |
| **能力** | 对话、分析、建议 | 执行操作（创建/修改/删除 Agent、读写文件、执行命令） |
| **工具调用** | 无 | 14 个 MCP 工具（含关系管理） |
| **适用场景** | 需求分析、架构讨论、代码审查 | Agent CRUD、代码生成、系统操作 |
| **可逆性** | 只是对话，不影响系统 | 真实修改系统状态 |

### 5.2 Chat 模式详解

**使用方式：**
1. 确保顶部按钮选择 "Chat"
2. 在输入框输入问题或指令
3. 按 Enter 或点击发送

**Chat 模式会读取：**
- 当前项目的所有 Agent 信息
- 对话历史（上下文窗口内）
- 项目规则和设置

**Chat 模式不会：**
- 修改任何 Agent
- 创建/删除文件
- 执行 Shell 命令

### 5.3 Build 模式详解

**使用方式：**
1. 确保顶部按钮选择 "Build"
2. 在输入框输入操作指令
3. AI 会自主选择工具执行
4. **工具调用过程实时显示为卡片**

**工具调用卡片：**

`[SCREENSHOT: tool-call-cards.png]`

| 卡片颜色 | 含义 | 内容 |
|----------|------|------|
| 🔵 蓝色脉冲边框 | tool-use | 工具名称 + 输入参数 JSON |
| 🟢 绿色边框 | tool-result | 执行结果的文本摘要 |
| 🔴 红色边框 | tool-error | 错误信息和堆栈 |
| 💭 灰色文本 | thinking | AI 的中间推理过程 |

**Build 模式的指令示例：**

```
"列出当前项目的所有 Agent"
"把 Device Service 的 description 改为：负责设备CRUD、凭证管理和在线状态跟踪"
"删除重复的 agent"
"修改 agent-xxx 的 dependencies 增加 auth-service"
"为 Device UI Service 添加 React 和 Tailwind CSS 技术栈"
"检查哪些 Agent 还没有生成代码"
```

### 5.4 流式输出与停止

- Chat 和 Build 模式都支持**流式输出**（内容逐字显示）
- 点击输入框旁的 **Stop** 按钮或按 **Esc** 可中断生成
- Chat 中断：清除 AbortController，不再接收后续 token
- Build 中断：向 Claude Code 进程发送 SIGTERM，执行清理回调

---

## 6. Agent 代码生成

### 6.1 生成流程

```
用户触发 Generate
        │
        ▼
┌──────────────────┐
│  更新状态: queued │ → 防止并发（status=queued/generating 时拒绝新请求）
└──────┬───────────┘
       │
       ▼
┌──────────────────────────┐
│  收集项目上下文            │
│  - 兄弟 Agent 的接口/环境  │
│  - 活跃 Skills 的内容      │
│  - 项目规则/约束           │
└──────┬───────────────────┘
       │
       ▼
┌──────────────────────────┐
│  构建生成提示词            │
│  - Web 前端检测            │
│  - 技术栈约束              │
│  - 文件结构要求            │
└──────┬───────────────────┘
       │
       ▼
┌──────────────────────────┐
│  启动 Generator Worker    │
│  子进程: claude-worker.ts │
└──────┬───────────────────┘
       │
       ▼
┌──────────────────────────┐
│  Claude Code CLI          │
│  - Write/Edit 工具创建文件 │
│  - Bash 工具 npm install   │
│  - Glob/Grep 工具验证      │
└──────┬───────────────────┘
       │
       ▼
┌──────────────────────────┐
│  后处理                    │
│  - 扫描生成的文件           │
│  - 创建 package.json       │
│  - 创建 Dockerfile         │
│  - 验证 TypeScript 编译     │
└──────┬───────────────────┘
       │
       ▼
┌──────────────────┐
│  更新状态: completed│
│  WebSocket 广播     │
└──────────────────┘
```

### 6.2 两种生成方式

**Claude Code Generate（推荐）：**
- 使用 Claude Code CLI 的 Write 工具直接创建文件
- AI 自主决定文件结构和内容
- 生成后运行 `npm install && npx tsc --noEmit` 验证
- 适合复杂 Agent，能处理多文件依赖

**API Generate：**
- 使用 DeepSeek API 直接生成代码
- 基于模板进行文件创建
- 适合简单 Agent 或需要特定格式的场景

### 6.3 Web 前端检测

系统自动检测 Agent 是否需要 Web 前端：

```
检测关键词（中英文）：
react | vue | angular | html | css | frontend | web page | website |
browser | dashboard | 网页 | 前端 | 网站 | 页面 | 界面 | 图形化 | 浏览器 | 可视化
```

**检测为 Web 前端 →** Claude Code 会：
- 创建 HTML/CSS/JS 文件（`public/index.html`、`public/style.css`）
- 如果使用 React，创建 `src/*.tsx` 组件
- 使用 Vite 作为构建工具
- Express 服务器主要用于静态文件托管和 API 代理

**检测为后端 API →** Claude Code 会：
- 创建 Express + TypeScript 项目
- 包含 `GET /health` 端点
- 使用 axios 调用其他 Agent

### 6.4 生成结果验证

生成完成后，检查以下内容：

- [x] `package.json` 自动生成，包含所有 import 的依赖
- [x] `Dockerfile` 自动生成
- [x] TypeScript 文件通过 `tsc --noEmit` 编译检查
- [x] 所有文件无占位符（"TODO"、"implement later" 等）
- [x] `GET /health` 端点响应 `{ success: true, service: '<agent_name>' }`

---

## 7. Skills 技能系统

### 7.1 什么是 Skill

Skill 是**系统提示词片段**，在 Agent 生成时自动注入到 Claude Code / LLM 的上下文中。它们定义了代码的风格、规范和约束。

### 7.2 预置技能列表

`[SCREENSHOT: skills-list.png]`

系统预置了 30+ 技能模板，分为以下几类：

**架构类：**
- Microservices Architecture — 微服务设计原则
- Agent Relationship Types — 🤖 定义 depends_on / communicates_with / shares_data 三种关系
- Service Dependency Declaration — 创建 Agent 时自动声明依赖
- Event-Driven Architecture — 事件驱动通信优先
- Single Responsibility Principle — 单一职责原则
- API-First Design — API 优先设计
- Layered Building — 分层构建策略

**API 规范类：**
- REST API Pattern — REST 接口规范
- Health Check Endpoint — 健康检查端点（必装）
- API Pagination — 分页支持
- API Versioning Strategy — 版本化策略
- Rate Limiting — 限流

**安全类：**
- OWASP Top 10 Defense — 安全防护
- API Security Headers — 安全响应头
- JWT Authentication — JWT 认证
- Least Privilege Access — 最小权限
- Data Validation at Boundaries — 边界数据校验
- Input Validation — 输入校验

**前端类：**
- React Dashboard Frontend — React SPA 规范
- CORS Configuration — 跨域配置

**IoT 类：**
- MQTT IoT Protocol — MQTT 协议
- Time-Series Data — 时序数据处理

**代码质量类：**
- TypeScript Strict Mode — 严格 TypeScript
- Structured Logging — 结构化日志
- Error Handling Middleware — 错误处理中间件
- Environment-Based Config — 环境变量配置
- Docker Ready — Docker 就绪
- Testability First — 可测试性优先
- Unit Testing Required — 单元测试要求
- Fail Fast Report Clearly — 快速失败
- Code Review Checklist — 代码审查清单
- Dependency Hygiene — 依赖规范
- README Standards — 文档规范

### 7.3 自定义 Skill

1. 进入 Settings → Skills 页面
2. 点击 `+ New Skill`
3. 填写：
   - **Name**：技能名称
   - **Category**：分类（general / architecture / security / iot / frontend）
   - **Content**：系统提示词内容（Markdown 格式）
4. 启用/禁用：切换 `is_active` 开关

**Skill Content 示例：**

```markdown
## GraphQL API Pattern
When building GraphQL services:
- Use Apollo Server with Express
- Define types in `schema.graphql`
- Implement resolvers in `src/resolvers/`
- Include `GET /health` REST endpoint alongside GraphQL
- Use DataLoader for batching to avoid N+1 queries
```

---

## 8. Agent 关系管理

### 8.1 关系类型

Agent 之间通过三种关系连接，确保正确的构建顺序和服务发现：

| 关系类型 | 含义 | 使用场景 |
|----------|------|----------|
| `depends_on` | 构建时依赖 | Agent A 启动时需要 Agent B 已就绪。在 Docker Compose 中控制启动顺序 |
| `communicates_with` | 运行时通信 | 两个 Agent 在运行时互相发送请求/响应 |
| `shares_data` | 数据共享 | 两个 Agent 读写相同的数据库或事件流 |

### 8.2 自动分析（推荐）

在创建完所有 Agent 后，使用 AI 自动分析：

1. 进入 Chat → 切换到 **Build 模式**
2. 输入 "analyze relationships" 或 "分析我的 agent 关系"
3. Claude Code 会调用 `analyze_relationships` 工具，自动读取所有 Agent 的接口定义，创建关系

### 8.3 手动管理

在 Agent Graph 页面中：
- **拖拽连线**：从一个 Agent 节点拖到另一个创建关系
- **右键编辑**：修改关系类型和描述
- **选中删除**：选中连线按 Delete 键删除

---

## 9. 设置与配置

### 8.1 LLM 配置

`[SCREENSHOT: settings-llm-config.png]`

| 配置项 | 说明 | 示例 |
|--------|------|------|
| **Name** | 配置名称（自定义） | `DeepSeek V4 Pro` |
| **Provider** | LLM 提供商 | `deepseek` / `openai` |
| **API Key** | API 密钥 | `sk-...`（掩码显示 `sk-4••••4777`） |
| **Base URL** | API 地址 | `https://api.deepseek.com/v1` |
| **Model Name** | 模型名称 | `deepseek-v4-pro` |
| **Max Tokens** | 最大输出 token | `8192` |
| **Temperature** | 随机性参数 | `0` (精确) ~ `1` (创意) |
| **Enable Thinking** | 启用推理模式 | on/off |

**支持多配置：**
- 可创建多个 LLM 配置
- `is_default = true` 的配置用于 Chat/Build
- `is_active = false` 可禁用配置而不删除

**Test 按钮：**
- 发送 "Reply OK only" 到 LLM
- 返回成功/失败 + 延迟 + 响应预览
- 用于验证 API Key 和网络连通性

### 8.2 系统设置

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| **Theme** | dark | 界面主题（dark / light） |
| **Font Size** | 14 | 终端和代码编辑器字号 |
| **Default Output Path** | output | Agent 代码输出目录 |
| **Max Retries** | 3 | 代码生成失败最大重试次数 |
| **Generation Timeout** | 120000ms | 单次生成超时时间 |
| **Auto Save Conversations** | true | 自动保存对话历史 |
| **Docker Registry** | (空) | 私有镜像仓库地址 |

---

## 10. Docker 部署

### 9.1 前提条件

- Docker Desktop 已安装并运行
- Agent 代码已生成（status = completed）

### 9.2 生成 Docker Compose

`[SCREENSHOT: docker-compose-generation.png]`

1. 确保所有 Agent 状态为 `completed`
2. 在任一 Agent 的 Process Tab 中点击 "Docker Compose"
3. 系统自动生成：
   - 每个 Agent 的 `Dockerfile`
   - Gateway 服务（统一入口 + Dashboard）
   - `docker-compose.yml`

### 9.3 Docker Compose 架构

```
                    ┌─────────────┐
                    │   Browser   │
                    └──────┬──────┘
                           │ :8080
                    ┌──────▼──────┐
                    │   Gateway   │  ← 静态文件 + API 代理 + Dashboard
                    └──────┬──────┘
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                 ▼
   ┌────────────┐  ┌────────────┐   ┌────────────┐
   │  Auth      │  │  Device    │   │  Dashboard │
   │  Service   │  │  Service   │   │  Service   │
   └────────────┘  └──────┬─────┘   └────────────┘
                          │
                     ┌────▼─────┐
                     │ Telemetry │
                     │  Service  │
                     └──────────┘

网络: agent-network (bridge)
每个 Agent 通过 agent-name:3000 互相访问
环境变量: AUTH_SERVICE_URL=http://auth-service:3000
```

### 9.4 启动和调试

```bash
# 启动全部服务
docker compose up -d

# 查看日志
docker compose logs -f

# 查看指定 Agent
docker compose logs -f device-service

# 停止
docker compose down
```

---

## 11. 常见问题

### Q: Build 模式提示 "Agent is already queued or generating"

**原因**：该 Agent 正在生成中，或有另一个生成任务排队。

**解决**：等待当前任务完成，或在 Process Panel 中点击 Stop 终止当前任务。

### Q: Chat 模式无法回复

**原因**：LLM 配置错误或 API Key 无效。

**解决**：
1. 检查 Settings → LLM Configurations
2. 点击 Test 验证连通性
3. 确认 API Key 正确且有余额

### Q: 代码生成后文件为空或不完整

**原因**：Claude Code CLI 调用失败或编译错误。

**解决**：
1. 检查 Process Panel 的终端输出
2. 确认 Claude Code CLI 已安装：`npx @anthropic-ai/claude-code --version`
3. 重试：点击 Re 按钮重新生成

### Q: Agent Graph 连线混乱

**解决**：
- 点击空白区取消选中
- 拖拽节点调整布局
- 使用 Ctrl+0 重置视图

### Q: 数据会不会丢失？

**答**：系统使用 SQLite 持久化，数据库文件位于 `%APPDATA%/OpenBlueprint/openblueprint.db`：
- 每次变更后自动保存
- 服务器关闭时强制保存（SIGINT/SIGTERM/unhandledRejection）
- 登录后自动恢复上次会话数据

### Q: 如何更新 Agent 代码？

1. 在 Chat 中描述修改需求
2. 切换到 Build 模式："修改 Device Service 的 POST /devices 接口增加参数校验"
3. 或直接 Re-generate Agent（会覆盖旧代码，请先备份）

### Q: 端口被占用了怎么办？

系统会自动尝试 5173~5194 范围内的端口。如果全部被占：

```bash
# Windows: 查看占用端口的进程
netstat -ano | findstr :5173

# 修改 Vite 端口
# 编辑 vite.config.ts 中的 server.port
```

### Q: 如何查看 Agent 生成的源代码？

1. Process Panel 中选中 Agent Tab
2. 查看 Files 列表
3. 或在文件系统中直接打开 `output/<AgentName>/`

### Q: Build 模式和安全

Build 模式下的 Claude Code 配置了受限的工具权限：
- `--permission-mode bypassPermissions`（当前信任本地操作）
- `--allowedTools Write,Edit,Read,Bash,Glob,Grep`
- 没有网络访问权限（除 npm install）
- MCP 工具通过 `localhost:3001` 间接操作，所有变更可追踪

---
