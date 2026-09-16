import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config, StatusKey } from './types.js';

export const CONFIG_FILE = 'hive.config.json';

export const DEFAULT_CONFIG: Omit<Config, 'project'> = {
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

export function parseConfig(raw: unknown): Config {
  if (!isRecord(raw)) throw new Error(`${CONFIG_FILE}: root must be an object`);
  const project = isRecord(raw.project) ? raw.project : {};
  const owner = requireString(project.owner, 'project.owner');
  const number = requireInt(project.number, 'project.number');

  const statusRaw = optional(raw.status, {} as Record<string, unknown>, (v) => {
    if (!isRecord(v)) throw new Error(`${CONFIG_FILE}: "status" must be an object`);
    return v;
  });
  const status = Object.fromEntries(
    STATUS_KEYS.map((key) => [key, optional(statusRaw[key], DEFAULT_CONFIG.status[key], (v) => requireString(v, `status.${key}`))]),
  ) as Record<StatusKey, string>;

  return {
    project: { owner, number },
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

export async function loadConfig(repo: string): Promise<Config> {
  const path = join(repo, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(`${CONFIG_FILE} não encontrado em ${repo} (${(err as Error).message})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path}: JSON inválido (${(err as Error).message})`);
  }
  return parseConfig(raw);
}
