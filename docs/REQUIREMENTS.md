# NanoGem Requirements

Original requirements and design decisions from the project creator.

---

## Why This Exists

This is a lightweight, secure alternative to OpenClaw (formerly ClawBot). That project became a monstrosity - 4-5 different processes running different gateways, endless configuration files, endless integrations. It's a security nightmare where agents don't run in isolated processes; there's all kinds of leaky workarounds trying to prevent them from accessing parts of the system they shouldn't. It's impossible for anyone to realistically understand the whole codebase. When you run it you're kind of just yoloing it.

NanoGem gives you the core functionality without that mess.

---

## Philosophy

### Small Enough to Understand

The entire codebase should be something you can read and understand. One Node.js process. A handful of source files. No microservices, no message queues, no abstraction layers.

### Security Through True Isolation

Instead of application-level permission systems trying to prevent agents from accessing things, agents run in actual Linux containers. The isolation is at the OS level. Agents can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

### Built for One User

This isn't a framework or a platform. It's working software for my specific needs. I use Discord and Email, so it supports Discord and Email. I don't use Telegram, so it doesn't support Telegram. I add the integrations I actually want, not every possible integration.

### Customization = Code Changes

No configuration sprawl. If you want different behavior, modify the code. The codebase is small enough that this is safe and practical. Very minimal things like the trigger word are in config. Everything else - just change the code to do what you want.

### AI-Native Development

I don't need an installation wizard - Gemini CLI guides the setup. I don't need a monitoring dashboard - I ask Gemini what's happening. I don't need elaborate logging UIs - I ask Gemini to read the logs. I don't need debugging tools - I describe the problem and Gemini fixes it.

The codebase assumes you have an AI collaborator. It doesn't need to be excessively self-documenting or self-debugging because Gemini is always there.

### Skills Over Features

When people contribute, they shouldn't add "Telegram support alongside Discord." They should contribute a skill like `/add-telegram` that transforms the codebase. Users fork the repo, run skills to customize, and end up with clean code that does exactly what they need - not a bloated system trying to support everyone's use case simultaneously.

---

## RFS (Request for Skills)

Skills we'd like contributors to build:

### Communication Channels
Skills to add or switch to different messaging platforms:
- `/add-telegram` - Add Telegram as an input channel
- `/add-slack` - Add Slack as an input channel
- `/add-sms` - Add SMS via Twilio or similar
- `/convert-to-telegram` - Replace Discord with Telegram entirely

### Container Runtime
The project uses Docker by default (cross-platform). For macOS users who prefer Apple Container:
- `/convert-to-apple-container` - Switch from Docker to Apple Container (macOS-only)

### Platform Support
- `/setup-linux` - Make the full setup work on Linux (depends on Docker conversion)
- `/setup-windows` - Windows support via WSL2 + Docker

---

## Vision

A personal Gemini assistant swarm accessible via Discord, featuring hierarchical orchestration and SOTA cognitive memory.

**Core components:**
- **Gemini API** as the core agent (via Unified SDK)
- **Kubernetes Pods** for hard-isolated agent execution (Linux VMs)
- **Discord** as the primary I/O channel
- **Cognitive Memory** (Continuum + Episodic) for long-term coherence
- **Mission Protocol** for structured delegation between agents
- **Scheduled tasks** that run Gemini and can message back
- **Kaniko** for cluster-native self-evolution

---

## Architecture Decisions

### Message Routing
- A router listens to Discord and routes messages to the GroupQueue.
- Only messages from registered groups/channels are processed.
- Trigger: `@NanoGem` prefix (case insensitive), configurable via `ASSISTANT_NAME`.

### Cognitive Memory System (2026 SOTA)
- **Decoupled Knowledge**: Each agent maintains a `continuum/` of mutable facts and workflows.
- **Episodic Recall**: Past missions are automatically summarized into `episodes/`.
- **Lazy Loading**: Only essential snippets are loaded into the prompt by default; full memory is retrieved via the `recall_memory` tool.

### Hierarchical Orchestration (Swarm)
- **Manager-Worker Protocol**: Agents use the `delegate_task` tool to assign formal missions.
- **Reporting**: Workers use the `submit_work` tool to report results back to the assigner.
- **Isolation**: Sub-agents run in their own ephemeral pods with private memory and workspace folders.

### Pod Isolation & Lifecycle
- Every agent invocation spawns a native Kubernetes Pod.
- **Filesystem-based Exit**: The orchestrator uses `fs.watch` on the IPC folder to detect an agent's `exit` sentinel instantly, resetting the queue without waiting for slow K8s API updates.
- **Max Pod Life**: 30-minute hard limit to prevent infinite loops.

### Main Channel Privileges
- The Main channel acts as the Head Manager.
- Can write to global memory and project source code.
- Can rollout system updates via `rebuild_self`.
- Can manage all registered groups and global task schedules.

---

## Integration Points

### Discord
- Using discord.js library for connection
- Messages stored in SQLite, polled by router
- Token-based authentication

### Scheduler
- Built-in scheduler runs on the host, spawns containers for task execution
- Custom `nanogem` MCP server (inside container) provides scheduling tools
- Tools: `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `send_message`
- Tasks stored in SQLite with run history
- Scheduler loop checks for due tasks every minute
- Tasks execute Gemini API in containerized group context

### Web Access
- Built-in WebSearch and WebFetch tools
- Standard Gemini API capabilities

### Browser Automation
- agent-browser CLI with Chromium in container
- Snapshot-based interaction with element references (@e1, @e2, etc.)
- Screenshots, PDFs, video recording
- Authentication state persistence

---

## Setup & Customization

### Philosophy
- Minimal configuration files
- Setup and customization done via Gemini CLI
- Users clone the repo and run Gemini CLI to configure
- Each user gets a custom setup matching their exact needs

### Skills
- `/customize` - General-purpose skill for adding capabilities (new channels like Telegram, new integrations, behavior changes)
- `/update` - Pull upstream changes, merge with customizations, run migrations

### Deployment
- Runs on local machine
- Single Node.js process handles everything

---

## Personal Configuration (Reference)

These are the creator's settings, stored here for reference:

- **Trigger**: `@Andy` (case insensitive)
- **Response prefix**: `Andy:`
- **Persona**: Default Gemini (no custom personality)
- **Main channel**: Private Discord channel (direct message or dedicated channel)

---

## Project Name

**NanoGem**
