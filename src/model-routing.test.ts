import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAgent } from './index.js';
import * as containerRunner from './container-runner.js';

// Mock config
vi.mock('./config.js', () => ({
  GEMINI_MODEL: 'gemini-2.5-flash-lite',
  MAIN_GROUP_FOLDER: 'main',
  ASSISTANT_NAME: 'Andy',
  getMcpConfig: vi.fn(() => ({})),
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock index.js state
vi.mock('./index.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    sessions: {},
    registeredGroups: {},
    getAvailableGroups: vi.fn(() => []),
  };
});

// Mock container-runner
vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(async () => ({ status: 'success', result: 'ok' })),
  writeTasksSnapshot: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
}));

// Mock db
vi.mock('./db.js', () => ({
  getAllTasks: vi.fn(() => []),
  getAllChats: vi.fn(() => []),
  initDatabase: vi.fn(),
  getAllRegisteredGroups: vi.fn(() => ({})),
  storeChatMetadata: vi.fn(),
}));

describe('Model Routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const testGroup = {
    name: 'Test',
    folder: 'test',
    trigger: '@Andy',
    added_at: '2024-01-01',
  };

  it('uses default model when no override is present', async () => {
    await runAgent(testGroup as any, 'hello', '123@g.us');

    expect(containerRunner.runContainerAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        model: 'gemini-2.5-flash-lite',
        prompt: 'hello',
      }),
      expect.anything(),
      undefined,
    );
  });

  it('extracts gemini-2.5-pro model override', async () => {
    await runAgent(
      testGroup as any,
      '[model:gemini-2.5-pro] explain quantum',
      '123@g.us',
    );

    expect(containerRunner.runContainerAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        model: 'gemini-2.5-pro',
        prompt: 'explain quantum',
      }),
      expect.anything(),
      undefined,
    );
  });

  it('extracts pro model override with different spacing', async () => {
    await runAgent(
      testGroup as any,
      '  [model:gemini-2.5-pro]   hello  ',
      '123@g.us',
    );

    expect(containerRunner.runContainerAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        model: 'gemini-2.5-pro',
        prompt: 'hello',
      }),
      expect.anything(),
      undefined,
    );
  });
});
