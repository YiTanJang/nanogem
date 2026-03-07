import os from 'os';
import path from 'path';
import fs from 'fs';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile(['ASSISTANT_NAME']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'NanoClaw';
export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
export const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

// --- Registry & Image Configuration ---
export const REGISTRY_URL = process.env.REGISTRY_URL || 'localhost:5000';
export const CONTAINER_IMAGE_BASE = process.env.CONTAINER_IMAGE_BASE || 'nanoclaw';

/** The full image path for spawned agent pods. */
export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || `${REGISTRY_URL}/${CONTAINER_IMAGE_BASE}-agent:latest`;

// --- Container Limits & Timeouts ---
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}(?=[\\s'\\b]|$)`,
  'i',
);

// Timezone for scheduled tasks
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// --- Kubernetes Configuration ---
/** Kubernetes namespace for agent pods. */
export const K8S_NAMESPACE = process.env.K8S_NAMESPACE || 'default';

/** Kubernetes PVC name for agent memory. */
export const K8S_PVC_NAME = process.env.K8S_PVC_NAME || 'nanoclaw-pvc';

/** PVC subpath where project root is located. */
export const K8S_PVC_SUBPATH = process.env.K8S_PVC_SUBPATH || '.';

// --- MCP Configuration ---
/** MCP configuration path. */
export const MCP_CONFIG_PATH = path.resolve(PROJECT_ROOT, '.mcp.json');

/** Load MCP configuration. */
export function getMcpConfig() {
  if (fs.existsSync(MCP_CONFIG_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf-8'));
    } catch (err) {
      console.error('Error reading MCP config:', err);
    }
  }
  return { mcpServers: {} };
}
