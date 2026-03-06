/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import Docker from 'dockerode';

import { logger } from './logger.js';
import * as k8sRuntime from './k8s-runtime.js';

/** The runtime to use: 'docker' (default) or 'k8s'. */
export const RUNTIME = process.env.CONTAINER_RUNTIME || 'docker';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = RUNTIME === 'k8s' ? 'kubectl' : 'docker';

const docker = RUNTIME === 'docker' ? new Docker() : null;

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  if (RUNTIME === 'k8s') return [];
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop and remove a container by name. */
export async function stopContainer(name: string): Promise<void> {
  if (RUNTIME === 'k8s') {
    return k8sRuntime.stopPod(name);
  }
  try {
    if (!docker) return;
    const container = docker.getContainer(name);
    // Inspect first to avoid error if it's already gone
    const state = await container.inspect();
    if (state.State.Running) {
      await container.stop();
    }
    await container.remove();
  } catch (err: any) {
    // Suppress "No such container" and "container already stopped" errors
    if (err.statusCode === 404 || err.reason === 'container already stopped') {
      return;
    }
    logger.error({ err, name }, 'Failed to stop container');
  }
}

/** Ensure the container runtime is running, starting it if needed. */
export async function ensureContainerRuntimeRunning(): Promise<void> {
  if (RUNTIME === 'k8s') {
    return k8sRuntime.ensureK8sReady();
  }
  try {
    if (!docker) {
      throw new Error('Docker runtime not initialized');
    }
    await docker.info();
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker or Kubernetes is installed and running      ║',
    );
    console.error(
      '║  2. Run: docker info OR kubectl cluster-info                   ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export async function cleanupOrphans(): Promise<void> {
  if (RUNTIME === 'k8s') {
    return k8sRuntime.cleanupOrphans();
  }
  try {
    if (!docker) return;
    const containers = await docker.listContainers({
      all: true,
      filters: { name: ['nanoclaw-'] },
    });

    if (containers.length === 0) {
      return;
    }

    await Promise.all(
      containers.map(async (containerInfo) => {
        logger.debug({ container: containerInfo }, 'Stopping orphan');
        await stopContainer(containerInfo.Names[0].replace('/', ''));
      }),
    );

    if (containers.length > 0) {
      logger.info(
        { count: containers.length, names: containers.map((c) => c.Names[0]) },
        'Stopped and removed orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
