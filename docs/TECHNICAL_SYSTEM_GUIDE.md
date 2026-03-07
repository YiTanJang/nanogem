# NanoGem Technical System Guide (For Autonomous Agents)

This document provides the necessary architectural details for Andy to understand and improve himself.

## 1. IPC (Inter-Process Communication) Protocol

The host orchestrator watches the directory `/workspace/project/data/ipc/` for task files.

### Triggering a Task
To wake up an agent or perform a management action, write a JSON file to `/workspace/project/data/ipc/{group-folder}/tasks/`.

**Format:**
```json
{
  "type": "schedule_task",
  "prompt": "The prompt to execute",
  "schedule_type": "once",
  "schedule_value": "now"
}
```

### Supported IPC Task Types (in `src/ipc.ts`):
- `write_mission`: Assigns a structured mission to an agent's brain.
- `delegate_task`: Spawns a sub-agent with a formal mission and expected output.
- `submit_work`: Reports a completed mission back to the manager.
- `register_group`: Creates a new specialized agent group.
- `delete_group`: Deletes an agent group and its files.
- `create_discord_thread`: Creates a physical thread on Discord for a sub-agent.
- `rebuild_self`: Triggers a Kaniko job to recompile the system.
- `build_project`: Builds a project image from a specific sub-folder.

## 2. Database Schema (`store/messages.db`)

Andy can query the database using the `bash` tool and `sqlite3`.

### Key Tables:
- `messages`: All captured Discord messages.
- `registered_groups`: Configuration for all autonomous groups.
- `scheduled_tasks`: All background tasks and their status.
- `router_state`: Cursor positions (`last_timestamp`) for the message loop.

## 3. Agent Runner Architecture

The Agent Runner is a modular TypeScript application located at `/workspace/project/container/agent-runner/src/`.

### Core Modules:
- `modules/gemini.ts`: LLM interaction and multimodal parsing.
- `modules/memory.ts`: Tiered 2026 SOTA memory (Continuum/Episodes).
- `modules/tools.ts`: Implementation of 24+ system and swarm tools.
- `modules/mcp.ts`: Model Context Protocol management.

### Adding a New Tool:
1.  **Define Implementation**: Add a function to the `getFunctions` object in `modules/tools.ts`.
2.  **Define Declaration**: Add the JSON schema to the `toolDeclarations` array in `modules/tools.ts`.
3.  **Build**: Run `cd /workspace/project/container/agent-runner && npm run build`.
4.  **Evolve**: Call `rebuild_self()` from the Head Manager to rollout the new build.

## 4. Writable Paths for Self-Improvement
Andy is authorized to use `edit_file` on these paths:
- `/workspace/project/src/*.ts` (Orchestrator logic)
- `/workspace/project/container/agent-runner/src/*.ts` (Runner logic)
- `/workspace/project/groups/main/.nanogem/memory/` (Personal memory)
- `/workspace/project/groups/global/` (Global protocols)
