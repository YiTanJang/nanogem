# NanoClaw Specification

A personal Gemini assistant accessible via Discord, with persistent memory per conversation, scheduled tasks, and containerized agent execution.

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
│                       │ spawns container/pod                         │
│                       ▼                                              │
├─────────────────────────────────────────────────────────────────────┤
│                CONTAINER / KUBERNETES POD                            │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    AGENT RUNNER                               │   │
│  │                                                                │   │
│  │  Working directory: /workspace/group (mounted from host)       │   │
│  │  Volume mounts:                                                │   │
│  │    • groups/{name}/ → /workspace/group                         │   │
│  │    • groups/global/ → /workspace/global/ (non-main only)        │   │
│  │    • data/sessions/{group}/.gemini/ → /home/node/.gemini/      │   │
│  │    • Additional dirs → /workspace/extra/*                      │   │
│  │                                                                │   │
│  │  Tools (all groups):                                           │   │
│  │    • Bash (safe - sandboxed in container!)                     │   │
│  │    • Read, Write, Edit, Glob, Grep (file operations)           │   │
│  │    • WebSearch, WebFetch (internet access)                     │   │
│  │    • agent-browser (browser automation)                        │   │
│  │    • mcp__nanoclaw__* (scheduler tools via IPC)                │   │
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
| Container Runtime | Docker / Kubernetes | Isolated environments for agent execution |
| Agent | Gemini API | Run Gemini with tools and functions |
| Browser Automation | agent-browser + Chromium | Web interaction and screenshots |
| Runtime | Node.js 20+ | Host process for routing and scheduling |

---

## Folder Structure

```
nanoclaw/
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
│   ├── types.ts                   # TypeScript interfaces (includes Channel)
│   ├── logger.ts                  # Pino logger setup
│   ├── db.ts                      # SQLite database initialization and queries
│   ├── group-queue.ts             # Per-group queue with global concurrency limit
│   ├── mount-security.ts          # Mount allowlist validation for containers
│   ├── task-scheduler.ts          # Runs scheduled tasks when due
│   ├── k8s-runtime.ts             # Native Kubernetes pod management
│   └── container-runner.ts        # Spawns agents in containers/pods
│
├── container/
│   ├── Dockerfile                 # Container image (runs as 'node' user)
│   ├── build.sh                   # Build script for container image
│   ├── agent-runner/              # Code that runs inside the container
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts           # Entry point (query loop, IPC polling, session resume)
│   │       └── ipc-mcp-stdio.ts   # Stdio-based MCP server for host communication
│   └── skills/
│       └── agent-browser.md       # Browser automation skill
│
├── dist/                          # Compiled JavaScript (gitignored)
│
├── .gemini/
│   └── skills/
│       ├── customize/SKILL.md          # /customize - Add capabilities
│       ├── debug/SKILL.md              # /debug - Container debugging
│       ├── add-telegram/SKILL.md       # /add-telegram - Telegram channel
│       ├── add-gmail/SKILL.md          # /add-gmail - Gmail integration
│       ├── add-voice-transcription/    # /add-voice-transcription - Whisper
│       ├── x-integration/SKILL.md      # /x-integration - X/Twitter
│       └── add-parallel/SKILL.md       # /add-parallel - Parallel agents
│
├── groups/
│   ├── GEMINI.md                  # Global memory (all groups read this)
│   ├── main/                      # Main control channel folder
│   │   ├── GEMINI.md              # Main channel memory
│   │   └── logs/                  # Task execution logs
│   └── {Group Name}/              # Per-group folders (created on registration)
│       ├── GEMINI.md              # Group-specific memory
│       ├── logs/                  # Task logs for this group
│       └── *.md                   # Files created by the agent
│
├── store/                         # Local data (gitignored)
│   └── messages.db                # SQLite database (messages, chats, scheduled_tasks, task_run_logs, registered_groups, sessions, router_state)
│
├── data/                          # Application state (gitignored)
│   ├── sessions/                  # Per-group session data (.gemini/ dirs with JSON transcripts)
│   ├── env/env                    # Copy of .env for container mounting
│   └── ipc/                       # Container IPC (messages/, tasks/)
│
├── logs/                          # Runtime logs (gitignored)
│   ├── nanoclaw.log               # Host stdout
│   └── nanoclaw.error.log         # Host stderr
│
└── registry.yaml                  # Kubernetes registry config
```

---

## Configuration

Configuration constants are in `src/config.ts`:

```typescript
import path from 'path';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'NanoClaw';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Paths are absolute (required for container mounts)
const PROJECT_ROOT = process.cwd();
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// Container configuration
export const CONTAINER_RUNTIME = process.env.CONTAINER_RUNTIME || 'docker'; // 'docker' or 'k8s'
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
export const MAX_CONCURRENT_CONTAINERS = parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10);

export const TRIGGER_PATTERN = new RegExp(`^@${ASSISTANT_NAME}\\b`, 'i');
```

### Container Configuration

Groups can have additional directories mounted via `containerConfig` in the SQLite `registered_groups` table. Example registration:

```typescript
registerGroup("discord-123456789", {
  name: "Project Alpha",
  folder: "project-alpha",
  trigger: "@NanoClaw",
  added_at: new Date().toISOString(),
  containerConfig: {
    additionalMounts: [
      {
        hostPath: "/path/to/project",
        containerPath: "project",
        readonly: false,
      },
    ],
  },
});
```

---

## Memory System

NanoClaw uses a hierarchical memory system based on GEMINI.md files.

### Memory Hierarchy

| Level | Location | Read By | Written By | Purpose |
|-------|----------|---------|------------|---------|
| **Global** | `groups/GEMINI.md` | All groups | Main only | Preferences, context shared across all conversations |
| **Group** | `groups/{name}/GEMINI.md` | That group | That group | Group-specific context, conversation memory |
| **Files** | `groups/{name}/*.md` | That group | That group | Notes, research, documents created during conversation |

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
5. Router checks:
   ├── Is channel registered? → No: ignore
   └── Is it a trigger message? → No: store only
   │
   ▼
6. Router catches up conversation:
   ├── Fetch all messages since last agent interaction
   └── Build prompt with full conversation context
   │
   ▼
7. Router invokes Gemini Agent:
   ├── Spawns container or K8s pod
   ├── cwd: groups/{group-name}/
   └── resume: session history
   │
   ▼
8. Gemini processes message using tools
   │
   ▼
9. Router sends response back to Discord channel
   │
   ▼
10. Update last agent timestamp and save session
```

---

## Commands

### Commands Available in Main Channel Only

| Command | Example | Effect |
|---------|---------|--------|
| `@Assistant add group "Name"` | `@Andy add group "Work Team"` | Register a new channel |
| `@Assistant remove group "Name"` | `@Andy remove group "Old Project"` | Unregister a channel |
| `@Assistant list groups` | `@Andy list groups` | Show registered groups |
| `@Assistant remember [fact]` | `@Andy remember I prefer Node.js` | Add to global memory |

---

## Security Considerations

### Container Isolation

All agents run inside isolated containers or pods:
- **Filesystem isolation**: Agents only see mounted directories.
- **Safe Bash access**: Commands run inside the sandbox, not on the host.
- **Non-root user**: Container processes run as unprivileged `node` user.

### Prompt Injection Risk

Discord messages could contain malicious instructions attempting to manipulate Gemini's behavior. Mitigation includes container isolation, required trigger words, and explicit group registration.

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| No response | Pod not running | Check `kubectl get pods -n nanoclaw` |
| Container failed | Runtime missing | Ensure Kubernetes cluster is running |
| "Unauthorized" | Group not registered | Register the channel from main |

### Log Location

- `logs/nanoclaw.log` - Host stdout
- `logs/nanoclaw.error.log` - Host stderr
