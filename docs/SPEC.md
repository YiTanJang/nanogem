# NanoGem Specification

A personal Gemini assistant accessible via Discord, with persistent memory per conversation, scheduled tasks, and Kubernetes-based agent execution.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Folder Structure](#folder-structure)
3. [Configuration](#configuration)
4. [Memory System](#memory-system)
5. [Session Management](#session-management)
6. [Message Flow](#message-flow)
7. [Commands](#commands)
8. [Scheduled Tasks](#scheduled-tasks)
9. [MCP Servers](#mcp-servers)
10. [Deployment](#deployment)
11. [Security Considerations](#security-considerations)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        HOST (Linux/macOS)                            │
│                   (Main Node.js Process)                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐                     ┌────────────────────┐        │
│  │   Discord    │────────────────────▶│   SQLite Database  │        │
│  │ (discord.js) │◀────────────────────│   (messages.db)    │        │
│  └──────────────┘   store/send        └─────────┬──────────┘        │
│                                                  │                   │
│         ┌────────────────────────────────────────┘                   │
│         │                                                            │
│         ▼                                                            │
│  ┌──────────────────┐    ┌──────────────────┐    ┌───────────────┐  │
│  │  Message Loop    │    │  Scheduler Loop  │    │  IPC Watcher  │  │
│  │  (polls SQLite)  │    │  (checks tasks)  │    │  (file-based) │  │
│  └────────┬─────────┘    └────────┬─────────┘    └───────────────┘  │
│           │                       │                                  │
│           └───────────┬───────────┘                                  │
│                       │ spawns agent pod                             │
│                       ▼                                              │
├─────────────────────────────────────────────────────────────────────┤
│                        KUBERNETES CLUSTER                            │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    AGENT RUNNER POD                           │   │
│  │                                                                │   │
│  │  Working directory: /workspace/group (mounted from PVC)        │   │
│  │  Volume mounts:                                                │   │
│  │    • groups/{name}/ → /workspace/group                         │   │
│  │    • groups/global/ → /workspace/global/ (non-main only)        │   │
│  │    • data/sessions/{group}/.gemini/ → /home/node/.gemini/      │   │
│  │    • Additional subpaths → /workspace/extra/*                  │   │
│  │                                                                │   │
│  │  Tools (all groups):                                           │   │
│  │    • Bash (safe - sandboxed in pod!)                           │   │
│  │    • Read, Write, Edit, Glob, Grep (file operations)           │   │
│  │    • WebSearch, WebFetch (internet access)                     │   │
│  │    • agent-browser (browser automation)                        │   │
│  │    • mcp__nanogem__* (scheduler tools via IPC)                │   │
│  │                                                                │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Messaging Channel | Node.js (discord.js) | Connect to Discord, send/receive messages |
| Message Storage | SQLite (better-sqlite3) | Store messages for polling and history |
| Agent Runtime | Kubernetes | Native pods for isolated agent execution |
| Agent | Gemini API | Run Gemini with tools and functions |
| Browser Automation | agent-browser + Chromium | Web interaction and screenshots |
| Runtime | Node.js 20+ | Host process for routing and scheduling |

---

## Folder Structure

```
nanogem/
├── GEMINI.md                      # Project context for Gemini CLI
├── docs/
│   ├── SPEC.md                    # This specification document
│   ├── REQUIREMENTS.md            # Architecture decisions
│   └── SECURITY.md                # Security model
├── README.md                      # User documentation
├── package.json                   # Node.js dependencies
├── tsconfig.json                  # TypeScript configuration
├── .mcp.json                      # MCP server configuration (reference)
├── .gitignore
│
├── src/
│   ├── index.ts                   # Orchestrator: state, message loop, agent invocation
│   ├── channels/
│   │   └── discord.ts             # Discord connection, auth, send/receive
│   ├── ipc.ts                     # IPC watcher and task processing
│   ├── router.ts                  # Message formatting and outbound routing
│   ├── config.ts                  # Configuration constants
│   ├── types.ts                   # TypeScript interfaces
│   ├── logger.ts                  # Pino logger setup
│   ├── db.ts                      # SQLite database initialization and queries
│   ├── group-queue.ts             # Per-group queue
│   ├── mount-security.ts          # Mount allowlist validation
│   ├── task-scheduler.ts          # Runs scheduled tasks when due
│   ├── k8s-runtime.ts             # Native Kubernetes pod management
│   └── container-runner.ts        # Spawns agent pods
│
├── container/
│   ├── Dockerfile                 # Image definition for agents
│   ├── agent-runner/              # Code that runs inside the pod
│   │   ├── src/
│   │   │   ├── index.ts           # Agent entry point (Slim Orchestrator)
│   │   │   └── modules/           # Modular logic components
│   │   │       ├── gemini.ts      # Core LLM interaction
│   │   │       ├── memory.ts      # Cognitive memory management
│   │   │       ├── tools.ts       # Tool definitions & functions
│   │   │       ├── mcp.ts         # Model Context Protocol manager
│   │   │       └── types.ts       # Shared module types
│   └── skills/
│       └── agent-browser.md       # Browser automation skill
│
├── groups/
│   ├── GEMINI.md                  # Global memory
│   ├── main/                      # Main control channel
│   └── {Group Name}/              # Per-group folders
│
├── store/                         # Local data (SQLite)
├── data/                          # Application state (Sessions, IPC)
├── logs/                          # Runtime logs
└── registry.yaml                  # Kubernetes registry config
```

---

## Configuration

Configuration constants are in `src/config.ts`:

```typescript
export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'NanoGem';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Memory System (2026 SOTA)
export const MEMORY_DIR_NAME = '.nanogem/memory';
export const CONTINUUM_DIR_NAME = 'continuum';
export const EPISODES_DIR_NAME = 'episodes';

// Container/Pod configuration
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || 'nanogem-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Kubernetes specifics
export const K8S_NAMESPACE = process.env.K8S_NAMESPACE || 'nanogem';
export const K8S_PVC_NAME = process.env.K8S_PVC_NAME || 'nanogem-pvc-final';
```

---

## Memory System (2026 SOTA)

NanoGem implements a tiered cognitive memory architecture to maintain focus and long-term coherence.

| Tier | File Path | Type | Managed By | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **Identity** | `GEMINI.md` | Fixed | User | Core persona and permanent rules. |
| **Continuum** | `continuum/facts.md` | Mutable | Agent | Current distilled facts and truths. |
| **Continuum** | `continuum/workflows.md` | Mutable | Agent | Verified procedural steps for complex tasks. |
| **Episodic** | `episodes/*.md` | Archive | System | Summaries of every completed mission. |
| **Working** | `history.json` | Volatile | LLM | Verbatim recent message history. |

### Tool-Based Retrieval
The agent uses the `recall_memory(category)` tool to lazily load full fact-sheets or historical episodes into its context, keeping the initial prompt small and fast.

---

## Message Flow

### Incoming Message Flow

```
1. User sends message via Discord (mention or DM)
   │
   ▼
2. discord.js receives message
   │
   ▼
3. Message stored in SQLite (store/messages.db)
   │
   ▼
4. Message loop polls SQLite (every 2 seconds)
   │
   ▼
5. Router checks registration and trigger
   │
   ▼
6. Router builds prompt with Identity + Memory Snippets
   │
   ▼
7. Router invokes Gemini Agent:
   ├── Spawns Kubernetes pod
   ├── cwd: groups/{group-name}/ (via PVC subpath)
   └── Watchers: K8s API + fs.watch(IPC)
   │
   ▼
8. Gemini processes message using modular tools
   │
   ▼
9. Agent writes exit-{ts}.json sentinel to IPC
   │
   ▼
10. Orchestrator detects sentinel instantly, resets queue
```

---

## Security Considerations

### Pod Isolation

All agents run inside isolated Kubernetes pods:
- **Filesystem isolation**: Agents only see directories mounted from the shared PVC.
- **Safe Bash access**: Commands run inside the pod sandbox.
- **Non-root user**: Pod processes run as unprivileged `node` user.

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| No response | Pod not running | Check `kubectl get pods -n nanogem` |
| Agent failed | Cluster unreachable | Ensure Kubeconfig is valid and API is up |
| "Unauthorized" | Group not registered | Register the channel from main |

### Log Location

- `logs/nanogem.log` - Host stdout
- `logs/nanogem.error.log` - Host stderr
