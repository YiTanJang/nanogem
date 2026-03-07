/**
 * NanoGem Agent Runner (Refactored)
 * Slim entry point that coordinates specialized modules.
 */

import fs from 'fs';
import path from 'path';
import { 
  ContainerInput, 
  ContainerOutput, 
  OUTPUT_START_MARKER, 
  OUTPUT_END_MARKER,
  IPC_DIR
} from './modules/types.js';
import { loadCognitiveMemory, recordEpisode } from './modules/memory.js';
import { getFunctions, getToolDeclarations } from './modules/tools.js';
import { McpManager } from './modules/mcp.js';
import { GeminiManager } from './modules/gemini.js';

function writeOutput(output: ContainerOutput): void {
  const json = JSON.stringify(output);
  console.log(OUTPUT_START_MARKER);
  console.log(json);
  console.log(OUTPUT_END_MARKER);

  // Backup to IPC for poller
  try {
    const resultFile = `result-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
    const resultPath = path.join(IPC_DIR, resultFile);
    fs.writeFileSync(resultPath, json);
  } catch (err) {
    console.error(`[agent-runner] Failsafe write failed: ${err}`);
  }
}

function formatRolePrompt(instruction: string): string {
  if (!instruction.includes('# Role') && !instruction.includes('# Goal')) return instruction;
  return `You are an autonomous agent with a specific role and goal.\n\n${instruction}\n\nAlways maintain your defined persona and prioritize your specified goal.`;
}

async function main(): Promise<void> {
  // 1. Read Input
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

  // 2. Initialize Managers
  const modelName = input.model || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const mcpManager = new McpManager();
  const geminiManager = new GeminiManager(apiKey, modelName);

  await mcpManager.initialize(input.mcpConfig);

  // 3. Construct System Prompt
  const globalMdPath = '/workspace/global/GEMINI.md';
  const groupMdPath = '/workspace/group/GEMINI.md';
  const missionPath = path.join('/workspace/group', '.nanogem', 'mission.json');

  const now = new Date();
  const timeContext = `\n\n### TEMPORAL CONTEXT\nCurrent Time: ${now.toLocaleString('en-US', { timeZone: process.env.TZ || 'UTC' })}\nTimezone: ${process.env.TZ || 'UTC'}`;

  let systemPrompt = `You are ${input.assistantName || 'Andy'}, an autonomous AI agent running in a Kubernetes pod.${timeContext}`;

  if (fs.existsSync(groupMdPath)) {
    systemPrompt = formatRolePrompt(fs.readFileSync(groupMdPath, 'utf-8'));
  } else if (fs.existsSync(globalMdPath)) {
    systemPrompt += `\n\nGlobal Context:\n${fs.readFileSync(globalMdPath, 'utf-8')}`;
  }

  // Inject Lazy Cognitive Memory
  const cognitiveMemory = loadCognitiveMemory();
  systemPrompt += cognitiveMemory;

  // MISSION INJECTION
  if (fs.existsSync(missionPath)) {
    try {
      const mission = JSON.parse(fs.readFileSync(missionPath, 'utf-8'));
      systemPrompt = `### CURRENT MISSION (PRIORITY 1)\nTASK: ${mission.task}\nEXPECTED: ${mission.expectedOutput}\n\n${systemPrompt}`;
    } catch (e) {}
  }

  // 4. CONTEXT CACHING (YOLO Implementation)
  // If the total context is large (approx > 32k tokens), we cache it.
  // We use a rough heuristic: 1 token ~= 4 characters.
  const ESTIMATED_TOKENS = (systemPrompt.length + cognitiveMemory.length) / 4;
  if (ESTIMATED_TOKENS > 32768) {
    try {
      console.error(`[agent-runner] Context is large (~${Math.round(ESTIMATED_TOKENS)} tokens). Creating remote cache...`);
      await geminiManager.createCache(
        `nanogem-${input.groupFolder}-${Date.now()}`,
        systemPrompt,
        "Memory and system context cached for performance."
      );
    } catch (err) {
      console.error(`[agent-runner] Cache creation failed (falling back to standard prompt): ${err}`);
    }
  }

  // 5. Load History
  const historyPath = path.join('/workspace/group', '.nanogem', 'history.json');
  let history: any[] = [];
  if (fs.existsSync(historyPath)) {
    try {
      const rawHistory = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
      history = rawHistory.filter((h: any) => h.role === 'user' || h.role === 'model');
    } catch {}
  }

  // 5. Start Chat Session
  const allTools = [...getToolDeclarations(), ...mcpManager.getToolDeclarations()];
  const functions = getFunctions(input, geminiManager as any, modelName);

  await geminiManager.initChat(systemPrompt, history, allTools);

  // 6. Run Execution Loop
  let initialPrompt = input.prompt;
  if (input.isScheduledTask) initialPrompt = `[SCHEDULED TASK]\n${initialPrompt}`;

  await geminiManager.runLoop(
    initialPrompt,
    functions as any,
    mcpManager,
    (output) => {
      writeOutput(output);
      if (output.status === 'success' && output.result) {
        recordEpisode(input.prompt, output.result);
      }
    }
  );

  await mcpManager.shutdown();
}

main().catch(err => {
  console.error(`[agent-runner] Fatal error: ${err}`);
  process.exit(1);
});
