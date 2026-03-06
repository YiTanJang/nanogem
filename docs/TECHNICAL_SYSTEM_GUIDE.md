# NanoClaw Technical System Guide (For Autonomous Agents)

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
- `register_group`: Creates a new group. Requires `jid`, `name`, `folder`, `trigger`.
- `delete_group`: Deletes a group. Requires `jid`.
- `rebuild_self`: Rebuilds the container image.
- `refresh_groups`: Syncs available groups from WhatsApp.

## 2. Database Schema (`store/messages.db`)

Andy can query the database using the `bash` tool and `sqlite3`.

### Key Tables:
- `messages`: All captured WhatsApp messages.
- `registered_groups`: Configuration for all autonomous groups.
- `scheduled_tasks`: All background tasks and their status.
- `router_state`: Cursor positions (`last_timestamp`) for the message loop.

## 3. Agent Runner Architecture

The code that handles your tools and Gemini interaction is located at:
`/workspace/project/container/agent-runner/src/index.ts`

### Adding a New Tool:
1.  **Define Implementation**: Add a function to the `getFunctions` object.
2.  **Define Declaration**: Add the JSON schema to the `toolDeclarations` array.
3.  **Deploy**: Run `cd /workspace/project/container/agent-runner && npm run build`.
4.  **Evolve**: Call `rebuild_self()` to restart the system with the new tool.

## 4. Writable Paths for Self-Improvement
Andy is authorized to use `edit_file` on these paths:
- `/workspace/project/src/*.ts` (Orchestrator logic)
- `/workspace/project/container/agent-runner/src/*.ts` (Runner logic)
- `/workspace/project/groups/main/GEMINI.md` (Personal memory)
