/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import * as k8s from '@kubernetes/client-node';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  K8S_NAMESPACE,
  K8S_PVC_NAME,
  K8S_PVC_SUBPATH,
  TIMEZONE,
  GEMINI_MODEL,
} from './config.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import * as k8sRuntime from './k8s-runtime.js';
import {
  CONTAINER_RUNTIME_BIN,
  RUNTIME,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
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
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

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
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    // Base project root (READ-ONLY)
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
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Gemini sessions directory (isolated from other groups)
  // Each group gets their own .gemini/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.gemini',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Gemini-specific environment variables for the runner can be added here
            GEMINI_AGENT_MODE: 'isolated',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .gemini/skills/
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

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  const inputDir = path.join(groupIpcDir, 'input');
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(inputDir, { recursive: true });

  // Clear stale follow-up messages from previous runs to prevent double-processing
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

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
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

  // Base runner directory (READ-ONLY for entrypoint.sh)
  mounts.push({
    hostPath: path.join(projectRoot, 'container', 'agent-runner'),
    containerPath: '/app',
    readonly: true,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
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

/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 */
function readSecrets(): Record<string, string> {
  return readEnvFile(['GEMINI_API_KEY']);
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  modelName: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Pass GEMINI_MODEL to the container
  args.push('-e', `GEMINI_MODEL=${modelName}`);

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess | any, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const mounts = buildVolumeMounts(group, input.isMain);
  const projectRoot = process.cwd();

  if (RUNTIME === 'k8s') {
    return runAgentPod(group, input, onProcess, onOutput, mounts, projectRoot);
  }
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const modelName = input.model || GEMINI_MODEL;
  const containerArgs = buildContainerArgs(mounts, containerName, modelName);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Pass secrets via stdin (never written to disk or mounted as files)
    input.secrets = readSecrets();
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
    // Remove secrets from input so they don't appear in logs
    delete input.secrets;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = async () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      try {
        await stopContainer(containerName);
      } catch (err) {
        logger.warn(
          { group: group.name, containerName, err },
          'Graceful stop failed, force killing',
        );
        container.kill('SIGKILL');
      }
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

async function runAgentPod(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: any, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  mounts: VolumeMount[] = [],
  projectRoot: string = process.cwd(),
): Promise<ContainerOutput> {
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
  const podName = `nanoclaw-agent-${safeName}-${Date.now()}`;

  logger.info({ group: group.name, podName }, 'Creating agent pod');

  // Ensure IPC and session directories exist for this group on the shared PVC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });

  const podSpec: k8s.V1Pod = {
    metadata: {
      name: podName,
      labels: {
        app: 'nanoclaw-agent',
        'app.kubernetes.io/managed-by': 'nanoclaw',
        'nanoclaw.io/group': safeName,
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
                  name: 'nanoclaw-secrets',
                  key: 'GEMINI_API_KEY',
                },
              },
            },
            {
              name: 'NANOCLAW_INPUT',
              value: Buffer.from(JSON.stringify(input)).toString('base64'),
            },
            {
              name: 'GEMINI_MODEL',
              value: input.model || GEMINI_MODEL,
            },
          ],
          command: ['/bin/sh', '-c'],
          args: ['echo "$NANOCLAW_INPUT" | /app/entrypoint.sh'],
          volumeMounts: [
            ...mounts.map((m, idx) => ({
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

  try {
    // Add timeout to pod creation
    await Promise.race([
      k8sRuntime.runAgentPod(podSpec),
      new Promise((_, reject) => setTimeout(() => reject(new Error('K8s pod creation timed out after 30s')), 30000))
    ]);

    // Register a dummy process that can be used to stop the pod
    onProcess(
      {
        kill: () => stopContainer(podName),
        stdin: { write: () => {}, end: () => {} }, // Pod stdin is handled via args/echo for now
        on: (event: string, listener: () => void) => {
          if (event === 'exit') exitListeners.push(listener);
        },
      },
      podName,
    );

    // Stream logs for output markers
    let hadStreamingOutput = false;
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    const logStream = new k8s.Log(kc);
    const logSink = new (await import('stream')).PassThrough();

    // Wait for pod to start running before streaming logs
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
      // Keep set size manageable, though turns are usually short
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

    // Start streaming logs in background
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

    // Wait for either the first output or pod completion
    const podCompletionPromise = (async () => {
      const startTime = Date.now();
      const MAX_POD_LIFE = 1800000; // 30 mins hard limit

      while (podStatus === 'Pending' || podStatus === 'Running') {
        // Consolidated file-based results check (fallback for when log streaming misses something)
        if (fs.existsSync(groupIpcDir)) {
          const files = fs.readdirSync(groupIpcDir)
            .filter(f => f.startsWith('result-') && f.endsWith('.json'))
            .sort();
          
          for (const file of files) {
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
        }

        if (Date.now() - startTime > MAX_POD_LIFE) {
          logger.warn({ podName }, 'Pod reached max life, killing');
          await stopContainer(podName);
          break;
        }

        try {
          const res = await getK8sApi().readNamespacedPodStatus({
            name: podName,
            namespace: K8S_NAMESPACE,
          });
          podStatus = res.status?.phase || 'Unknown';
        } catch (err) {
          logger.warn({ err, podName }, 'Failed to read pod status');
        }
        if (podStatus === 'Succeeded' || podStatus === 'Failed') break;
        await new Promise((r) => setTimeout(r, 5000));
      }

      if (!firstOutputResolved) {
        // If it finished without sending markers via stream, get full logs
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
      return null; // Already resolved via firstOutputPromise
    })();

    // We want to return the first result as soon as it's ready, but continue 
    // watching the pod in the background for potential follow-up messages 
    // or to clean it up when it eventually exits.
    
    // Background the completion promise so it cleans up later
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
    // Trigger exit listeners even on error to avoid jamming the queue
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
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
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

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // 1. Start with discovered groups
  const visibleGroups: AvailableGroup[] = groups.map(g => ({
    ...g,
    isRegistered: registeredJids.has(g.jid)
  }));

  // 2. Add registered internal agents that weren't in the discovered list
  // Note: We don't have the names here, so we'll use the JID as a placeholder 
  // until the next full metadata sync.
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
