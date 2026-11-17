// Copilot's hooks (node 2 of #608). The Hive's hooks plugin is one folder of its home that every run loads with a second --plugin-dir (spike
// §1): written empty here, with the manifest Copilot needs to load it, and every payload dropped until node 2 maps the events
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HookPayload } from '../types.js';

const MANIFEST = { name: 'hive-hooks', description: 'The Hive\'s hooks for its Copilot runs (#873)', version: '1.0.0' };
const asFile = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** <home>/copilot/hooks-plugin: what every run's second --plugin-dir names. No I/O. */
export const copilotHooksPlugin = (home: string): string => join(home, 'copilot', 'hooks-plugin');

/** The hooks plugin, rewritten on every boot as Claude's hooks.json is: Copilot reads .claude-plugin/plugin.json and hooks/hooks.json (spike §1). */
export async function writeCopilotHooksPlugin(home: string): Promise<void> {
  const dir = copilotHooksPlugin(home);
  await Promise.all([mkdir(join(dir, '.claude-plugin'), { recursive: true }), mkdir(join(dir, 'hooks'), { recursive: true })]);
  await Promise.all([
    writeFile(join(dir, '.claude-plugin', 'plugin.json'), asFile(MANIFEST)),
    writeFile(join(dir, 'hooks', 'hooks.json'), asFile({ hooks: {} })),
  ]);
}

/** Every payload dropped until node 2: none would move a worker the reducer's way yet. */
export const hookPayload = (): HookPayload | undefined => undefined;
