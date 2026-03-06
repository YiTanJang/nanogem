import { vi, describe, it, expect, beforeEach } from 'vitest';

// Use hoisted to ensure env is set BEFORE any imports
vi.hoisted(() => {
  process.env.CONTAINER_RUNTIME = 'k8s';
  process.env.NODE_ENV = 'test';
});

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  TIMEZONE: 'America/Los_Angeles',
  GEMINI_MODEL: 'gemini-2.5-flash-lite',
  K8S_NAMESPACE: 'nanoclaw-ns',
  K8S_PVC_NAME: 'nanoclaw-pvc',
  K8S_PVC_SUBPATH: 'memory',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      cpSync: vi.fn(),
    },
  };
});

// Mock k8s-runtime
vi.mock('./k8s-runtime.js', () => ({
  runAgentPod: vi.fn(async () => 'mock-pod-name'),
  stopPod: vi.fn(async () => {}),
  cleanupOrphans: vi.fn(async () => {}),
  K8S_NAMESPACE: 'nanoclaw-ns',
}));

// Mock container-runtime to return RUNTIME='k8s'
vi.mock('./container-runtime.js', () => ({
  RUNTIME: 'k8s',
  CONTAINER_RUNTIME_BIN: 'kubectl',
  readonlyMountArgs: vi.fn(() => []),
  stopContainer: vi.fn(async () => {}),
  ensureContainerRuntimeRunning: vi.fn(async () => {}),
  cleanupOrphans: vi.fn(async () => {}),
}));

// Mock @kubernetes/client-node with proper classes
vi.mock('@kubernetes/client-node', () => {
  const mockApi = {
    readNamespacedPodStatus: vi.fn(async () => ({
      status: { phase: 'Succeeded' },
    })),
    readNamespacedPodLog: vi.fn(async () => 'mock logs'),
  };
  return {
    KubeConfig: class {
      loadFromDefault = vi.fn();
      makeApiClient = vi.fn(() => mockApi);
    },
    CoreV1Api: class {},
    Log: class {
      log = vi.fn(async () => ({ on: vi.fn(), destroy: vi.fn() }));
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Import AFTER all mocks are established
import { runContainerAgent } from './container-runner.js';
import * as k8sRuntime from './k8s-runtime.js';

describe('Kubernetes Runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const testGroup = {
    name: 'K8s Group',
    folder: 'k8s-group',
    trigger: '@Andy',
    added_at: new Date().toISOString(),
  };

  const testInput = {
    prompt: 'hello k8s',
    groupFolder: 'k8s-group',
    chatJid: '123@g.us',
    isMain: false,
  };

  it('delegates to k8sRuntime.runAgentPod when RUNTIME is k8s', async () => {
    await runContainerAgent(testGroup as any, testInput as any, () => {});
    expect(k8sRuntime.runAgentPod).toHaveBeenCalled();
  });
});
