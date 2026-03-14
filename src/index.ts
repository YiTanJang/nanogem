import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  MAIN_GROUP_FOLDER,
  TRIGGER_PATTERN,
  GEMINI_MODEL,
  DATA_DIR,
  getMcpConfig,
  DISCORD_BOT_TOKEN,
} from './config.js';
import { DiscordChannel } from './channels/discord.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  deleteRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  storeMessageDirect,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import * as k8sRuntime from './k8s-runtime.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  startSchedulerLoop,
  recoverQueuedTasks,
} from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  queue.setRegisteredGroups(registeredGroups);
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function updateLastAgentTimestamp(jid: string, ts: string): void {
  if (!lastAgentTimestamp[jid] || ts > lastAgentTimestamp[jid]) {
    lastAgentTimestamp[jid] = ts;
    saveState();
  }
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);
  queue.setRegisteredGroups(registeredGroups);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  if (group.agentIdentity) {
    fs.writeFileSync(path.join(groupDir, 'GEMINI.md'), group.agentIdentity);
  }
  logger.info({ jid, name: group.name, folder: group.folder }, 'Group registered');
}

export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));
  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/**
 * Route a message to an external channel (e.g. Discord).
 * This is for talking to HUMANS.
 */
async function sendToUser(jid: string, rawText: string, media?: any): Promise<void> {
  const channel = findChannel(channels, jid);
  if (channel) {
    const text = formatOutbound(rawText);
    if (text || media) {
      await channel.sendMessage(jid, text, media);
      // PERSISTENCE: Save the bot's own response so it appears in future history
      storeMessage({
        id: `bot-${Date.now()}`,
        chat_jid: jid,
        sender: 'bot',
        sender_name: ASSISTANT_NAME,
        content: rawText,
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: true,
      });
    }
    return;
  }
  logger.warn({ jid }, 'No channel owns JID, cannot send to user');
}

/**
 * Route a message to an internal agent.
 * This is for AGENT-TO-AGENT communication.
 */
async function sendToInternalAgent(jid: string, text: string): Promise<void> {
  const targetGroup = registeredGroups[jid] || getAllRegisteredGroups()[jid];
  if (!targetGroup) {
    if (jid.startsWith('internal-')) {
      logger.info({ jid }, 'Internal target deleted, dropping message');
    } else {
      logger.warn({ jid }, 'No internal agent for JID');
    }
    return;
  }

  // PERSISTENCE: Always store the message in the DB so it's in history
  storeMessageDirect({
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    chat_jid: jid,
    sender: 'system',
    sender_name: 'System',
    content: text,
    timestamp: new Date().toISOString(),
    is_from_me: false,
    is_bot_message: false,
  });

  // Pipe to active container if possible
  if (queue.sendMessage(jid, text, false)) {
    logger.debug({ jid }, 'Piped message to active container');
    updateLastAgentTimestamp(jid, new Date().toISOString());
    return;
  }

  logger.info({ jid, folder: targetGroup.folder }, 'Queued internal agent message via DB');
  queue.enqueueMessageCheck(jid);
}

async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME).filter(m => !m.is_from_me);
  if (missedMessages.length === 0) return true;

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
  const isInternal = chatJid.startsWith('internal-');
  const needsTrigger = group.requiresTrigger ?? (!isMainGroup && !isInternal);
if (needsTrigger) {
  const hasBotFlag = missedMessages.some((m) => m.is_bot_message);
  const isInternalTarget = chatJid.startsWith('internal-');
  const isDiscord = chatJid.startsWith('discord-');
  const hasTriggerPattern = (isInternalTarget || isDiscord) && missedMessages.some((m) => TRIGGER_PATTERN.test(m.content));

  if (!hasBotFlag && !hasTriggerPattern) {
    updateLastAgentTimestamp(chatJid, missedMessages[missedMessages.length - 1].timestamp);
    return true;
  }
}

  const prompt = formatMessages(missedMessages);
  logger.info({ group: group.name, messageCount: missedMessages.length }, 'Processing messages');

  const channel = findChannel(channels, chatJid);
  await channel?.setTyping?.(chatJid, true);

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      if (text) {
        await sendToUser(chatJid, text);
      }
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }
  });

  await channel?.setTyping?.(chatJid, false);

  if (output === 'success') {
    updateLastAgentTimestamp(chatJid, missedMessages[missedMessages.length - 1].timestamp);
  }
  return true;
}

export async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  let model = GEMINI_MODEL;
  const modelMatch = prompt.match(/\[model:([\w.\-]+)\]/i);
  if (modelMatch) {
    model = modelMatch[1];
    prompt = prompt.replace(modelMatch[0], '').trim();
  }

  writeTasksSnapshot(group.folder, isMain, getAllTasks().map(t => ({
    id: t.id, groupFolder: t.group_folder, prompt: t.prompt, schedule_type: t.schedule_type,
    schedule_value: t.schedule_value, status: t.status, next_run: t.next_run
  })));
  writeGroupsSnapshot(group.folder, isMain, getAvailableGroups(), new Set(Object.keys(registeredGroups)));

  const wrappedOnOutput = onOutput ? async (output: ContainerOutput) => {
    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }
    await onOutput(output);
  } : undefined;

  try {
    const output = await runContainerAgent(group, {
      prompt, sessionId, groupFolder: group.folder, chatJid, isMain,
      assistantName: ASSISTANT_NAME, model, mcpConfig: getMcpConfig(),
    }, 
    (proc, podName) => queue.registerProcess(chatJid, proc, podName, group.folder),
    wrappedOnOutput);

    return output.status === 'success' ? 'success' : 'error';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent execution failed');
    return 'error';
  }
}

