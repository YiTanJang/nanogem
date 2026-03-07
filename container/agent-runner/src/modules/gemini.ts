import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { ContainerInput, ContainerOutput, IPC_DIR, IPC_INPUT_CLOSE_SENTINEL, IPC_INPUT_DIR, IPC_POLL_MS } from './types.js';
import { McpManager } from './mcp.js';

export class GeminiManager {
  private client: any;
  private modelName: string;
  private chat: any;

  constructor(apiKey: string, modelName: string) {
    this.client = new (GoogleGenAI as any)({ apiKey });
    this.modelName = modelName;
  }

  async initChat(systemInstruction: string, history: any[], allTools: any[]) {
    this.chat = (this.client.chats as any).create({
      model: this.modelName,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: allTools }]
      },
      history
    });
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
        console.error(`[agent-runner] Querying Gemini (${this.modelName})...`);
        
        let parts: any[] = [];
        if (typeof currentPrompt === 'string' && currentPrompt.includes('<media')) {
          parts = this.parseMultimodalPrompt(currentPrompt);
        } else if (typeof currentPrompt === 'string') {
          parts = [{ text: currentPrompt }];
        } else {
          parts = currentPrompt;
        }

        let result = await this.chat.sendMessage({ message: parts });

        // Tool Loop
        while (result.candidates?.[0]?.content?.parts?.some((p: any) => p.functionCall)) {
          const callParts = result.candidates[0].content.parts!.filter((p: any) => p.functionCall);
          
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
              return { functionResponse: { name, response: { content: output } } };
            } catch (err: any) {
              return { functionResponse: { name, response: { content: `Error: ${err.message}` } } };
            }
          }));
          
          result = await this.chat.sendMessage({ message: responses as any });
        }

        const text = result.candidates?.[0]?.content?.parts
          ?.filter((p: any) => p.text)
          ?.map((p: any) => p.text)
          ?.join('\n') || '';
        
        onOutput({ status: 'success', result: text });

        // Persistence
        const historyPath = path.join('/workspace/group', '.nanogem', 'history.json');
        fs.mkdirSync(path.dirname(historyPath), { recursive: true });
        fs.writeFileSync(historyPath, JSON.stringify(this.chat.history));

        // Wait for follow-up
        currentPrompt = await this.waitForFollowUp();
        if (!currentPrompt) return; // Exit signal or timeout

      } catch (err: any) {
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
