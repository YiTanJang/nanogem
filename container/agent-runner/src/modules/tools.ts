import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
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

export const toolDeclarations = [
  {
    name: 'bash',
    description: 'Execute a bash command in the isolated pod environment.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        command: { type: 'STRING' as const, description: 'The command to execute' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file in the workspace.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        path: { type: 'STRING' as const, description: 'Path relative to /workspace/group' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write or overwrite a file in the workspace.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        path: { type: 'STRING' as const, description: 'Path relative to /workspace/group' },
        content: { type: 'STRING' as const, description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Edit a file using search and replace.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        path: { type: 'STRING' as const, description: 'Path to the file' },
        oldText: { type: 'STRING' as const, description: 'The exact text to replace' },
        newText: { type: 'STRING' as const, description: 'The replacement text' },
      },
      required: ['path', 'oldText', 'newText'],
    },
  },
  {
    name: 'glob',
    description: 'Find files matching a pattern.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        pattern: { type: 'STRING' as const, description: 'Glob pattern' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: 'Search for a string in files.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        query: { type: 'STRING' as const, description: 'Search string' },
        path: { type: 'STRING' as const, description: 'Directory to search' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the live web for current information using Google Search.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        query: { type: 'STRING' as const, description: 'The search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch the content of a URL.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        url: { type: 'STRING' as const, description: 'URL to fetch' },
      },
      required: ['url'],
    },
  },
  {
    name: 'send_message',
    description: 'Send a message to a user or another agent.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        text: { type: 'STRING' as const, description: 'Message content' },
        sender: { type: 'STRING' as const, description: 'Optional display name' },
        targetJid: { type: 'STRING' as const, description: 'Optional target JID' },
      },
      required: ['text'],
    },
  },
  {
    name: 'delegate_task',
    description: 'Assign a structured task to another agent.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        targetJid: { type: 'STRING' as const, description: 'The JID of the agent to delegate to' },
        task: { type: 'STRING' as const, description: 'Task description' },
        expectedOutput: { type: 'STRING' as const, description: 'Definition of final result' },
      },
      required: ['targetJid', 'task', 'expectedOutput'],
    },
  },
  {
    name: 'submit_work',
    description: 'Submit the final result of your assigned Mission.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        result: { type: 'STRING' as const, description: 'The final outcome' },
      },
      required: ['result'],
    },
  },
  {
    name: 'recall_memory',
    description: 'Recall information from long-term memory (facts, workflows, or episodes).',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        category: { type: 'STRING' as const, enum: ['facts', 'workflows', 'episodes'] },
      },
      required: ['category'],
    },
  },
  {
    name: 'update_memory',
    description: 'Update your long-term memory (Continuum).',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        category: { type: 'STRING' as const, enum: ['facts', 'workflows'] },
        content: { type: 'STRING' as const, description: 'The updated Markdown content' },
      },
      required: ['category', 'content'],
    },
  },
  {
    name: 'schedule_task',
    description: 'Schedule a recurring or one-time AI task.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        prompt: { type: 'STRING' as const, description: 'Task prompt' },
        schedule_type: { type: 'STRING' as const, description: 'cron | interval | once' },
        schedule_value: { type: 'STRING' as const, description: 'Cron expression, ms, or timestamp' },
        context_mode: { type: 'STRING' as const, description: 'group | isolated' },
        targetJid: { type: 'STRING' as const, description: 'Optional target JID' },
      },
      required: ['prompt', 'schedule_type', 'schedule_value'],
    },
  },
  {
    name: 'create_discord_thread',
    description: 'Create a new Discord thread and bind an autonomous sub-agent to it.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        name: { type: 'STRING' as const, description: 'Thread name' },
        parentJid: { type: 'STRING' as const, description: 'Parent channel JID' },
        folder: { type: 'STRING' as const, description: 'Sub-agent folder' },
        systemInstruction: { type: 'STRING' as const, description: 'Agent instructions' },
        ephemeral: { type: 'BOOLEAN' as const, description: 'Delete on unregister' }
      },
      required: ['name', 'parentJid', 'folder', 'systemInstruction'],
    },
  },
  {
    name: 'rebuild_self',
    description: 'Trigger a build job to recompile NanoGem and restart the orchestrator.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        imageTag: { type: 'STRING' as const, description: 'Optional custom image tag' },
        resumptionPrompt: { type: 'STRING' as const, description: 'Command after restart' },
      },
    },
  },
  {
    name: 'build_project',
    description: 'Build an image for a specific project folder.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        imageTag: { type: 'STRING' as const, description: 'Destination tag' },
        folder: { type: 'STRING' as const, description: 'Source project folder' },
        dockerfilePath: { type: 'STRING' as const, description: 'Optional Dockerfile path' },
      },
      required: ['imageTag', 'folder'],
    },
  },
  {
    name: 'register_group',
    description: 'Register a new specialized agent group workspace.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        jid: { type: 'STRING' as const },
        name: { type: 'STRING' as const },
        folder: { type: 'STRING' as const },
        trigger: { type: 'STRING' as const },
        requiresTrigger: { type: 'BOOLEAN' as const },
        systemInstruction: { type: 'STRING' as const },
        ephemeral: { type: 'BOOLEAN' as const },
      },
      required: ['name', 'folder', 'trigger', 'systemInstruction'],
    },
  },
  {
    name: 'delete_group',
    description: 'Delete an existing agent group workspace.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        jid: { type: 'STRING' as const, description: 'JID to delete' },
      },
      required: ['jid'],
    },
  },
  {
    name: 'list_groups',
    description: 'List all registered and available agent groups.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {},
    },
  },
];