function recoverPendingMessages(): void {
  const startupTime = new Date();
  const backlogThreshold = new Date(startupTime.getTime() - 60000).toISOString();

  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    
    if (pending.length > 0) {
      const shouldRecover = pending.some(m => m.timestamp > backlogThreshold || m.sender === 'system');
      
      if (!shouldRecover) {
        logger.info({ group: group.name, count: pending.length }, 'Advancing timestamp for old backlog on startup');
        updateLastAgentTimestamp(chatJid, pending[pending.length - 1].timestamp);
        continue;
      }

      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
  queue.setRegisteredGroups(groups);
}

async function main(): Promise<void> {
  console.log("--- KANIKO_EVOLUTION_SUCCESS ---");
  await k8sRuntime.ensureK8sReady();
  const orphanedNames = await k8sRuntime.cleanupOrphans();
  if (orphanedNames.length > 0) {
    logger.info({ count: orphanedNames.length, names: orphanedNames }, 'Stopped orphaned agent pods');
    // Safety: ensure queue knows these groups are no longer active
    for (const jid of Object.keys(registeredGroups)) {
      queue.notifyIdle(jid);
    }
  }
  initDatabase();
  loadState();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => {
      storeMessage(msg);
      if (registeredGroups[_chatJid] && queue.sendMessage(_chatJid, msg.content, msg.is_bot_message)) {
        updateLastAgentTimestamp(_chatJid, msg.timestamp);
        return;
      }
      queue.enqueueMessageCheck(_chatJid);
    },
    onChatMetadata: (jid: string, ts: string, name?: string, ch?: string, isG?: boolean) => 
      storeChatMetadata(jid, ts, name, ch, isG),
    registeredGroups: () => registeredGroups,
  };

  let discord: DiscordChannel | undefined;
  if (DISCORD_BOT_TOKEN) {
    discord = new DiscordChannel({ ...channelOpts, token: DISCORD_BOT_TOKEN });
    channels.push(discord);
    discord.connect().catch(err => logger.error({ err }, 'Failed to connect to Discord'));
  }

  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (jid, proc, name, folder) => queue.registerProcess(jid, proc, name, folder),
    sendMessage: (jid, text) => {
      const isInternal = jid.startsWith('internal-') || registeredGroups[jid];
      return isInternal ? sendToInternalAgent(jid, text) : sendToUser(jid, text);
    },
  });

  startIpcWatcher({
    sendMessage: (jid, text) => {
      const isInternal = jid.startsWith('internal-') || registeredGroups[jid];
      return isInternal ? sendToInternalAgent(jid, text) : sendToUser(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    deleteGroup: (jid) => {
      const group = registeredGroups[jid];
      if (!group) return;
      if (group.folder === MAIN_GROUP_FOLDER) {
        logger.warn({ jid }, 'Attempted to delete protected main group blocked');
        return;
      }
      if (group.ephemeral) fs.rmSync(resolveGroupFolderPath(group.folder), { recursive: true, force: true });
      deleteRegisteredGroup(jid);
      delete registeredGroups[jid];
      queue.setRegisteredGroups(registeredGroups);
      saveState();
    },
    syncGroupMetadata: (force) => Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
    runBuildJob: k8sRuntime.runBuildJob,
    createDiscordThread: discord
      ? (parentJid: string, name: string) => discord!.createThread(parentJid, name)
      : undefined,
    deleteDiscordThread: discord
      ? async (jid) => {
          const group = registeredGroups[jid];
          await discord!.deleteThread(jid);
          if (group) { // Only attempt to delete internal registration if it exists
              if (group.ephemeral) fs.rmSync(resolveGroupFolderPath(group.folder), { recursive: true, force: true });
              deleteRegisteredGroup(jid);
              delete registeredGroups[jid];
              queue.setRegisteredGroups(registeredGroups);
              saveState();
          }
        }
      : undefined,
  });

  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  recoverQueuedTasks({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (jid, proc, name, folder) => queue.registerProcess(jid, proc, name, folder),
    sendMessage: (jid, text) => {
      const isInternal = jid.startsWith('internal-') || registeredGroups[jid];
      return isInternal ? sendToInternalAgent(jid, text) : sendToUser(jid, text);
    },
  });

  const autostartDir = path.join(DATA_DIR, 'autostart');
  if (fs.existsSync(autostartDir)) {
    const files = fs.readdirSync(autostartDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(autostartDir, file);
      try {
        const taskData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (taskData.chatJid) {
          if (taskData.prompt) {
            storeMessageDirect({
              id: `msg-autostart-${Date.now()}`, chat_jid: taskData.chatJid,
              sender: 'system', sender_name: 'System', content: taskData.prompt,
              timestamp: new Date().toISOString(), is_from_me: false, is_bot_message: false,
            });
          }
          queue.enqueueMessageCheck(taskData.chatJid);
        }
        fs.unlinkSync(filePath);
      } catch (err) {
        logger.error({ file, err }, 'Failed to process autostart task');
      }
    }
  }

  logger.info(`NanoGem running (trigger: @${ASSISTANT_NAME})`);
}

const isDirectRun = process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;
if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoGem');
    process.exit(1);
  });
}
