import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { 
  IPC_MESSAGES_DIR, 
  TASKS_DIR, 
  ContainerInput 
} from './types.js';
import { updateMemory, recallMemory } from './memory.js';

export function writeIpcFile(dir: string, data: object): void {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

/**
 * ADK Pattern: Tools are defined as Zod schemas first.
 */
export const Tools = {
  bash: {
    description: 'Execute a bash command in the isolated pod environment.',
    schema: z.object({
      command: z.string().describe('The command to execute'),
    }),
    fn: (args: any) => {
      try {
        const output = execSync(args.command, { encoding: 'utf-8', timeout: 30000 });
        return output || 'Success (no output).';
      } catch (err: any) {
        return `Error: ${err.message}\n${err.stderr || ''}`;
      }
    }
  },
  read_file: {
    description: 'Read the contents of a file in the workspace.',
    schema: z.object({
      path: z.string().describe('Path relative to /workspace/group'),
    }),
    fn: (args: any) => {
      try {
        const fullPath = path.isAbsolute(args.path) ? args.path : path.resolve('/workspace/group', args.path);
        if (!fullPath.startsWith('/workspace/group') && !fullPath.startsWith('/workspace/project'))
          return 'Error: Access denied.';
        return fs.readFileSync(fullPath, 'utf-8');
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    }
  },
  write_file: {
    description: 'Write or overwrite a file in the workspace.',
    schema: z.object({
      path: z.string().describe('Path relative to /workspace/group'),
      content: z.string().describe('Content to write'),
    }),
    fn: (args: any) => {
      try {
        const fullPath = path.isAbsolute(args.path) ? args.path : path.resolve('/workspace/group', args.path);
        if (!fullPath.startsWith('/workspace/group') && !fullPath.startsWith('/workspace/project'))
          return 'Error: Access denied.';
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, args.content);
        return `Successfully wrote to ${args.path}`;
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    }
  },
  edit_file: {
    description: 'Edit a file using search and replace.',
    schema: z.object({
      path: z.string().describe('Path to the file'),
      oldText: z.string().describe('The exact text to replace'),
      newText: z.string().describe('The replacement text'),
    }),
    fn: (args: any) => {
      try {
        const fullPath = path.isAbsolute(args.path) ? args.path : path.resolve('/workspace/group', args.path);
        if (!fullPath.startsWith('/workspace/group') && !fullPath.startsWith('/workspace/project'))
          return 'Error: Access denied.';
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (!content.includes(args.oldText)) return 'Error: oldText not found.';
        const newContent = content.replace(args.oldText, args.newText);
        fs.writeFileSync(fullPath, newContent);
        return `Successfully edited ${args.path}`;
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    }
  },
  web_search: {
    description: 'Search the live web using Google Search.',
    schema: z.object({
      query: z.string().describe('The search query'),
    }),
    fn: async (args: any, context: any) => {
      try {
        const searchResponse = await context.client.models.generateContent({
          model: context.modelName,
          contents: [{ role: 'user', parts: [{ text: `Search the web and provide a detailed summary for: ${args.query}` }] }],
          config: { tools: [{ googleSearch: {} }] }
        });
        const text = searchResponse.text;
        let metadata = '';
        if (searchResponse.candidates?.[0]?.groundingMetadata?.searchEntryPoint?.renderedContent) {
          metadata = '\n\n[Sources: Google Search]';
        }
        return (text || 'No information found.') + metadata;
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    }
  },
  delegate_task: {
    description: 'Assign a structured task to another agent.',
    schema: z.object({
      targetJid: z.string().describe('The JID of the agent to delegate to'),
      task: z.string().describe('Task description'),
      expectedOutput: z.string().describe('Definition of final result'),
    }),
    fn: (args: any, context: any) => {
      const missionText = `[MISSION_ASSIGNED]\nTask: ${args.task}\nExpected Output: ${args.expectedOutput}`;
      writeIpcFile(IPC_MESSAGES_DIR, {
        type: 'message',
        chatJid: args.targetJid,
        text: missionText,
        sender: context.input.assistantName || 'Manager',
        groupFolder: context.input.groupFolder,
        timestamp: new Date().toISOString(),
      });
      writeIpcFile(TASKS_DIR, {
        type: 'write_mission',
        targetJid: args.targetJid,
        mission: { 
          task: args.task, 
          expectedOutput: args.expectedOutput, 
          assignedBy: context.input.chatJid, 
          assignedByFolder: context.input.groupFolder, 
          timestamp: new Date().toISOString() 
        }
      });
      return `Task delegated to ${args.targetJid}.`;
    }
  },
  submit_work: {
    description: 'Submit the final result of your assigned Mission. MANDATORY: Use this tool when your task is complete to notify the manager, even if you are restricted from direct user communication.',
    schema: z.object({
      result: z.string().describe('The final outcome or report summary'),
    }),
    fn: (args: any, context: any) => {
      const missionPath = path.join('/workspace/group', '.nanogem', 'mission.json');
      let reportJid = context.input.chatJid;
      if (fs.existsSync(missionPath)) {
        try {
          const mission = JSON.parse(fs.readFileSync(missionPath, 'utf-8'));
          if (mission.assignedBy) reportJid = mission.assignedBy;
        } catch {}
      }
      writeIpcFile(IPC_MESSAGES_DIR, {
        type: 'message',
        chatJid: reportJid,
        text: `[MISSION_COMPLETED]\nResult: ${args.result}`,
        sender: context.input.assistantName || 'Worker',
        groupFolder: context.input.groupFolder,
        timestamp: new Date().toISOString(),
      });
      return `Work submitted to ${reportJid}.`;
    }
  },
  recall_memory: {
    description: 'Recall information from long-term memory categories.',
    schema: z.object({
      category: z.enum(['facts', 'workflows', 'episodes']).describe('Memory category'),
    }),
    fn: (args: any) => recallMemory(args.category)
  },
  update_memory: {
    description: 'Update your long-term memory (Continuum).',
    schema: z.object({
      category: z.enum(['facts', 'workflows']).describe('Type of memory to update'),
      content: z.string().describe('The updated Markdown content'),
    }),
    fn: (args: any) => updateMemory(args.category, args.content)
  },
  schedule_task: {
    description: 'Schedule a recurring or one-time AI task.',
    schema: z.object({
      prompt: z.string().describe('Task prompt'),
      schedule_type: z.enum(['cron', 'interval', 'once']),
      schedule_value: z.string().describe('Cron expression, ms, or timestamp'),
      context_mode: z.enum(['group', 'isolated']).optional().default('group'),
      targetJid: z.string().optional().describe('Optional target JID'),
    }),
    fn: (args: any, context: any) => {
      writeIpcFile(TASKS_DIR, { 
        type: 'schedule_task', 
        ...args, 
        createdBy: context.input.groupFolder, 
        timestamp: new Date().toISOString() 
      });
      return 'Task scheduled.';
    }
  },
  pause_task: {
    description: 'Pause a scheduled task.',
    schema: z.object({
      id: z.string().describe('The task ID to pause'),
    }),
    fn: (args: any) => {
      writeIpcFile(TASKS_DIR, { type: 'pause_task', ...args, timestamp: new Date().toISOString() });
      return 'Task pause requested.';
    }
  },
  resume_task: {
    description: 'Resume a paused scheduled task.',
    schema: z.object({
      id: z.string().describe('The task ID to resume'),
    }),
    fn: (args: any) => {
      writeIpcFile(TASKS_DIR, { type: 'resume_task', ...args, timestamp: new Date().toISOString() });
      return 'Task resume requested.';
    }
  },
  cancel_task: {
    description: 'Cancel and delete a scheduled task.',
    schema: z.object({
      id: z.string().describe('The task ID to cancel'),
    }),
    fn: (args: any) => {
      writeIpcFile(TASKS_DIR, { type: 'cancel_task', ...args, timestamp: new Date().toISOString() });
      return 'Task cancellation requested.';
    }
  },
  refresh_groups: {
    description: 'Sync available groups and write metadata snapshot.',
    schema: z.object({}),
    fn: () => {
      writeIpcFile(TASKS_DIR, { type: 'refresh_groups', timestamp: new Date().toISOString() });
      return 'Group refresh requested.';
    }
  },
  create_discord_thread: {
    description: 'Create a new Discord thread and register a sub-agent group. IMPORTANT: The agentIdentity parameter defines the sub-agents PERMANENT IDENTITY. To assign a specific temporary task, you MUST call delegate_task separately.',
    schema: z.object({
      name: z.string().describe('Thread name'),
      parentJid: z.string().describe('Parent channel JID'),
      folder: z.string().describe('Sub-agent folder name'),
      agentIdentity: z.string().describe('The permanent identity and core personality for the sub-agent'),
      ephemeral: z.boolean().optional().default(true),
    }),
    fn: (args: any, context: any) => {
      writeIpcFile(TASKS_DIR, { 
        type: 'create_discord_thread', 
        ...args, 
        chatJid: context.input.chatJid, 
        timestamp: new Date().toISOString() 
      });
      return 'Thread creation requested.';
    }
  },
  rebuild_self: {
    description: 'Trigger a build job to recompile NanoGem and restart the orchestrator.',
    schema: z.object({
      imageTag: z.string().optional().describe('Optional custom image tag'),
      resumptionPrompt: z.string().optional().describe('Prompt to run after restart'),
    }),
    fn: (args: any) => {
      writeIpcFile(TASKS_DIR, { type: 'rebuild_self', ...args, timestamp: new Date().toISOString() });
      return 'Rebuild requested.';
    }
  },
  register_group: {
    description: 'Register a new specialized agent group workspace.',
    schema: z.object({
      name: z.string(),
      folder: z.string(),
      trigger: z.string(),
      agentIdentity: z.string().describe('The permanent persona and core rules for the agent'),
      jid: z.string().optional(),
      requiresTrigger: z.boolean().optional(),
      ephemeral: z.boolean().optional(),
    }),
    fn: (args: any, context: any) => {
      const jid = args.jid || `internal-${args.folder}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, { 
        type: 'register_group', 
        ...args, 
        jid, 
        sourceGroup: context.input.groupFolder, 
        timestamp: new Date().toISOString() 
      });
      return `Group "${args.name}" registration requested.`;
    }
  },
  delete_group: {
    description: 'Delete an internal agent group. Rule: JID must NOT start with "discord-".',
    schema: z.object({
      jid: z.string().describe('The internal JID to delete'),
    }),
    fn: (args: any, context: any) => {
      writeIpcFile(TASKS_DIR, { 
        type: 'delete_group', 
        jid: args.jid, 
        sourceGroup: context.input.groupFolder, 
        timestamp: new Date().toISOString() 
      });
      return `Deletion requested for ${args.jid}.`;
    }
  },
  delete_discord_thread: {
    description: 'Delete a Discord thread and sub-agent. Rule: JID must start with "discord-".',
    schema: z.object({
      jid: z.string().describe('The Discord thread JID to delete'),
    }),
    fn: (args: any, context: any) => {
      writeIpcFile(TASKS_DIR, { 
        type: 'delete_discord_thread', 
        jid: args.jid, 
        sourceGroup: context.input.groupFolder, 
        timestamp: new Date().toISOString() 
      });
      return `Discord thread deletion requested for ${args.jid}.`;
    }
  },
  list_groups: {
    description: 'List all registered and available agent groups.',
    schema: z.object({}),
    fn: () => {
      const groupsFile = '/workspace/ipc/available_groups.json';
      return fs.existsSync(groupsFile) ? fs.readFileSync(groupsFile, 'utf-8') : 'Group list not available.';
    }
  },
  append_thought: {
    description: 'Manually append a progress update or reasoning to the group THOUGHTS.log.',
    schema: z.object({
      text: z.string().describe('The thought content to record'),
    }),
    fn: (args: any) => {
      const logPath = '/workspace/group/THOUGHTS.log';
      const timestamp = new Date().toISOString();
      try {
        fs.appendFileSync(logPath, `[${timestamp}] [USER_FACING_THOUGHT] ${args.text}\n`);
        return 'Thought appended to NAS log.';
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }
  },
  wait_for_report: {
    description: 'Wait for a sub-agent to finish its task and write a REPORT.md file.',
    schema: z.object({
      folder: z.string().describe('Sub-agent folder name'),
      timeoutMs: z.number().optional().default(300000),
    }),
    fn: async (args: any) => {
      const reportPath = path.join('/workspace/project/groups', args.folder, 'REPORT.md');
      const start = Date.now();
      while (Date.now() - start < args.timeoutMs) {
        if (fs.existsSync(reportPath)) {
          return fs.readFileSync(reportPath, 'utf-8');
        }
        await new Promise(r => setTimeout(r, 5000));
      }
      return 'Timeout waiting for report.';
    }
  },
  follow_stream: {
    description: 'Follow the live THOUGHTS.log stream of a sub-agent.',
    schema: z.object({
      folder: z.string().describe('Sub-agent folder name'),
      lines: z.number().optional().default(10),
    }),
    fn: (args: any) => {
      const logPath = path.join('/workspace/project/groups', args.folder, 'THOUGHTS.log');
      try {
        if (!fs.existsSync(logPath)) return 'Log file not found.';
        const content = fs.readFileSync(logPath, 'utf-8');
        const lines = content.trim().split('\n');
        return lines.slice(-args.lines).join('\n');
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }
  },
};

/**
 * Generate function declarations for the Gemini API.
 */
export function getToolDeclarations(): any[] {
  return Object.entries(Tools).map(([name, tool]) => {
    const jsonSchema = zodToJsonSchema(tool.schema as any) as any;
    // Map JSON Schema to Gemini Function Declaration format
    return {
      name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: jsonSchema.properties || {},
        required: jsonSchema.required || [],
      }
    };
  });
}

/**
 * Generate the implementation map for the Agent Runner.
 */
export function getFunctions(
  input: ContainerInput,
  client: any,
  modelName: string
): Record<string, (args: any) => Promise<string> | string> {
  const context = { input, client, modelName };
  const functions: any = {};
  
  for (const [name, tool] of Object.entries(Tools)) {
    functions[name] = (args: any) => tool.fn(args, context);
  }
  
  return functions;
}
