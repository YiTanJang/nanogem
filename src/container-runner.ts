/**
 * Container Runner for NanoGem
 * Spawns agent execution in Kubernetes pods and handles IPC
 */
import fs from 'fs';
import path from 'path';
import * as k8s from '@kubernetes/client-node';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  K8S_NAMESPACE,
  K8S_PVC_NAME,
  K8S_PVC_SUBPATH,
  GEMINI_MODEL,
} from './config.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import * as k8sRuntime from './k8s-runtime.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
let k8sApi: k8s.CoreV1Api | undefined;

function getK8sApi() {
  if (!k8sApi) k8sApi = kc.makeApiClient(k8s.CoreV1Api);
  return k8sApi;
}

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOGEM_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOGEM_OUTPUT_END---';

export interface ContainerInput {
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

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .gemini/) are mounted separately below.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Selective Self-Improvement (READ-WRITE)
    mounts.push({
      hostPath: path.join(projectRoot, 'src'),
      containerPath: '/workspace/project/src',
      readonly: false,
    });
    mounts.push({
      hostPath: path.join(projectRoot, 'container/agent-runner/src'),
      containerPath: '/workspace/project/container/agent-runner/src',
      readonly: false,
    });

    // Main group folder (READ-WRITE)
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Mount all groups directory read-only so they can see each other's reports/thoughts
    const groupsRoot = path.join(projectRoot, 'groups');
    mounts.push({
      hostPath: groupsRoot,
      containerPath: '/workspace/project/groups',
      readonly: true,
    });

    // Mount source code read-write for auto-evolution
    mounts.push({
      hostPath: path.join(projectRoot, 'src'),
      containerPath: '/workspace/project/src',
      readonly: false,
    });
    mounts.push({
      hostPath: path.join(projectRoot, 'container/agent-runner/src'),
      containerPath: '/workspace/project/container/agent-runner/src',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Gemini sessions directory
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.gemini',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  
  // Sync skills from container/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.gemini',
    readonly: false,
  });

  // Per-group IPC namespace
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  const inputDir = path.join(groupIpcDir, 'input');
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(inputDir, { recursive: true });

  // Clear stale follow-up messages
  try {
    const files = fs.readdirSync(inputDir);
    for (const file of files) {
      if (file.endsWith('.json') || file === '_close') {
        fs.unlinkSync(path.join(inputDir, file));
      }
    }
  } catch (err) {
    logger.warn({ group: group.name, err }, 'Failed to clear IPC input directory');
  }

  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Per-group agent-runner source
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (!fs.existsSync(groupAgentRunnerDir) && fs.existsSync(agentRunnerSrc)) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Base runner directory
  mounts.push({
    hostPath: path.join(projectRoot, 'container', 'agent-runner'),
    containerPath: '/app',
    readonly: true,
  });

  // Additional mounts validated against external allowlist
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: any, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const mounts = buildVolumeMounts(group, input.isMain);
  const projectRoot = process.cwd();

  return runAgentPod(group, input, onProcess, onOutput, mounts, projectRoot);
}

