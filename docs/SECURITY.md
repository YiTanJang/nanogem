# NanoGem Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private Discord channel, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Container agents | Sandboxed | Isolated execution environment |
| Discord messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Pod Isolation (Primary Boundary)

Agents execute in isolated Kubernetes Pods, providing:
- **Process isolation** - Container namespaces prevent agents from seeing the host or other pods.
- **Filesystem isolation** - Only explicitly mounted sub-paths from the shared PVC are visible.
- **Non-root execution** - All processes run as the unprivileged `node` user (UID 1000).
- **Ephemeral environments** - Pods are deleted after their mission, ensuring no local state persistence beyond the mounted volumes.

### 2. Mount Security

**External Allowlist** - Mount permissions are validated against a local allowlist at `~/.config/nanogem/mount-allowlist.json`.
- **Atomic Resolution**: Symlinks are resolved before validation to prevent traversal attacks.
- **Path Stripping**: Agents cannot use `..` or absolute paths to reach outside their assigned mounts.
- **Selective Write**: The project source code is mounted READ-ONLY for all agents, except the Head Manager which has selective WRITE access for self-evolution.

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Path validation (rejects `..` and absolute paths)
- `nonMainReadOnly` option forces read-only for non-main groups

**Read-Only Project Root:**

The main group's project root is mounted read-only. Writable paths the agent needs (group folder, IPC, `.gemini/`) are mounted separately. This prevents the agent from modifying host application code (`src/`, `dist/`, `package.json`, etc.) which would bypass the sandbox entirely on next restart.

### 3. Session & Memory Isolation

Each agent has an isolated memory directory at `/workspace/group/.nanogem/memory/`.
- **Continuum Isolation**: Agents cannot modify the `facts.md` or `workflows.md` of other agents.
- **Episodic Privacy**: Episode summaries are private to the agent's folder unless explicitly reported via `submit_work`.

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Head Manager (Main) | Specialist Agent |
|-----------|---------------------|------------------|
| Create Discord Thread | ✓ | ✗ |
| Register New Group | ✓ | ✗ |
| System Rebuild/Evolution | ✓ | ✗ |
| Delegate Structured Task | ✓ | ✓ |
| Submit Work (Report) | ✓ | ✓ |
| View All Tasks | ✓ | Own only |
| Update Global Memory | ✓ | ✗ |

### 5. Credential Handling

**Mounted Credentials:**
- Gemini API keys (filtered from `.env` or K8s secrets, read-only)

**NOT Mounted:**
- Discord tokens - host only
- Mount allowlist - external, never mounted
- Any credentials matching blocked patterns

**Credential Filtering:**
Only these environment variables are exposed to containers:
```typescript
const allowedVars = ['GEMINI_API_KEY'];
```

## Privilege Comparison

| Capability | Head Manager (Main) | Specialist Agent |
|------------|------------|----------------|
| Project source access | READ-WRITE (selective) | READ-ONLY |
| System Evolution | Authorized (rebuild_self) | Unauthorized |
| Swarm Management | Authorized (register/delete) | Unauthorized |
| Global Memory | READ-WRITE | READ-ONLY |
| Private Memory | READ-WRITE | READ-WRITE |
| Web/Tool Access | Full | Full |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  Discord Messages (potentially malicious)                          │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing & GroupQueue                                   │
│  • IPC authorization & Mission validation                         │
│  • Mount validation (external allowlist)                          │
│  • Kubernetes Pod lifecycle & Watch API                           │
│  • Credential filtering                                           │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only
┌──────────────────────────────────────────────────────────────────┐
│                AGENT POD (ISOLATED/SANDBOXED)                     │
│  • Modular Agent Runner execution                                 │
│  • Bash commands (sandboxed in Linux namespace)                   │
│  • File operations (limited to PVC sub-paths)                     │
│  • Tiered Cognitive Memory (Continuum/Episodes)                  │
│  • Network access (unrestricted)                                  │
└──────────────────────────────────────────────────────────────────┘
```
