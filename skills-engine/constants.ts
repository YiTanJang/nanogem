export const NANOGEM_DIR = '.nanogem';
export const STATE_FILE = 'state.yaml';
export const BASE_DIR = '.nanogem/base';
export const SKILLS_DIR = '.nanogem/skills';
export const BACKUP_DIR = '.nanogem/backup';
export const LOCK_FILE = '.nanogem/lock';
export const CUSTOM_DIR = '.nanogem/custom';
export const SKILLS_SCHEMA_VERSION = '0.1.0';

// Top-level paths to include in base snapshot and upstream extraction.
// Add new entries here when new root-level directories/files need tracking.
export const BASE_INCLUDES = [
  'src/',
  'package.json',
  '.env.example',
  'container/',
];
