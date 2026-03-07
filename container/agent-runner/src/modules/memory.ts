import fs from 'fs';
import path from 'path';
import { 
  CONTINUUM_DIR, 
  EPISODES_DIR, 
  ContainerInput 
} from './types.js';

/**
 * Loads the SOTA 2026 Cognitive Memory into the system prompt.
 * Uses lazy loading: snippets by default, full via recall_memory tool.
 */
export function loadCognitiveMemory(): string {
  let cognitiveMemory = '';
  
  // 1. Load Continuum Snippets (Semantic & Procedural Memory)
  const factsPath = path.join(CONTINUUM_DIR, 'facts.md');
  const workflowsPath = path.join(CONTINUUM_DIR, 'workflows.md');
  
  if (fs.existsSync(factsPath)) {
    const facts = fs.readFileSync(factsPath, 'utf-8');
    cognitiveMemory += `\n\n### ESTABLISHED FACTS (Semantic Memory - Snippet)\n${facts.slice(0, 2048)}${facts.length > 2048 ? '\n... (use recall_memory tool to see all facts)' : ''}`;
  }
  if (fs.existsSync(workflowsPath)) {
    const workflows = fs.readFileSync(workflowsPath, 'utf-8');
    cognitiveMemory += `\n\n### VERIFIED WORKFLOWS (Procedural Memory - Snippet)\n${workflows.slice(0, 2048)}${workflows.length > 2048 ? '\n... (use recall_memory tool to see all workflows)' : ''}`;
  }

  // 2. Load Episodes (Last 2 only by default for speed)
  if (fs.existsSync(EPISODES_DIR)) {
    const episodes = fs.readdirSync(EPISODES_DIR)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, 2);
    
    if (episodes.length > 0) {
      cognitiveMemory += `\n\n### RECENT EPISODES (Episodic Memory)`;
      for (const ep of episodes) {
        cognitiveMemory += `\n\n#### ${ep}\n${fs.readFileSync(path.join(EPISODES_DIR, ep), 'utf-8')}`;
      }
      cognitiveMemory += `\n\n(Use recall_memory('episodes') to see up to 10 past mission reports)`;
    }
  }

  return cognitiveMemory ? `\n\n--- LONG-TERM MEMORY ---\n${cognitiveMemory}\n--- END MEMORY ---` : '';
}

/**
 * Logic for the update_memory tool.
 */
export function updateMemory(category: 'facts' | 'workflows', content: string): string {
  try {
    fs.mkdirSync(CONTINUUM_DIR, { recursive: true });
    const filePath = path.join(CONTINUUM_DIR, `${category}.md`);
    fs.writeFileSync(filePath, content);
    return `Memory category '${category}' updated successfully.`;
  } catch (err: any) {
    return `Error updating memory: ${err.message}`;
  }
}

/**
 * Logic for the recall_memory tool.
 */
export function recallMemory(category: 'facts' | 'workflows' | 'episodes'): string {
  try {
    if (category === 'facts' || category === 'workflows') {
      const filePath = path.join(CONTINUUM_DIR, `${category}.md`);
      return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : `No ${category} found.`;
    }
    if (category === 'episodes') {
      if (!fs.existsSync(EPISODES_DIR)) return 'No episodes found.';
      const episodes = fs.readdirSync(EPISODES_DIR)
        .filter(f => f.endsWith('.md'))
        .sort()
        .reverse()
        .slice(0, 10);
      
      let context = '### RECENT EPISODES\n';
      for (const ep of episodes) {
        context += `\n#### ${ep}\n${fs.readFileSync(path.join(EPISODES_DIR, ep), 'utf-8')}`;
      }
      return context;
    }
    return 'Invalid category.';
  } catch (err: any) {
    return `Error recalling memory: ${err.message}`;
  }
}

/**
 * Automatically record a completed mission into episodic memory.
 */
export function recordEpisode(prompt: string, result: string): void {
  try {
    // 1. Save to Episodic Memory directory
    fs.mkdirSync(EPISODES_DIR, { recursive: true });
    const episodeFile = `episode-${Date.now()}.md`;
    const episodeContent = `## Mission Report: ${new Date().toISOString()}
**Task**: ${prompt.slice(0, 500)}...
**Result**: ${result}
**Status**: COMPLETED`;
    
    fs.writeFileSync(path.join(EPISODES_DIR, episodeFile), episodeContent);

    // 2. Backup to THOUGHTS.log in the group workspace for human readability
    try {
      const thoughtPath = path.join('/workspace/group', 'THOUGHTS.log');
      fs.appendFileSync(thoughtPath, `\n[${new Date().toISOString()}] [AGENT_RESPONSE]\n${result}\n`);
    } catch (err) {}
  } catch (e) {
    console.error(`[agent-runner] Failed to record episodic memory: ${e}`);
  }
}
