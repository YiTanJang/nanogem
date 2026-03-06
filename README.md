<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  A Gemini 1:1 rewrite of NanoClaw. An AI assistant that runs agents securely in their own containers, now with native Kubernetes support. Lightweight, built to be easily understood and completely customized for your needs.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

Using Gemini CLI, NanoClaw can dynamically rewrite its code to customize its feature set for your needs. This version is a full 1:1 rewrite optimized for the Gemini API and adds support for Kubernetes clusters.

**New:** First AI assistant to support [Agent Swarms](https://ai.google.dev/gemini-api/docs/agents). Spin up teams of agents that collaborate in your chat.

## Why I Built NanoClaw

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project, but I wouldn't have been able to sleep if I had given complex software I didn't understand full access to my life. OpenClaw has nearly half a million lines of code, 53 config files, and 70+ dependencies. Its security is at the application level (allowlists, pairing codes) rather than true OS-level isolation. Everything runs in one Node process with shared memory.

NanoClaw provides that same core functionality, but in a codebase small enough to understand: one process and a handful of files. Gemini agents run in their own Linux containers with filesystem isolation, not merely behind permission checks. This repository is a clean-slate, 1:1 rewrite designed specifically for the Gemini ecosystem, adding modern features like Kubernetes orchestration.

## Quick Start

```bash
git clone https://github.com/YiTanJang/nanoclaw.git
cd nanoclaw
gemini
```

Then run `/setup`. Gemini CLI handles everything: dependencies, authentication, container setup (Docker or K8s) and service configuration.

## Philosophy

**Small enough to understand.** One process, a few source files and no microservices. If you want to understand the full NanoClaw codebase, just ask Gemini CLI to walk you through it.

**Secure by isolation.** Agents run in Linux containers (Apple Container on macOS, Docker, or Kubernetes) and they can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for the individual user.** NanoClaw isn't a monolithic framework; it's software that fits each user's exact needs. Instead of becoming bloatware, NanoClaw is designed to be bespoke. You make your own fork and have Gemini CLI modify it to match your needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that it's safe to make changes.

**AI-native.**
- No installation wizard; Gemini CLI guides setup.
- No monitoring dashboard; ask Gemini what's happening.
- No debugging tools; describe the problem and Gemini fixes it.

**Skills over features.** Instead of adding features (e.g. support for Telegram) to the codebase, contributors submit [Gemini CLI skills](.gemini/skills) like `/add-telegram` that transform your fork. You end up with clean code that does exactly what you need.

**Best harness, best model.** NanoClaw runs on the Gemini API, which means you're running Gemini directly. Gemini is highly capable and its coding and problem-solving capabilities allow it to modify and expand NanoClaw and tailor it to each user.

## What It Supports

- **Messenger I/O** - Message NanoClaw from your phone. Supports WhatsApp, Telegram, Discord, Slack, Signal and headless operation.
- **Isolated group context** - Each group has its own `GEMINI.md` memory, isolated filesystem, and runs in its own container sandbox with only that filesystem mounted to it.
- **Main channel** - Your private channel (self-chat) for admin control; every group is completely isolated
- **Scheduled tasks** - Recurring jobs that run Gemini and can message you back
- **Web access** - Search and fetch content from the Web
- **Container isolation** - Agents are sandboxed in Apple Container (macOS), Docker (macOS/Linux), or Kubernetes
- **Agent Swarms** - Spin up teams of specialized agents that collaborate on complex tasks. NanoClaw is the first personal AI assistant to support agent swarms.
- **Optional integrations** - Add Gmail (`/add-gmail`) and more via skills

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From the main channel (your self-chat), you can manage groups and tasks:
```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Customizing

NanoClaw doesn't use configuration files. To make changes, just tell Gemini CLI what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that Gemini can safely modify it.

## Contributing

**Don't add features. Add skills.**

If you want to add Telegram support, don't create a PR that adds Telegram alongside WhatsApp. Instead, contribute a skill file (`.gemini/skills/add-telegram/SKILL.md`) that teaches Gemini CLI how to transform a NanoClaw installation to use Telegram.

Users then run `/add-telegram` on their fork and get clean code that does exactly what they need, not a bloated system trying to support every use case.

### RFS (Request for Skills)

Skills we'd like to see:

**Communication Channels**
- `/add-slack` - Add Slack

**Session Management**
- `/clear` - Add a `/clear` command that compacts the conversation (summarizes context while preserving critical information in the same session). Requires figuring out how to trigger compaction programmatically via the Gemini API.

## Requirements

- macOS or Linux
- Node.js 20+
- [Gemini CLI](https://ai.google.dev/gemini-api/docs/gemini-cli)
- [Apple Container](https://github.com/apple/container) (macOS), [Docker](https://docker.com/products/docker-desktop) (macOS/Linux), or [Kubernetes](https://kubernetes.io/)

## Architecture

```
WhatsApp (baileys) --> SQLite --> Polling loop --> Container/Pod (Gemini API) --> Response
```

Single Node.js process. Agents execute in isolated Linux containers or Kubernetes pods with filesystem isolation. Only mounted directories are accessible. Per-group message queue with concurrency control. IPC via filesystem.

Key files:
- `src/index.ts` - Orchestrator: state, message loop, agent invocation
- `src/channels/whatsapp.ts` - WhatsApp connection, auth, send/receive
- `src/ipc.ts` - IPC watcher and task processing
- `src/router.ts` - Message formatting and outbound routing
- `src/group-queue.ts` - Per-group queue with global concurrency limit
- `src/container-runner.ts` - Spawns streaming agent containers or pods
- `src/task-scheduler.ts` - Runs scheduled tasks
- `src/db.ts` - SQLite operations (messages, groups, sessions, state)
- `groups/*/GEMINI.md` - Per-group memory

## FAQ

**Why Docker?**

> Docker provides cross-platform support (macOS, Linux and even Windows via WSL2) and a mature ecosystem. On macOS, you can optionally switch to Apple Container via `/convert-to-apple-container` for a lighter-weight native runtime. If you have a cluster, you can also run agents as Kubernetes pods. To select the runtime, set the `CONTAINER_RUNTIME` environment variable to `docker` (default) or `k8s`. The `apple-container` runtime is configured by a skill and does not require this variable.

**Can I run this on Linux?**

Yes. Docker is the default runtime and works on both macOS and Linux. Kubernetes is also supported on Linux. Just run `/setup`.

**Is this secure?**

Agents run in containers or pods, not behind application-level permission checks. They can only access explicitly mounted directories. You should still review what you're running, but the codebase is small enough that you actually can. See [docs/SECURITY.md](docs/SECURITY.md) for the full security model.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize NanoClaw so that the code does exactly what they want, rather than configuring a generic system. If you prefer having config files, you can tell Gemini to add them.

**How do I debug issues?**

Ask Gemini CLI. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach that underlies NanoClaw.

**Why isn't the setup working for me?**

If you have issues, during setup, Gemini will try to dynamically fix them. If that doesn't work, run `gemini`, then run `/debug`. If Gemini finds an issue that is likely affecting other users, open a PR to modify the setup SKILL.md.

**What changes will be accepted into the codebase?**

Only security fixes, bug fixes, and clear improvements will be accepted to the base configuration. That's all.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills.

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## License

MIT
