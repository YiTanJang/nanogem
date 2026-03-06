import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  process.env.CONTAINER_RUNTIME = 'docker';
  
  const container = {
    stop: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    inspect: vi.fn(async () => ({ State: { Running: true } })),
  };
  
  const docker = {
    info: vi.fn(async () => ({})),
    getContainer: vi.fn(() => container),
    listContainers: vi.fn(async () => []),
  };

  return {
    container,
    docker,
  };
});

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock dockerode
vi.mock('dockerode', () => {
  class MockDocker {
    constructor() {
      return mocks.docker;
    }
  }
  return {
    default: MockDocker,
  };
});

// Mock k8s-runtime
vi.mock('./k8s-runtime.js', () => ({
  stopPod: vi.fn(async () => {}),
  ensureK8sReady: vi.fn(async () => {}),
  cleanupOrphans: vi.fn(async () => {}),
}));

import {
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
  RUNTIME,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
  // Reset default successful state
  mocks.container.inspect.mockResolvedValue({ State: { Running: true } } as any);
  mocks.docker.info.mockResolvedValue({} as any);
  mocks.docker.listContainers.mockResolvedValue([]);
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix when runtime is docker', () => {
    expect(RUNTIME).toBe('docker');
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('stops and removes a running container', async () => {
    await stopContainer('nanoclaw-test-123');
    expect(mocks.docker.getContainer).toHaveBeenCalledWith('nanoclaw-test-123');
    expect(mocks.container.inspect).toHaveBeenCalled();
    expect(mocks.container.stop).toHaveBeenCalled();
    expect(mocks.container.remove).toHaveBeenCalled();
  });

  it('only removes a non-running container', async () => {
    mocks.container.inspect.mockResolvedValueOnce({ State: { Running: false } } as any);
    await stopContainer('nanoclaw-test-123');
    expect(mocks.container.stop).not.toHaveBeenCalled();
    expect(mocks.container.remove).toHaveBeenCalled();
  });

  it('handles "no such container" errors gracefully (404)', async () => {
    const error: any = new Error('Not found');
    error.statusCode = 404;
    mocks.container.inspect.mockRejectedValueOnce(error);
    await stopContainer('nanoclaw-test-123');
    expect(logger.error).not.toHaveBeenCalled();
    expect(mocks.container.stop).not.toHaveBeenCalled();
  });

  it('handles "container already stopped" errors gracefully', async () => {
    const error: any = new Error('Already stopped');
    error.reason = 'container already stopped';
    mocks.container.inspect.mockRejectedValueOnce(error);
    await stopContainer('nanoclaw-test-123');
    expect(logger.error).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', async () => {
    await ensureContainerRuntimeRunning();
    expect(mocks.docker.info).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('throws when docker info fails', async () => {
    mocks.docker.info.mockRejectedValueOnce(new Error('Cannot connect'));
    await expect(ensureContainerRuntimeRunning()).rejects.toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('stops and removes orphaned nanoclaw containers', async () => {
    const mockOrphans = [
      { Id: '111', Names: ['/nanoclaw-group1-111'] },
      { Id: '222', Names: ['/nanoclaw-group2-222'] },
    ];
    mocks.docker.listContainers.mockResolvedValueOnce(mockOrphans as any);

    await cleanupOrphans();

    expect(mocks.docker.listContainers).toHaveBeenCalledWith({
      all: true,
      filters: { name: ['nanoclaw-'] },
    });
    expect(mocks.docker.getContainer).toHaveBeenCalledTimes(2);
    expect(mocks.docker.getContainer).toHaveBeenCalledWith('nanoclaw-group1-111');
    expect(mocks.docker.getContainer).toHaveBeenCalledWith('nanoclaw-group2-222');
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['/nanoclaw-group1-111', '/nanoclaw-group2-222'] },
      'Stopped and removed orphaned containers',
    );
  });

  it('does nothing when no orphans exist', async () => {
    mocks.docker.listContainers.mockResolvedValueOnce([]);
    await cleanupOrphans();
    expect(mocks.docker.listContainers).toHaveBeenCalledTimes(1);
    expect(mocks.docker.getContainer).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
