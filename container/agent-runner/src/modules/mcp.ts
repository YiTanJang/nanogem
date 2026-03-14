import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export class McpManager {
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
            transport = new StreamableHTTPClientTransport(url, {
              requestInit: token ? {
                headers: { 'Authorization': `Bearer ${token}` }
              } : undefined,
            });
          } else {
            if (token) url.searchParams.set('token', token);
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
          continue;
        }

        const client = new Client(
          { name: 'nanogem-agent', version: '1.0.0' },
          { capabilities: {} }
        );

        await Promise.race([
          client.connect(transport),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
        ]);
        
        this.clients.set(name, client);

        const { tools } = await Promise.race([
          client.listTools(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
        ]) as any;

        for (const tool of tools) {
          this.toolToClient.set(tool.name, name);
          const schema = tool.inputSchema as any;
          this.mcpTools.push({
            name: tool.name,
            description: tool.description,
            parameters: {
              type: 'OBJECT',
              properties: schema?.properties || {},
              required: schema?.required || [],
            },
          });
        }
      } catch (err: any) {
        console.error(`[agent-runner] Failed to connect to MCP server ${name}: ${err.message}`);
      }
    }
  }

  getToolDeclarations() {
    return this.mcpTools;
  }

  async callTool(name: string, args: any) {
    const serverName = this.toolToClient.get(name);
    if (!serverName) throw new Error(`Tool ${name} not found`);
    
    const client = this.clients.get(serverName);
    if (!client) throw new Error(`Client ${serverName} not found`);

    const result = await client.callTool({ name, arguments: args }) as any;
    const textParts = result.content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text);
    
    return textParts.join('\n') || 'Success.';
  }

  isMcpTool(name: string) {
    return this.toolToClient.has(name);
  }

  async shutdown() {
    for (const client of this.clients.values()) {
      try {
        await client.close();
      } catch (err) {}
    }
  }
}
