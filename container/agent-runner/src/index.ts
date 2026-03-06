/**
 * NanoClaw Agent Runner (Gemini 2026 Edition)
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 * Uses the modern @google/genai unified SDK.
 * Implements "Nested Native Search" to bypass v1beta tool combination restrictions.
 */

import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { EventSource } from 'eventsource';
import { execSync } from 'child_process';

// Required for Node.js SSE
(globalThis as any).EventSource = EventSource;
import { CronExpressionParser } from 'cron-parser';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  model?: string;
  mcpConfig?: {
    mcpServers: Record<string, any>;
  };
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const IPC_DIR = '/workspace/ipc';
const IPC_INPUT_DIR = path.join(IPC_DIR, 'input');
const IPC_MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 1000;

function writeOutput(output: ContainerOutput): void {
  const json = JSON.stringify(output);
  console.log(OUTPUT_START_MARKER);
  console.log(json);
  console.log(OUTPUT_END_MARKER);

  // Persistence backup: Append the result to THOUGHTS.log for orchestrator to track reliably
  if (output.result && output.status === 'success') {
    try {
      const thoughtPath = path.join('/workspace/group', 'THOUGHTS.log');
      fs.appendFileSync(thoughtPath, `\n[AGENT_RESPONSE] ${output.result}\n`);
    } catch (err) {
      log(`Thought log backup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Failsafe: Write to persistent IPC directory in case log streaming fails
  try {
    const resultFile = `result-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
    const resultPath = path.join(IPC_DIR, resultFile);
    fs.writeFileSync(resultPath, json);
  } catch (err) {
    log(`Failsafe write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function writeIpcFile(dir: string, data: object): void {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

// --- Gemini Tools & Functions ---

const toolDeclarations = [
  {
    name: 'bash',
    description: 'Execute a bash command in the isolated container environment.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        command: {
          type: 'STRING' as const,
          description: 'The command to execute',
        },
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
        path: {
          type: 'STRING' as const,
          description: 'Path to the file relative to /workspace/group',
        },
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
        path: {
          type: 'STRING' as const,
          description: 'Path to the file relative to /workspace/group',
        },
        content: {
          type: 'STRING' as const,
          description: 'Content to write',
        },
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
        oldText: {
          type: 'STRING' as const,
          description: 'The exact text to replace',
        },
        newText: {
          type: 'STRING' as const,
          description: 'The replacement text',
        },
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
        pattern: {
          type: 'STRING' as const,
          description: 'Glob pattern (e.g. src/**/*.ts)',
        },
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
        path: {
          type: 'STRING' as const,
          description: 'Directory to search',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the live web for current information using Google Search. Use this whenever you need up-to-date information, news, or to verify facts.',
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
    description: 'Send a message to a WhatsApp user or another agent.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        text: { type: 'STRING' as const, description: 'Message content' },
        sender: {
          type: 'STRING' as const,
          description: 'Optional display name',
        },
        targetJid: {
          type: 'STRING' as const,
          description: 'Optional target JID (defaults to user chat)',
        },
        media: {
          type: 'OBJECT' as const,
          properties: {
            mimeType: { type: 'STRING' as const },
            data: { type: 'STRING' as const, description: 'Base64 data' },
          },
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'schedule_task',
    description: 'Schedule a recurring or one-time AI task.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        prompt: { type: 'STRING' as const, description: 'Task prompt' },
        schedule_type: {
          type: 'STRING' as const,
          description: 'cron | interval | once',
        },
        schedule_value: {
          type: 'STRING' as const,
          description: 'Cron expression, ms, or timestamp',
        },
        context_mode: {
          type: 'STRING' as const,
          description: 'group | isolated',
        },
        targetJid: {
          type: 'STRING' as const,
          description: 'Optional target JID (for delegating to other agents)',
        },
      },
      required: ['prompt', 'schedule_type', 'schedule_value'],
    },
  },
  {
    name: 'rebuild_self',
    description: 'Trigger a Kaniko build job to recompile NanoClaw and restart the orchestrator. This uses the fixed system Dockerfile for security.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        imageTag: { type: 'STRING' as const, description: 'Optional custom image tag' },
        resumptionPrompt: { 
          type: 'STRING' as const, 
          description: 'The command or task description to be delivered to you after the system restarts. Use this to ensure you continue your mission (e.g. \"Implement the Discord bridge logic\").' 
        },
      },
    },
  },
  {
    name: 'build_project',
    description: 'Build a Docker image for a specific project folder and push it to the local registry. This does NOT restart the NanoClaw orchestrator.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        imageTag: {
          type: 'STRING' as const,
          description: 'The destination image tag (e.g. registry.local:5000/my-app:latest)',
        },
        folder: {
          type: 'STRING' as const,
          description: 'The folder containing the project code (e.g. "my-web-app"). This folder must exist in the groups directory.',
        },
        dockerfilePath: {
          type: 'STRING' as const,
          description: 'Optional path to the Dockerfile (relative to the project folder, defaults to "Dockerfile")',
        },
      },
      required: ['imageTag', 'folder'],
    },
  },
  {
    name: 'register_group',
    description: 'Register a new specialized agent group workspace. Use this to spawn sub-agents with their own isolated memory and files.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        jid: {
          type: 'STRING' as const,
          description: 'Unique identifier for the group (optional, will be generated if omitted)',
        },
        name: {
          type: 'STRING' as const,
          description: 'Display name for the sub-agent (e.g. "Film Researcher")',
        },
        folder: {
          type: 'STRING' as const,
          description: 'Unique folder name (lowercase, hyphens, e.g. "agent-film")',
        },
        trigger: {
          type: 'STRING' as const,
          description: 'Trigger word for this group (e.g. "@Andy")',
        },
        requiresTrigger: {
          type: 'BOOLEAN' as const,
          description: 'Whether the trigger prefix is required (default: true)',
        },
        containerConfig: {
          type: 'OBJECT' as const,
          description: 'Optional configuration for the container environment',
        },
        systemInstruction: {
          type: 'STRING' as const,
          description: 'The core identity and instructions for the agent (Markdown format). Use this to define its role and workflow (e.g. REPORT.md requirements).',
        },
        ephemeral: {
          type: 'BOOLEAN' as const,
          description: 'If true, the agent workspace folder will be automatically deleted when the group is unregistered.',
        },
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
        jid: {
          type: 'STRING' as const,
          description: 'The unique identifier (JID) of the group to delete',
        },
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
  {
    name: 'wait_for_report',
    description: 'Wait for a sub-agent to finish its task and write a REPORT.md file.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        folder: {
          type: 'STRING' as const,
          description: 'The folder name of the sub-agent (e.g. "agent-film")',
        },
        timeoutMs: {
          type: 'NUMBER' as const,
          description: 'Maximum time to wait in milliseconds (default 60000)',
        },
      },
      required: ['folder'],
    },
  },
  {
    name: 'append_thought',
    description: 'Stream a partial thought or progress update to the group THOUGHTS.log. Use this to provide real-time feedback to a coordinator.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        text: {
          type: 'STRING' as const,
          description: 'The thought or update text to append',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'follow_stream',
    description: 'Follow the THOUGHTS.log stream of a sub-agent in real-time. Returns any new lines added to the log.',
    parameters: {
      type: 'OBJECT' as const,
      properties: {
        folder: {
          type: 'STRING' as const,
          description: 'The folder name of the sub-agent to follow',
        },
        timeoutMs: {
          type: 'NUMBER' as const,
          description: 'Maximum time to wait for new thoughts in ms (default 30000)',
        },
      },
      required: ['folder'],
    },
  },
];

const getFunctions = (
  input: ContainerInput,
  client: any,
  modelName: string
): Record<string, (args: any) => Promise<string> | string> => ({
  bash: ({ command }) => {
    try {
      const output = execSync(command, { encoding: 'utf-8', timeout: 30000 });
      return output || 'Success (no output).';
    } catch (err: any) {
      return `Error: ${err.message}\n${err.stderr || ''}`;
    }
  },
  read_file: ({ path: filePath }) => {
    try {
      const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve('/workspace/group', filePath);
      log(`Read request: ${filePath} -> ${fullPath}`);
      if (!fullPath.startsWith('/workspace/group') && !fullPath.startsWith('/workspace/project'))
        return 'Error: Access denied.';
      return fs.readFileSync(fullPath, 'utf-8');
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  },
  write_file: ({ path: filePath, content }) => {
    try {
      const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve('/workspace/group', filePath);
      log(`Write request: ${filePath} -> ${fullPath}`);
      if (!fullPath.startsWith('/workspace/group') && !fullPath.startsWith('/workspace/project'))
        return 'Error: Access denied.';
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
      return `Successfully wrote to ${filePath}`;
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  },
  edit_file: ({ path: filePath, oldText, newText }) => {
    try {
      const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve('/workspace/group', filePath);
      log(`Edit request: ${filePath} -> ${fullPath}`);
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
  glob: ({ pattern }) => {
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
  grep: ({ query, path: searchPath = '.' }) => {
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
  web_search: async ({ query }) => {
    try {
      log(`Triggering nested native search for: ${query} using ${modelName}`);
      const searchResponse = await client.models.generateContent({
        model: modelName,
        contents: [{
          role: 'user',
          parts: [{ text: `Search the web and provide a detailed summary for: ${query}` }]
        }],
        config: {
          tools: [{ googleSearch: {} }]
        }
      });
      
      const text = searchResponse.text;
      let metadata = '';
      if (searchResponse.candidates?.[0]?.groundingMetadata?.searchEntryPoint?.renderedContent) {
        metadata = '\n\n[Sources: Google Search]';
      }
      return (text || 'No information found.') + metadata;
    } catch (err: any) {
      log(`Nested search error: ${err.message}`);
      return `Error performing native search: ${err.message}`;
    }
  },
  web_fetch: async ({ url }) => {
    try {
      const output = execSync(`curl -sL "${url}" | head -c 15000`, {
        encoding: 'utf-8',
        timeout: 10000,
      });
      return output || 'Empty response.';
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  },
  send_message: ({ text, sender, media, targetJid }) => {
    const finalTargetJid = targetJid || input.chatJid;
    writeIpcFile(IPC_MESSAGES_DIR, {
      type: 'message',
      chatJid: finalTargetJid,
      text,
      sender,
      media,
      groupFolder: input.groupFolder,
      timestamp: new Date().toISOString(),
    });
    return `Message sent to ${finalTargetJid}.`;
  },
  schedule_task: ({
    prompt,
    schedule_type,
    schedule_value,
    context_mode = 'group',
    targetJid,
  }) => {
    if (schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(schedule_value);
      } catch {
        return 'Error: Invalid cron.';
      }
    }
    const finalTargetJid = targetJid || input.chatJid;
    writeIpcFile(TASKS_DIR, {
      type: 'schedule_task',
      prompt,
      schedule_type,
      schedule_value,
      context_mode,
      targetJid: finalTargetJid,
      createdBy: input.groupFolder,
      timestamp: new Date().toISOString(),
    });
    return `Task scheduled for ${finalTargetJid}: ${schedule_type} ${schedule_value}`;
  },
  rebuild_self: ({ imageTag, resumptionPrompt }) => {
    writeIpcFile(TASKS_DIR, {
      type: 'rebuild_self',
      imageTag,
      resumptionPrompt,
      timestamp: new Date().toISOString(),
    });
    return 'Rebuild requested. The system will rebuild and restart shortly using the official system Dockerfile.';
  },
  build_project: ({ imageTag, folder, dockerfilePath }) => {
    writeIpcFile(TASKS_DIR, {
      type: 'build_project',
      imageTag,
      dockerfilePath,
      contextPath: `groups/${folder}`, // Correct context path for projects
      shouldRollout: false,
      timestamp: new Date().toISOString(),
    });
    return `Build requested for project in "${folder}". The image will be pushed to ${imageTag}.`;
  },
  register_group: ({ jid, name, folder, trigger, requiresTrigger, containerConfig, systemInstruction, ephemeral }) => {
    const finalJid = jid || `internal-${folder}-${Math.random().toString(36).slice(2, 8)}`;
    const finalRequiresTrigger = requiresTrigger ?? !finalJid.startsWith('internal-');
    
    if (!systemInstruction) {
      return 'Error: You must provide a systemInstruction (identity) to initialize a new agent.';
    }

    // Pass the request to the Orchestrator (the Gatekeeper) via IPC
    writeIpcFile(TASKS_DIR, {
      type: 'register_group',
      jid: finalJid,
      name,
      folder,
      trigger,
      requiresTrigger: finalRequiresTrigger,
      containerConfig,
      systemInstruction,
      ephemeral, // Orchestrator will delete folder if true
      sourceGroup: input.groupFolder,
      timestamp: new Date().toISOString(),
    });
    return `Agent initialization requested for "${name}" (ephemeral: ${!!ephemeral}).`;
  },
  delete_group: ({ jid }) => {
    writeIpcFile(TASKS_DIR, {
      type: 'delete_group',
      jid,
      sourceGroup: input.groupFolder,
      timestamp: new Date().toISOString(),
    });
    return `Group deletion requested for JID ${jid}.`;
  },
  list_groups: () => {
    const groupsFile = '/workspace/ipc/available_groups.json';
    if (fs.existsSync(groupsFile)) {
      return fs.readFileSync(groupsFile, 'utf-8');
    }
    return 'Group list not yet available. Please try again in a few seconds.';
  },
  wait_for_report: async ({ folder, timeoutMs = 60000 }) => {
    const reportPath = path.join('/workspace/project/groups', folder, 'REPORT.md');
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fs.existsSync(reportPath)) {
        return fs.readFileSync(reportPath, 'utf-8');
      }
      await new Promise(r => setTimeout(r, 5000));
    }
    return `Timeout waiting for report from ${folder} after ${timeoutMs}ms.`;
  },
  append_thought: ({ text }) => {
    try {
      const thoughtPath = path.join('/workspace/group', 'THOUGHTS.log');
      fs.appendFileSync(thoughtPath, `[${new Date().toISOString()}] ${text}\n`);
      return 'Thought appended to stream.';
    } catch (err: any) {
      return `Error appending thought: ${err.message}`;
    }
  },
  follow_stream: async ({ folder, timeoutMs = 30000 }) => {
    try {
      const thoughtPath = path.join('/workspace/project/groups', folder, 'THOUGHTS.log');
      const start = Date.now();
      let lastSize = 0;
      
      // Wait for file to exist (be patient with NFS)
      while (Date.now() - start < 10000 && !fs.existsSync(thoughtPath)) {
        await new Promise(r => setTimeout(r, 1000));
      }
      
      if (!fs.existsSync(thoughtPath)) return 'Stream not started yet.';

      lastSize = fs.statSync(thoughtPath).size;
      let newThoughts = '';

      // Poll for new additions with tighter loop
      const pollStart = Date.now();
      while (Date.now() - pollStart < timeoutMs) {
        try {
          const stats = fs.statSync(thoughtPath);
          if (stats.size > lastSize) {
            const fd = fs.openSync(thoughtPath, 'r');
            const buffer = Buffer.alloc(stats.size - lastSize);
            fs.readSync(fd, buffer, 0, stats.size - lastSize, lastSize);
            fs.closeSync(fd);
            newThoughts += buffer.toString();
            lastSize = stats.size;
            break; 
          }
        } catch (e) {
          // Ignore transient stat errors on NFS
        }
        await new Promise(r => setTimeout(r, 1000));
      }

      return newThoughts || 'No new thoughts in stream.';
    } catch (err: any) {
      return `Error following stream: ${err.message}`;
    }
  },
});

function parseMultimodalPrompt(prompt: string): any[] {
  const parts: any[] = [];
  const mediaRegex = /<media\s+mimeType="([^"]+)"\s+data="([^"]+)"\s*\/>/g;
  let lastIndex = 0;
  let match;

  while ((match = mediaRegex.exec(prompt)) !== null) {
    const textBefore = prompt.substring(lastIndex, match.index);
    if (textBefore) parts.push({ text: textBefore });
    
    parts.push({
      inlineData: {
        mimeType: match[1],
        data: match[2],
      },
    });
    lastIndex = match.index + match[0].length;
  }

  const textAfter = prompt.substring(lastIndex);
  if (textAfter) parts.push({ text: textAfter });

  return parts.length > 0 ? parts : [{ text: prompt }];
}

// --- MCP Management ---

class McpManager {
  private clients: Map<string, Client> = new Map();
  private toolToClient: Map<string, string> = new Map();
  private mcpTools: any[] = [];

  async initialize(config?: { mcpServers: Record<string, any> }) {
    if (!config || !config.mcpServers) return;

    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      try {
        let transport;

        if (serverConfig.command) {
          transport = new StdioClientTransport({
            command: serverConfig.command,
            args: serverConfig.args || [],
            env: { ...process.env, ...(serverConfig.env || {}) },
          });
        } else if (serverConfig.url) {
          const token = serverConfig.env?.MCP_TOKEN;
          const url = new URL(serverConfig.url);
          
          if (url.pathname.endsWith('/mcp')) {
            // Modern Streamable HTTP (for SilverBullet)
            transport = new StreamableHTTPClientTransport(url, {
              requestInit: token ? {
                headers: { 'Authorization': `Bearer ${token}` }
              } : undefined,
            });
          } else {
            // Legacy SSE
            if (token) {
              url.searchParams.set('token', token);
            }
            transport = new SSEClientTransport(url, {
              eventSourceInit: token ? {
                fetch: (url: any, init: any) => {
                  const headers = new Headers(init?.headers || {});
                  headers.set('Authorization', `Bearer ${token}`);
                  return fetch(url, { ...init, headers });
                }
              } : undefined,
              requestInit: token ? {
                headers: { 'Authorization': `Bearer ${token}` }
              } : undefined,
            });
          }
        } else {
          log(`Invalid config for MCP server ${name}: no command or url`);
          continue;
        }

        const client = new Client(
          { name: 'nanoclaw-agent', version: '1.0.0' },
          { capabilities: {} }
        );

        // Add timeout to connection and tool listing
        const connectPromise = client.connect(transport);
        await Promise.race([
          connectPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 5000))
        ]);
        
        this.clients.set(name, client);

        const listToolsPromise = client.listTools();
        const { tools } = await Promise.race([
          listToolsPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('List tools timeout')), 5000))
        ]) as any;

        for (const tool of tools) {
          const toolName = tool.name;
          if (this.toolToClient.has(toolName)) {
            log(`Warning: MCP tool collision for ${toolName}. Overwriting.`);
          }
          this.toolToClient.set(toolName, name);
          
          // Map MCP tool definition to Gemini function declaration
          this.mcpTools.push({
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema as any,
          });
        }
        log(`Connected to MCP server ${name} with ${tools.length} tools`);
      } catch (err: any) {
        log(`Failed to connect to MCP server ${name}: ${err.message}`);
      }
    }
  }

  getToolDeclarations() {
    return this.mcpTools;
  }

  async callTool(name: string, args: any) {
    const serverName = this.toolToClient.get(name);
    if (!serverName) throw new Error(`MCP tool ${name} not found`);
    
    const client = this.clients.get(serverName);
    if (!client) throw new Error(`MCP client ${serverName} not found`);

    log(`Calling MCP tool ${name} on server ${serverName}`);
    const result = await client.callTool({ name, arguments: args }) as any;
    
    // Format MCP result for Gemini (convert Content array to string)
    const textParts = result.content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text);
    
    return textParts.join('\n') || 'Success (no text output).';
  }

  isMcpTool(name: string) {
    return this.toolToClient.has(name);
  }

  async shutdown() {
    for (const client of this.clients.values()) {
      try {
        await client.close();
      } catch (err) {
        // Ignore shutdown errors
      }
    }
  }
}

// --- Main Execution ---

async function main(): Promise<void> {
  let input: ContainerInput;
  try {
    let stdin = fs.readFileSync(0, 'utf8').trim();
    if (!stdin.startsWith('{')) {
      stdin = Buffer.from(stdin, 'base64').toString('utf8');
    }
    input = JSON.parse(stdin);
  } catch (err) {
    writeOutput({ status: 'error', result: null, error: 'Stdin parse failed' });
    return;
  }

  const apiKey = input.secrets?.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    writeOutput({ status: 'error', result: null, error: 'GEMINI_API_KEY missing' });
    return;
  }

  const client = new (GoogleGenAI as any)({ apiKey });
  const modelName = input.model || process.env.GEMINI_MODEL || 'gemini-2.5-pro';
  
  // Initialize MCP
  const mcpManager = new McpManager();
  await mcpManager.initialize(input.mcpConfig);

  const functions = getFunctions(input, client, modelName);
  const historyPath = path.join('/workspace/group', '.nanoclaw', 'history.json');
  let history: any[] = [];
  if (fs.existsSync(historyPath)) {
    try {
      const rawHistory = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
      history = rawHistory.filter((h: any) => h.role === 'user' || h.role === 'model');
    } catch {
      log('History corrupted');
    }
  }

  const globalMdPath = '/workspace/global/GEMINI.md';
  const groupMdPath = '/workspace/group/GEMINI.md';
  
  let systemPrompt = `You are ${input.assistantName || 'Andy'}, an autonomous AI agent running in a security-isolated Kubernetes pod.
You have access to a variety of tools, including those from external MCP (Model Context Protocol) servers. 
When a user asks you to perform a task involving these systems (like listing documents, searching links, etc.), use the corresponding tools provided to you. Do not refuse based on "isolation" if a relevant tool is available in your function list.`;

  if (fs.existsSync(groupMdPath)) {
    // Group-specific identity takes precedence
    systemPrompt = fs.readFileSync(groupMdPath, 'utf-8');
  } else if (fs.existsSync(globalMdPath)) {
    systemPrompt += `\n\nGlobal Context:\n${fs.readFileSync(globalMdPath, 'utf-8')}`;
  }

  // Combine built-in tools with MCP tools
  const allTools = [
    ...toolDeclarations,
    ...mcpManager.getToolDeclarations()
  ];

  const currentChat = (client.chats as any).create({
    model: modelName,
    config: {
      systemInstruction: systemPrompt,
      tools: [
        { functionDeclarations: allTools as any }
      ]
    },
    history
  });

  let currentPromptText: any = input.prompt;
  if (input.isScheduledTask) currentPromptText = `[SCHEDULED TASK]\n${currentPromptText}`;

  while (true) {
    try {
      log(`Querying Gemini (${modelName})...`);
      
      let parts: any[] = [];
      if (typeof currentPromptText === 'string' && currentPromptText.includes('<media')) {
        parts = parseMultimodalPrompt(currentPromptText);
      } else if (typeof currentPromptText === 'string') {
        parts = [{ text: currentPromptText }];
      } else if (Array.isArray(currentPromptText)) {
        parts = currentPromptText;
      }

      let result = await currentChat.sendMessage({
        message: parts
      });

      log(`Gemini response: ${JSON.stringify(result)}`);

      while (result.candidates?.[0]?.content?.parts?.some((p: any) => p.functionCall)) {
        const callParts = result.candidates[0].content.parts!.filter((p: any) => p.functionCall);
        log(`Processing ${callParts.length} parallel tool calls`);
        
        const responses = await Promise.all(callParts.map(async (part: any) => {
          const { name, args } = part.functionCall!;
          
          try {
            let output;
            if (mcpManager.isMcpTool(name!)) {
              output = await mcpManager.callTool(name!, args);
            } else {
              const fn = functions[name!];
              output = await Promise.resolve(fn ? fn(args) : `Error: Tool ${name} not found`);
            }

            return {
              functionResponse: { name, response: { content: output } }
            };
          } catch (err: any) {
            return {
              functionResponse: { name, response: { content: `Error: ${err.message}` } }
            };
          }
        }));
        
        result = await currentChat.sendMessage({
          message: responses as any
        });
      }

      const text = result.candidates?.[0]?.content?.parts
        ?.filter((p: any) => p.text)
        ?.map((p: any) => p.text)
        ?.join('\n') || '';
      
      writeOutput({ status: 'success', result: text });

      fs.mkdirSync(path.dirname(historyPath), { recursive: true });
      fs.writeFileSync(historyPath, JSON.stringify(currentChat.history));

      const IDLE_EXIT_TIMEOUT_MS = 600000; // 10 minutes
      let lastActivity = Date.now();

      while (true) {
        if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
          return;
        }
        if (!fs.existsSync(IPC_INPUT_DIR)) {
          fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
        }
        const files = fs.readdirSync(IPC_INPUT_DIR).filter(f => f.endsWith('.json')).sort();
        if (files.length > 0) {
          // Process messages one by one to ensure we don't lose them if Gemini crashes
          const file = files[0];
          const data = JSON.parse(fs.readFileSync(path.join(IPC_INPUT_DIR, file), 'utf-8'));
          if (data.type === 'message') {
            if (data.media) {
              currentPromptText = [{ text: data.text, inlineData: data.media }];
            } else {
              currentPromptText = data.text;
            }
          }
          fs.unlinkSync(path.join(IPC_INPUT_DIR, file));
          lastActivity = Date.now();
          break;
        }

        if (Date.now() - lastActivity > IDLE_EXIT_TIMEOUT_MS) {
          log('Idle timeout reached, exiting.');
          return;
        }

        await new Promise(r => setTimeout(r, IPC_POLL_MS));
      }
    } catch (err: any) {
      log(`Gemini Error: ${err.message}`);
      writeOutput({ status: 'error', result: null, error: err.message });
      await mcpManager.shutdown();
      return;
    }
  }
}

main();
