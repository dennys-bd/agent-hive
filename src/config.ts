import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BoardConfig, Config, StatusKey } from './types.js';

export const CONFIG_FILE = 'hive.config.json';

export const BOARD_TYPES: readonly BoardConfig['type'][] = ['github', 'markdown'];

export const DEFAULT_CONFIG: Omit<Config, 'board'> = {
  status: { queue: 'Ready', working: 'In progress', review: 'In review' },
  maxConcurrent: 2,
  port: 47821,
  claudeArgs: [],
  promptTemplate:
    'Task #{number}: {title}\n\n{body}\n\nWork on this branch. When the task is done, open a PR with `gh pr create`.',
};

const STATUS_KEYS: StatusKey[] = ['queue', 'working', 'review'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${CONFIG_FILE}: "${field}" must be a non-empty string`);
  return value;
}

function requireInt(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${CONFIG_FILE}: "${field}" must be a non-negative integer`);
  return value as number;
}

function optional<T>(value: unknown, fallback: T, check: (v: unknown) => T): T {
  return value === undefined ? fallback : check(value);
}

// `field` is how the board appears in error messages: "board" for the current format, "project" for legacy files.
function parseBoard(raw: unknown, field: string): BoardConfig {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: "${field}" must be an object`);
  switch (raw.type) {
    case 'github':
      return { type: 'github', owner: requireString(raw.owner, `${field}.owner`), number: requireInt(raw.number, `${field}.number`) };
    case 'markdown':
      return { type: 'markdown', path: requireString(raw.path, `${field}.path`) };
    default:
      throw new Error(`${CONFIG_FILE}: "${field}.type" must be one of: ${BOARD_TYPES.join(', ')}`);
  }
}

// Files written before boards were pluggable have `project: { owner, number }` and no `board`.
function boardFrom(raw: Record<string, unknown>): BoardConfig {
  if (raw.board === undefined && isRecord(raw.project)) return parseBoard({ ...raw.project, type: 'github' }, 'project');
  return parseBoard(raw.board, 'board');
}

export function parseConfig(raw: unknown): Config {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: root must be an object`);
  const board = boardFrom(raw);

  const statusRaw = optional(raw.status, {} as Record<string, unknown>, (v) => {
    if (!isRecord(v)) throw new Error(`${CONFIG_FILE}: "status" must be an object`);
    return v;
  });
  const status = Object.fromEntries(
    STATUS_KEYS.map((key) => [key, optional(statusRaw[key], DEFAULT_CONFIG.status[key], (v) => requireString(v, `status.${key}`))]),
  ) as Record<StatusKey, string>;

  return {
    board,
    status,
    maxConcurrent: optional(raw.maxConcurrent, DEFAULT_CONFIG.maxConcurrent, (v) => requireInt(v, 'maxConcurrent')),
    port: optional(raw.port, DEFAULT_CONFIG.port, (v) => requireInt(v, 'port')),
    claudeArgs: optional(raw.claudeArgs, DEFAULT_CONFIG.claudeArgs, (v) => {
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error(`${CONFIG_FILE}: "claudeArgs" must be an array of strings`);
      return v as string[];
    }),
    promptTemplate: optional(raw.promptTemplate, DEFAULT_CONFIG.promptTemplate, (v) => requireString(v, 'promptTemplate')),
  };
}

export async function loadConfigIfPresent(repo: string): Promise<Config | undefined> {
  const path = join(repo, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`${path}: erro de leitura (${(err as Error).message})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path}: JSON inválido (${(err as Error).message})`);
  }
  return parseConfig(raw);
}

export async function loadConfig(repo: string): Promise<Config> {
  const config = await loadConfigIfPresent(repo);
  if (!config) throw new Error(`${CONFIG_FILE} não encontrado em ${repo}`);
  return config;
}