export const getFunctions = (
  input: ContainerInput,
  client: any,
  modelName: string
) => ({
  bash: ({ command }: any) => {
    try {
      const output = execSync(command, { encoding: 'utf-8', timeout: 30000 });
      return output || 'Success (no output).';
    } catch (err: any) {
      return `Error: ${err.message}\n${err.stderr || ''}`;
    }
  },
  read_file: ({ path: filePath }: any) => {
    try {
      const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve('/workspace/group', filePath);
      if (!fullPath.startsWith('/workspace/group') && !fullPath.startsWith('/workspace/project'))
        return 'Error: Access denied.';
      return fs.readFileSync(fullPath, 'utf-8');
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  },
  write_file: ({ path: filePath, content }: any) => {
    try {
      const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve('/workspace/group', filePath);
      if (!fullPath.startsWith('/workspace/group') && !fullPath.startsWith('/workspace/project'))
        return 'Error: Access denied.';
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
      return `Successfully wrote to ${filePath}`;
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  },
  edit_file: ({ path: filePath, oldText, newText }: any) => {
    try {
      const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve('/workspace/group', filePath);
      if (!fullPath.startsWith('/workspace/group') && !fullPath.startsWith('/workspace/project'))
        return 'Error: Access denied.';
      const content = fs.readFileSync(fullPath, 'utf-8');
      if (!content.includes(oldText)) return 'Error: oldText not found.';
      const newContent = content.replace(oldText, newText);
      fs.writeFileSync(fullPath, newContent);
      return `Successfully edited ${filePath}`;
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  },
  glob: ({ pattern }: any) => {
    try {
      const output = execSync(`find . -name "${pattern}"`, {
        cwd: pattern.startsWith('/workspace/project') ? '/workspace/project' : '/workspace/group',
        encoding: 'utf-8',
      });
      return output || 'No matches.';
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  },
  grep: ({ query, path: searchPath = '.' }: any) => {
    try {
      const fullPath = searchPath.startsWith('/') ? searchPath : path.resolve('/workspace/group', searchPath);
      const output = execSync(`grep -r "${query}" "${fullPath}"`, {
        encoding: 'utf-8',
      });
      return output || 'No matches.';
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  },
  web_search: async ({ query }: any) => {
    try {
      const searchResponse = await client.models.generateContent({
        model: modelName,
        contents: [{ role: 'user', parts: [{ text: `Search the web and provide a detailed summary for: ${query}` }] }],
        config: { tools: [{ googleSearch: {} }] }
      });
      
      const text = searchResponse.text;
      let metadata = '';
      if (searchResponse.candidates?.[0]?.groundingMetadata?.searchEntryPoint?.renderedContent) {
        metadata = '\n\n[Sources: Google Search]';
      }
      return (text || 'No information found.') + metadata;
    } catch (err: any) {
      return `Error performing native search: ${err.message}`;
    }
  },
  web_fetch: async ({ url }: any) => {
    try {
      const output = execSync(`curl -sL "${url}" | head -c 15000`, { encoding: 'utf-8', timeout: 10000 });
      return output || 'Empty response.';
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  },
  send_message: ({ text, sender, targetJid }: any) => {
    const finalTargetJid = targetJid || input.chatJid;
    writeIpcFile(IPC_MESSAGES_DIR, {
      type: 'message',
      chatJid: finalTargetJid,
      text,
      sender,
      groupFolder: input.groupFolder,
      timestamp: new Date().toISOString(),
    });
    return `Message sent to ${finalTargetJid}.`;
  },
  delegate_task: ({ targetJid, task, expectedOutput }: any) => {
    const missionText = `[MISSION_ASSIGNED]\nTask: ${task}\nExpected Output: ${expectedOutput}`;
    writeIpcFile(IPC_MESSAGES_DIR, {
      type: 'message',
      chatJid: targetJid,
      text: missionText,
      sender: input.assistantName || 'Manager',
      groupFolder: input.groupFolder,
      timestamp: new Date().toISOString(),
    });
    writeIpcFile(TASKS_DIR, {
      type: 'write_mission',
      targetJid,
      mission: { task, expectedOutput, assignedBy: input.chatJid, assignedByFolder: input.groupFolder, timestamp: new Date().toISOString() }
    });
    return `Task delegated to ${targetJid}.`;
  },
  submit_work: ({ result }: any) => {
    const missionPath = path.join('/workspace/group', '.nanogem', 'mission.json');
    let reportJid = input.chatJid;
    if (fs.existsSync(missionPath)) {
      try {
        const mission = JSON.parse(fs.readFileSync(missionPath, 'utf-8'));
        if (mission.assignedBy) reportJid = mission.assignedBy;
      } catch {}
    }
    writeIpcFile(IPC_MESSAGES_DIR, {
      type: 'message',
      chatJid: reportJid,
      text: `[MISSION_COMPLETED]\nResult: ${result}`,
      sender: input.assistantName || 'Worker',
      groupFolder: input.groupFolder,
      timestamp: new Date().toISOString(),
    });
    return `Work submitted to ${reportJid}.`;
  },
  recall_memory: ({ category }: any) => recallMemory(category),
  update_memory: ({ category, content }: any) => updateMemory(category, content),
  schedule_task: (args: any) => {
    writeIpcFile(TASKS_DIR, { type: 'schedule_task', ...args, createdBy: input.groupFolder, timestamp: new Date().toISOString() });
    return 'Task scheduled.';
  },
  create_discord_thread: (args: any) => {
    writeIpcFile(TASKS_DIR, { type: 'create_discord_thread', ...args, chatJid: input.chatJid, timestamp: new Date().toISOString() });
    return 'Thread creation requested.';
  },
  rebuild_self: (args: any) => {
    writeIpcFile(TASKS_DIR, { type: 'rebuild_self', ...args, timestamp: new Date().toISOString() });
    return 'Rebuild requested.';
  },
  build_project: ({ imageTag, folder, dockerfilePath }: any) => {
    const targetFolder = folder || input.groupFolder;
    writeIpcFile(TASKS_DIR, { type: 'build_project', imageTag, dockerfilePath: dockerfilePath || 'Dockerfile', contextPath: `groups/${targetFolder}`, shouldRollout: false, timestamp: new Date().toISOString() });
    return `Build requested for groups/${targetFolder}.`;
  },
  register_group: (args: any) => {
    const jid = args.jid || `internal-${args.folder}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, { type: 'register_group', ...args, jid, sourceGroup: input.groupFolder, timestamp: new Date().toISOString() });
    return `Group "${args.name}" registration requested.`;
  },
  delete_group: ({ jid }: any) => {
    writeIpcFile(TASKS_DIR, { type: 'delete_group', jid, sourceGroup: input.groupFolder, timestamp: new Date().toISOString() });
    return `Deletion requested for ${jid}.`;
  },
  list_groups: () => {
    const groupsFile = '/workspace/ipc/available_groups.json';
    return fs.existsSync(groupsFile) ? fs.readFileSync(groupsFile, 'utf-8') : 'Group list not available.';
  },
});
