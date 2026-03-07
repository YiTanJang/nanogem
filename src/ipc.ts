import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  CONTAINER_IMAGE_BASE,
  DATA_DIR,
  IPC_POLL_INTERVAL,
  K8S_PVC_NAME,
  K8S_PVC_SUBPATH,
  MAIN_GROUP_FOLDER,
  REGISTRY_URL,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (
    jid: string,
    text: string,
    media?: { mimeType: string; data: string },
  ) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  deleteGroup: (jid: string) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  runBuildJob?: (
    imageTag: string,
    pvcName: string,
    pvcSubPath: string,
    dockerfilePath?: string,
    contextPath?: string,
    shouldRollout?: boolean,
    customJobName?: string,
  ) => Promise<{ status: 'success' | 'error'; error?: string }>;
  createDiscordThread?: (
    parentJid: string,
    name: string,
  ) => Promise<{ jid: string; url: string }>;
  deleteDiscordThread?: (jid: string) => Promise<void>;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process management tasks from this group's IPC directory FIRST
      // This ensures that if a group is registered and messaged in the same tick,
      // the registration is processed before the message is routed.
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Failsafe: delete BEFORE processing. 
              // If the task triggers a rollout (like rebuild_self), 
              // we don't want the file to be there when the new pod starts.
              fs.unlinkSync(filePath);
              await processTaskIpc(data, sourceGroup, isMain, deps);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }

      // Process messages AFTER tasks
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (
                data.type === 'message' &&
                data.chatJid &&
                (data.text !== undefined || data.media !== undefined)
              ) {
                // Authorization: verify this group can send to this chatJid
                // Reload fresh groups here to pick up newly registered specialists
                const currentRegisteredGroups = deps.registeredGroups();
                const targetGroup = currentRegisteredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(
                    data.chatJid,
                    data.text || '',
                    data.media,
                  );
                  logger.info(
                    { sourceGroup, targetJid: data.chatJid },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { sourceGroup, targetJid: data.chatJid, targetExists: !!targetGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    systemInstruction?: string;
    ephemeral?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For rebuild_self/build_project
    imageTag?: string;
    dockerfilePath?: string;
    contextPath?: string;
    shouldRollout?: boolean;
    timestamp?: string;
    resumptionPrompt?: string;
    // For Discord
    parentJid?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid interval');
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          if (data.schedule_value === 'now') {
            nextRun = new Date().toISOString();
          } else {
            const d = new Date(data.schedule_value);
            if (isNaN(d.getTime())) {
              logger.warn({ scheduleValue: data.schedule_value }, 'Invalid date');
              break;
            }
            nextRun = d.toISOString();
          }
        }

        const validContextModes = ['isolated', 'group'];
        const contextMode = data.context_mode && validContextModes.includes(data.context_mode) ? data.context_mode : 'isolated';

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        createTask({
          id: taskId,
          chat_jid: targetJid,
          group_folder: targetFolder,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
          context_mode: contextMode as any,
        });

        logger.info(
          { taskId, targetJid, scheduleType, nextRun },
          'Task created via IPC',
        );
      } else {
        logger.warn({ data }, 'Invalid schedule_task request - missing fields');
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (isMain || (task && task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (isMain || (task && task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (isMain || (task && task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
        }
      }
      break;

    case 'refresh_groups':
      if (isMain) {
        await deps.syncGroupMetadata(true);
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        const groupIpcDir = path.join(DATA_DIR, 'ipc', data.folder);
        fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
        fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
        fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });

        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          systemInstruction: data.systemInstruction,
          ephemeral: data.ephemeral,
        });

        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          isMain,
          availableGroups,
          new Set(Object.keys(deps.registeredGroups())),
        );
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'delete_group':
      // Only main group can delete groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized delete_group attempt blocked',
        );
        break;
      }
      if (data.jid) {
        logger.info({ jid: data.jid }, 'Deleting group via IPC');
        deps.deleteGroup(data.jid);

        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          isMain,
          availableGroups,
          new Set(Object.keys(deps.registeredGroups())),
        );
      } else {
        logger.warn(
          { data },
          'Invalid delete_group request - missing jid',
        );
      }
      break;

    case 'delete_discord_thread':
      if (isMain) {
        if (data.jid) {
          logger.info({ jid: data.jid }, 'Deleting sub-agent and Discord thread via IPC');
          // 1. Delete the logical agent and its files
          deps.deleteGroup(data.jid);
          
          // 2. Delete the physical thread on Discord
          if (deps.deleteDiscordThread && data.jid.startsWith('discord-')) {
            await deps.deleteDiscordThread(data.jid);
          }
          
          // Write updated snapshot immediately
          const availableGroups = deps.getAvailableGroups();
          deps.writeGroupsSnapshot(
            sourceGroup,
            isMain,
            availableGroups,
            new Set(Object.keys(deps.registeredGroups())),
          );

          await deps.sendMessage(sourceGroup, `Successfully deleted sub-agent and its Discord thread: ${data.jid}`);
        } else {
          logger.warn({ data }, 'Invalid delete_discord_thread request - missing jid');
        }
      } else {
        logger.warn({ sourceGroup }, 'Unauthorized delete_discord_thread attempt blocked');
      }
      break;

    case 'create_discord_thread':
      if (isMain && deps.createDiscordThread) {
        if (data.parentJid && data.name && data.folder && data.systemInstruction) {
          try {
            // 1. Create the physical thread on Discord
            const thread = await deps.createDiscordThread(data.parentJid, data.name);
            
            // 2. Setup IPC directories for the new group
            const groupIpcDir = path.join(DATA_DIR, 'ipc', data.folder);
            fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
            fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
            fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });

            // 3. Register the group in the database, linked to the thread JID
            deps.registerGroup(thread.jid, {
              name: data.name,
              folder: data.folder,
              trigger: data.trigger || '@NanoClaw', // Threads usually don't strictly need a trigger but good to have
              added_at: new Date().toISOString(),
              containerConfig: data.containerConfig,
              requiresTrigger: false, // DMs and Threads are exclusive contexts
              systemInstruction: data.systemInstruction,
              ephemeral: data.ephemeral ?? true, // Default to true for dynamic threads
            });

            // Update snapshot immediately so list_groups works
            const availableGroups = deps.getAvailableGroups();
            deps.writeGroupsSnapshot(
              sourceGroup,
              isMain,
              availableGroups,
              new Set(Object.keys(deps.registeredGroups())),
            );

            // 4. Report back to the main agent with the URL
            logger.info({ threadJid: thread.jid, url: thread.url }, 'Created dynamic Discord thread');
            const targetJid = data.chatJid || sourceGroup;
            await deps.sendMessage(targetJid, `Successfully created sub-agent thread: ${thread.url}\nAny messages in that thread will be routed to the '${data.folder}' agent.`);

          } catch (err) {
            logger.error({ err, data }, 'Failed to create Discord thread');
            const targetJid = data.chatJid || sourceGroup;
            await deps.sendMessage(targetJid, `Error creating Discord thread: ${err}`);
          }
        } else {
          logger.warn({ data }, 'Invalid create_discord_thread request - missing fields');
        }
      } else {
        logger.warn({ sourceGroup }, 'Unauthorized or unsupported create_discord_thread attempt');
      }
      break;

    case 'rebuild_self':
    case 'build_project':
      if (isMain && deps.runBuildJob) {
        const isSelf = data.type === 'rebuild_self';
        const defaultImage = isSelf ? `${REGISTRY_URL}/${CONTAINER_IMAGE_BASE}-agent:latest` : '';
        const imageTag = data.imageTag || defaultImage;
        const pvcName = K8S_PVC_NAME;
        const pvcSubPath = K8S_PVC_SUBPATH;
        
        // FORBID custom Dockerfiles/contexts for rebuild_self
        const dockerfilePath = isSelf ? 'Dockerfile' : (data.dockerfilePath || 'Dockerfile');
        const contextPath = isSelf ? '.' : (data.contextPath || '.');
        const shouldRollout = isSelf || !!data.shouldRollout;

        // If this is a self-rebuild, arm the autostart resurrection pulse
        if (isSelf) {
          const autostartDir = path.join(DATA_DIR, 'autostart');
          fs.mkdirSync(autostartDir, { recursive: true });
          
          // Find the actual JID for the main group
          const currentGroups = deps.registeredGroups();
          const mainJid = Object.keys(currentGroups).find(jid => currentGroups[jid].folder === MAIN_GROUP_FOLDER);
          
          fs.writeFileSync(
            path.join(autostartDir, `resurrect-${sourceGroup}.json`),
            JSON.stringify({ 
              chatJid: mainJid || 'main',
              prompt: data.resumptionPrompt 
            })
          );
        }

        // Use a deterministic job name based on the data if possible to prevent duplicates on recovery
        const jobSuffix = data.timestamp ? data.timestamp.replace(/[^a-zA-Z0-9]/g, '-') : Date.now();
        const customJobName = `nanoclaw-build-${jobSuffix}`.slice(0, 63).toLowerCase();

        if (isSelf) {
          logger.info({ imageTag, customJobName }, 'Rebuild self requested (Security Restricted Context)');
        } else {
          logger.info({ imageTag, contextPath, customJobName }, 'Build project requested');
        }
        
        const result = await deps.runBuildJob(imageTag, pvcName, pvcSubPath, dockerfilePath, contextPath, shouldRollout, customJobName);
        if (result.status === 'success') {
          logger.info({ type: data.type }, 'Kaniko build successful');
        } else {
          logger.error({ error: result.error, type: data.type }, 'Kaniko build failed');
        }
      } else {
        logger.warn(
          { sourceGroup, hasBuildTool: !!deps.runBuildJob },
          'Unauthorized rebuild/build attempt blocked',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