async function runAgentPod(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: any, podName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  mounts: VolumeMount[] = [],
  projectRoot: string = process.cwd(),
): Promise<ContainerOutput> {
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
  const podName = `nanogem-agent-${safeName}-${Date.now()}`;

  logger.info({ group: group.name, podName }, 'Creating agent pod');

  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });

  const podSpec: k8s.V1Pod = {
    metadata: {
      name: podName,
      labels: {
        app: 'nanogem-agent',
        'app.kubernetes.io/managed-by': 'nanogem',
        'nanogem.io/group': safeName,
      },
    },
    spec: {
      restartPolicy: 'Never',
      containers: [
        {
          name: 'agent',
          image: CONTAINER_IMAGE,
          imagePullPolicy: 'Always',
          env: [
            {
              name: 'GEMINI_API_KEY',
              valueFrom: {
                secretKeyRef: {
                  name: 'nanogem-secrets',
                  key: 'GEMINI_API_KEY',
                },
              },
            },
            {
              name: 'NANOGEM_INPUT',
              value: Buffer.from(JSON.stringify(input)).toString('base64'),
            },
            {
              name: 'NANOGEM_CHAT_JID',
              value: input.chatJid,
            },
            {
              name: 'NANOGEM_GROUP_FOLDER',
              value: input.groupFolder,
            },
            {
              name: 'NANOGEM_IS_MAIN',
              value: input.isMain ? '1' : '0',
            },
            {
              name: 'GEMINI_MODEL',
              value: input.model || GEMINI_MODEL,
            },
            ],
            command: ['/bin/sh', '-c'],
            args: ['echo "$NANOGEM_INPUT" | /app/entrypoint.sh'],
          volumeMounts: [
            ...mounts.map((m) => ({
              name: 'agent-storage',
              mountPath: m.containerPath,
              subPath: m.hostPath.startsWith(projectRoot) 
                ? path.join(K8S_PVC_SUBPATH, path.relative(projectRoot, m.hostPath))
                : undefined,
              readOnly: m.readonly,
            })),
          ],
        },
      ],
      volumes: [
        {
          name: 'agent-storage',
          persistentVolumeClaim: {
            claimName: K8S_PVC_NAME,
          },
        },
      ],
      securityContext: {
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
      },
      nodeSelector: process.env.K8S_NODE_SELECTOR
        ? JSON.parse(process.env.K8S_NODE_SELECTOR)
        : undefined,
    },
  };

  const exitListeners: (() => void)[] = [];
  let _resolvePod: () => void = () => {};

  try {
    await Promise.race([
      k8sRuntime.runAgentPod(podSpec),
      new Promise((_, reject) => setTimeout(() => reject(new Error('K8s pod creation timed out after 30s')), 30000))
    ]);

    onProcess(
      {
        kill: () => _resolvePod(),
        stdin: { write: () => {}, end: () => {} },
        on: (event: string, listener: () => void) => {
          if (event === 'exit') exitListeners.push(listener);
        },
      },
      podName,
    );

    let hadStreamingOutput = false;
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    const logStream = new k8s.Log(kc);
    const logSink = new (await import('stream')).PassThrough();

    let podStatus = 'Pending';
    for (let i = 0; i < 30; i++) {
      const res = await getK8sApi().readNamespacedPodStatus({
        name: podName,
        namespace: K8S_NAMESPACE,
      });
      podStatus = res.status?.phase || 'Unknown';
      if (podStatus !== 'Pending') break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    let buffer = '';
    let firstOutputResolved = false;
    let _resolveFirstOutput: (output: ContainerOutput) => void;

    const firstOutputPromise = new Promise<ContainerOutput>((resolve) => {
      _resolveFirstOutput = resolve;
    });

    const resolveFirstOutput = (parsed: ContainerOutput) => {
      if (firstOutputResolved) return;
      firstOutputResolved = true;
      _resolveFirstOutput(parsed);
    };

    const processedResults = new Set<string>();
    const safeOnOutput = async (parsed: ContainerOutput) => {
      if (!onOutput) return;
      const key = JSON.stringify(parsed);
      if (processedResults.has(key)) return;
      processedResults.add(key);
      if (processedResults.size > 50) {
        const first = processedResults.values().next().value;
        if (first !== undefined) processedResults.delete(first);
      }
      await onOutput(parsed);
    };

    logSink.on('data', (chunk: Buffer) => {
      const data = chunk.toString();
      buffer += data;
      let startIdx: number;
      while ((startIdx = buffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
        const endIdx = buffer.indexOf(OUTPUT_END_MARKER, startIdx);
        if (endIdx === -1) break;
        const jsonStr = buffer
          .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
          .trim();
        buffer = buffer.slice(endIdx + OUTPUT_END_MARKER.length);
        try {
          const parsed: ContainerOutput = JSON.parse(jsonStr);
          if (parsed.newSessionId) newSessionId = parsed.newSessionId;
          hadStreamingOutput = true;
          
          outputChain = outputChain.then(() => safeOnOutput(parsed));
          resolveFirstOutput(parsed);
        } catch (err) {
          logger.warn({ err }, 'Failed to parse streamed K8s output');
        }
      }
    });

    try {
      logSink.on('error', (err) => logger.warn({ err, podName }, 'Log sink error'));
      logStream.log(
        K8S_NAMESPACE,
        podName,
        'agent',
        logSink,
        { follow: true },
      ).catch(err => logger.debug({ err, podName }, 'Log stream ended or failed'));
    } catch (err) {
      logger.debug({ err, podName }, 'Failed to start log stream');
    }

    const podCompletionPromise = (async () => {
      const startTime = Date.now();
      const MAX_POD_LIFE = 1800000;

      // Real-time Watcher: Listen for the 'exit' sentinel in the IPC folder
      const fsWatcher = fs.watch(groupIpcDir, (eventType, filename) => {
        if (filename && filename.startsWith('exit-') && filename.endsWith('.json')) {
          logger.info({ podName, filename }, 'Agent brain exit sentinel detected');
          try {
            fs.unlinkSync(path.join(groupIpcDir, filename));
          } catch (e) {}
          fsWatcher.close();
          _resolvePod();
        }
      });

      // Backup: Still check pod lifecycle events directly from K8s API
      const watch = new k8s.Watch(kc);
      let watchRequest: any;

      const watchPromise = new Promise<void>((resolve) => {
        watch.watch(
          `/api/v1/namespaces/${K8S_NAMESPACE}/pods`,
          { fieldSelector: `metadata.name=${podName}` },
          (type, obj) => {
            const status = obj.status?.phase;
            if (status === 'Succeeded' || status === 'Failed') {
              logger.debug({ podName, status }, 'Pod watch detected completion');
              if (watchRequest) watchRequest.abort();
              fsWatcher.close();
              _resolvePod();
            }
          },
          (err) => {
            if (err) logger.debug({ err, podName }, 'Pod watch ended');
            _resolvePod();
          }
        ).then(req => { watchRequest = req; });
      });

      // Periodic backup poller for results and max life
      const backupInterval = setInterval(() => {
        if (fs.existsSync(groupIpcDir)) {
          const files = fs.readdirSync(groupIpcDir);
          
          // Check for missed results
          const resultFiles = files.filter(f => f.startsWith('result-') && f.endsWith('.json')).sort();
          for (const file of resultFiles) {
            const resultPath = path.join(groupIpcDir, file);
            try {
              const content = fs.readFileSync(resultPath, 'utf-8');
              const parsed = JSON.parse(content);
              fs.unlinkSync(resultPath);
              logger.info({ podName, file }, 'Result received via fallback poller');
              outputChain = outputChain.then(() => safeOnOutput(parsed));
              resolveFirstOutput(parsed);
            } catch (err) {}
          }

          // Check for missed exit sentinels
          const exitFile = files.find(f => f.startsWith('exit-'));
          if (exitFile) {
            logger.info({ podName, exitFile }, 'Exit sentinel found by poller');
            try {
              fs.unlinkSync(path.join(groupIpcDir, exitFile));
            } catch (e) {}
            fsWatcher.close();
            _resolvePod();
          }
        }

        if (Date.now() - startTime > MAX_POD_LIFE) {
          logger.warn({ podName }, 'Pod reached max life, killing');
          if (watchRequest) watchRequest.abort();
          fsWatcher.close();
          _resolvePod();
        }
      }, 5000);

      await watchPromise;
      clearInterval(backupInterval);
      fsWatcher.close();

      // Master Cleanup: The ONLY place where the pod is deleted.
      try {
        await k8sRuntime.stopPod(podName);
      } catch (err) {}

      if (!firstOutputResolved) {
        try {
          const logRes = await getK8sApi().readNamespacedPodLog({
            name: podName,
            namespace: K8S_NAMESPACE,
          });
          const logs = logRes;
          const startIdx = logs.indexOf(OUTPUT_START_MARKER);
          const endIdx = logs.indexOf(OUTPUT_END_MARKER);

          if (startIdx !== -1 && endIdx !== -1) {
            const jsonStr = logs.slice(startIdx + OUTPUT_START_MARKER.length, endIdx).trim();
            const parsed = JSON.parse(jsonStr) as ContainerOutput;
            resolveFirstOutput(parsed);
            return parsed;
          }
        } catch (err) {
          logger.error({ err, podName }, 'Failed to read final pod logs');
        }
        const errResult: ContainerOutput = { status: 'error', result: null, error: 'Pod finished without output markers' };
        resolveFirstOutput(errResult);
        return errResult;
      }
      return null;
    })();

    podCompletionPromise
      .then(() => {
        logger.debug({ podName }, 'Pod completion promise resolved, triggering exit listeners');
        exitListeners.forEach(l => l());
      })
      .catch(err => {
        logger.debug({ err, podName }, 'Pod completion watcher error');
        exitListeners.forEach(l => l());
      });
    
    return await firstOutputPromise;
  } catch (err) {
    logger.error({ err, podName }, 'Failed to run agent pod');
    exitListeners.forEach(l => l());
    return { status: 'error', result: null, error: String(err) };
  }
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups: AvailableGroup[] = groups.map(g => ({
    ...g,
    isRegistered: registeredJids.has(g.jid)
  }));

  if (isMain) {
    for (const jid of registeredJids) {
      if (!visibleGroups.some(g => g.jid === jid)) {
        visibleGroups.push({
          jid,
          name: jid.startsWith('internal-') ? jid.split('-')[1] : jid,
          lastActivity: new Date().toISOString(),
          isRegistered: true
        });
      }
    }
  }

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: isMain ? visibleGroups : [],
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
