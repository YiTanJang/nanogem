<p align="center">
  <img src="assets/nanogem-logo.svg" alt="NanoGem" width="400">
</p>

<p align="center">
  <b>NanoGem: The Kubernetes-Native Agent Swarm</b><br>
  A 2026 SOTA private AI assistant focused on hard isolation, structured memory, and hierarchical orchestration.
</p>

---

## 🧬 The Philosophy

NanoGem is not a "chatbot." It is an **Agent Operating System** built for users who demand absolute security and structured intelligence. Unlike frameworks that run agents in a single process, NanoGem treats every agent as a first-class citizen in your Kubernetes cluster.

### Core Pillars
- **Hard Isolation**: Every agent lives in its own Kubernetes Pod. They see only what you mount.
- **Cognitive Memory**: Built on 2026 research—memory is a mutable continuum of facts and workflows, not just a random text log.
- **Hierarchical Orchestration**: A "Manager-Worker" protocol inspired by CrewAI, but optimized for secure, asynchronous execution.
- **Discord-First**: Your private Discord server is the control room.

---

## ✨ Features

- **Messenger I/O**: Full control via Discord mentions and DMs.
- **Role-Based Swarms**: Spawn specialized agents (e.g., `Researcher`, `Coder`, `SRE`) with deep backstories and specific goals.
- **Continuum Memory**: Agents maintain persistent `facts.md` and `workflows.md` that they actively refine using the `update_memory` tool.
- **Mission Protocol**: Delegate complex tasks with `delegate_task(task, expected_output)`.
- **Kaniko Auto-Evolution**: The system can recompile its own source code and rollout updates to the cluster via internal build jobs.
- **Browser Automation**: Integrated `agent-browser` with Chromium for live web interaction.

---

## 🚀 Getting Started

### Prerequisites
- A Kubernetes cluster (K3s, EKS, or a NAS-based cluster).
- **A Container Registry**: NanoGem builds and spawns agents as pods. You must have a registry (e.g., Docker Hub, GitHub Packages, or a local registry) that your cluster can reach.
- A Discord Bot Token.
- A Gemini API Key.

### Registry Configuration
During the setup process, you will be asked for your **Registry URL**.
- If using a local NAS registry, use the format: `IP_ADDRESS:PORT` (e.g., `192.168.1.100:5000`).
- Ensure your Kubernetes nodes are configured to trust this registry if it is insecure.

### Installation
1. **Clone the repo**:
   ```bash
   git clone https://github.com/YiTanJang/nanoclaw.git
   cd nanoclaw
   ```

2. **Bootstrap the environment**:
   ```bash
   ./setup.sh
   ```

3. **Run the interactive setup**:
   ```bash
   npm run setup
   ```
   *This will guide you through creating secrets, configuring storage (NFS/HostPath), and deploying the orchestrator to your cluster.*

---

## 🧠 Memory Structure (2026 SOTA)

NanoGem uses a tiered memory system to maintain high focus:
1. **Working Memory**: Current chat history + active mission.
2. **Episodic Memory**: The last 5 mission reports (`episodes/`).
3. **Semantic Memory**: Distilled permanent truths (`facts.md`).
4. **Procedural Memory**: Verified "how-to" guides (`workflows.md`).

---

## 🛠 Customizing

NanoGem follows the **"Code is Config"** mantra. Want to change how the agent thinks? Edit the instructions in `groups/global/GEMINI.md`. Want to add a new tool? Modify `container/agent-runner/src/index.ts` and call `rebuild_self()`.

---

## 🛡 Security

NanoGem uses a **Defense-in-Depth** model:
- **Sandbox**: Agents cannot escape their Kubernetes Pod.
- **Mounts**: Only explicitly allowed directories are visible to agents.
- **Filter**: Sensitive environment variables are never exposed to sub-agents.

---

## 🤝 Contributing

**Don't add features. Add skills.**
If you want to add a new capability, contribute a skill file in `.gemini/skills/`. We value clean, modular code that respects the core isolation model.

## 📜 License

MIT
