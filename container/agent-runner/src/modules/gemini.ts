import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { ContainerInput, ContainerOutput, IPC_DIR, IPC_INPUT_CLOSE_SENTINEL, IPC_INPUT_DIR, IPC_POLL_MS } from './types.js';
import { McpManager } from './mcp.js';

export class GeminiManager {
  public client: any;
  private modelName: string;
  private chat: any;
  private cachedContentName: string | undefined;

  constructor(apiKey: string, modelName: string) {
    this.client = new (GoogleGenAI as any)({ apiKey });
    this.modelName = modelName;
  }

  /**
   * Creates an explicit context cache for static, high-volume content.
   * Requires at least 32,768 tokens.
   */
  async createCache(displayName: string, systemInstruction: string, largeText: string): Promise<string> {
    const cache = await (this.client as any).caches.create({
      model: this.modelName,
      config: {
        displayName,
        systemInstruction,
        contents: [
          {
            role: "user",
            parts: [{ text: largeText }]
          }
        ],
        ttlSeconds: 3600, // 1 hour default
      },
    });
    this.cachedContentName = cache.name;
    return cache.name;
  }

  async initChat(agentIdentity: string, history: any[], allTools: any[]) {
    // DEBUG: Verify the exact tool schema being passed to the model
    const createThreadTool = allTools.find(t => t.name === 'create_discord_thread');
    if (createThreadTool) {
      console.error(`[debug-schema] create_discord_thread: ${JSON.stringify(createThreadTool.parameters.properties)}`);
    }

    const config: any = {
      systemInstruction: agentIdentity,
      tools: [{ functionDeclarations: allTools }]
    };

    if (this.cachedContentName) {
      config.cachedContent = this.cachedContentName;
    }

    this.chat = (this.client.chats as any).create({
      model: this.modelName,
      config,
      history
    });
  }

  private logTelemetry(text: string) {
    // Continuous output to stderr for real-time visibility in 'kubectl logs -f'
    console.error(`[TELEMETRY] ${text}`);
  }

  async runLoop(
    initialPrompt: string | any[],
    functions: Record<string, (args: any) => Promise<string> | string>,
    mcpManager: McpManager,
    onOutput: (output: ContainerOutput) => void
  ) {
    let currentPrompt: any = initialPrompt;

    while (true) {
      try {
        this.logTelemetry(`--- QUERYING GEMINI (${this.modelName}) ---`);
        
        let parts: any[] = [];
        if (typeof currentPrompt === 'string' && currentPrompt.includes('<media')) {
          parts = this.parseMultimodalPrompt(currentPrompt);
        } else if (typeof currentPrompt === 'string') {
          parts = [{ text: currentPrompt }];
        } else {
          parts = currentPrompt;
        }

        let result = await this.chat.sendMessage({ message: parts });

        // Continuous Tool & Thought Loop
        while (true) {
          const candidate = result.candidates?.[0];
          const responseParts = candidate?.content?.parts || [];

          // 1. Stream System Telemetry
          for (const part of responseParts) {
            if (part.text) {
              this.logTelemetry(`[THOUGHT] ${part.text}`);
            }
            if ((part as any).thought) {
              this.logTelemetry(`[REASONING] ${(part as any).thought}`);
            }
          }

          // 2. Identify and Log Tool Calls
          const callParts = responseParts.filter((p: any) => p.functionCall);
          if (callParts.length === 0) break; // turn finished

          const responses = await Promise.all(callParts.map(async (part: any) => {
            const { name, args } = part.functionCall!;
            this.logTelemetry(`[TOOL_CALL] ${name}(${JSON.stringify(args)})`);
            
            try {
              let output;
              if (mcpManager.isMcpTool(name!)) {
                output = await mcpManager.callTool(name!, args);
              } else {
                const fn = functions[name!];
                output = await Promise.resolve(fn ? fn(args) : `Error: Tool ${name} not found`);
              }
              
              const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
              this.logTelemetry(`[TOOL_RESULT] ${name} -> ${outputStr.substring(0, 500)}${outputStr.length > 500 ? '...' : ''}`);
              
              return { functionResponse: { name, response: { content: output } } };
            } catch (err: any) {
              this.logTelemetry(`[TOOL_ERROR] ${name} -> ${err.message}`);
              return { functionResponse: { name, response: { content: `Error: ${err.message}` } } };
            }
          }));
          
          result = await this.chat.sendMessage({ message: responses as any });
        }

        const finalText = result.candidates?.[0]?.content?.parts
          ?.filter((p: any) => p.text)
          ?.map((p: any) => p.text)
          ?.join('\n') || '';
        
        this.logTelemetry(`[FINAL_RESPONSE] ${finalText.substring(0, 100)}...`);
        
        // Use a tiny delay to ensure stderr buffer clears before stdout markers start
        await new Promise(r => setTimeout(r, 10));
        
        onOutput({ status: 'success', result: finalText });

        // Persistence
        const historyPath = path.join('/workspace/group', '.nanogem', 'history.json');
        fs.mkdirSync(path.dirname(historyPath), { recursive: true });
        fs.writeFileSync(historyPath, JSON.stringify(this.chat.history));

        // Wait for follow-up
        currentPrompt = await this.waitForFollowUp();
        if (!currentPrompt) return; 

      } catch (err: any) {
        this.logTelemetry(`[CRITICAL_ERROR] ${err.message}`);
        onOutput({ status: 'error', result: null, error: err.message });
        return;
      }
    }
  }

  private parseMultimodalPrompt(prompt: string): any[] {
    const parts: any[] = [];
    const mediaRegex = /<media\s+mimeType="([^"]+)"\s+data="([^"]+)"\s*\/>/g;
    let lastIndex = 0;
    let match;

    while ((match = mediaRegex.exec(prompt)) !== null) {
      const textBefore = prompt.substring(lastIndex, match.index);
      if (textBefore) parts.push({ text: textBefore });
      parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
      lastIndex = match.index + match[0].length;
    }

    const textAfter = prompt.substring(lastIndex);
    if (textAfter) parts.push({ text: textAfter });
    return parts.length > 0 ? parts : [{ text: prompt }];
  }

  private async waitForFollowUp(): Promise<any | null> {
    const IDLE_EXIT_TIMEOUT_MS = 600000;
    let lastActivity = Date.now();

    while (true) {
      if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) return null;
      
      if (fs.existsSync(IPC_INPUT_DIR)) {
        const files = fs.readdirSync(IPC_INPUT_DIR).filter(f => f.endsWith('.json')).sort();
        if (files.length > 0) {
          const file = files[0];
          const data = JSON.parse(fs.readFileSync(path.join(IPC_INPUT_DIR, file), 'utf-8'));
          fs.unlinkSync(path.join(IPC_INPUT_DIR, file));
          if (data.type === 'message') {
            return data.media ? [{ text: data.text, inlineData: data.media }] : data.text;
          }
        }
      }

      if (Date.now() - lastActivity > IDLE_EXIT_TIMEOUT_MS) {
        try {
          const sentinelPath = path.join(IPC_DIR, `exit-${Date.now()}.json`);
          fs.writeFileSync(sentinelPath, JSON.stringify({ type: 'exit', reason: 'idle_timeout' }));
        } catch (e) {}
        return null;
      }
      await new Promise(r => setTimeout(r, IPC_POLL_MS));
    }
  }
}
