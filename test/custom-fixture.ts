import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { ItemSources } from '../src/item-sources.js';
import { type AfterHost, tempDir } from './temp-dir.js';

export const BUILD = 'hive:new-build';
export const ARCHITECT = 'hive:architect';
export const DEPLOY = 'hive-site:deploy';
export const HELPER = 'hive-site:helper';
export const SKILL = '---\nname: new-build\ndescription: Build it\n---\n# new-build\n';
export const SPECIALIST = '---\nname: architect\ndescription: Designs\n---\nYou design.\n';
export const REPO_SKILL = '---\nname: deploy\ndescription: Deploys the site\n---\nDeploy.\n';
export const REPO_SPECIALIST = '---\nname: helper\ndescription: Helps\n---\nHelp.\n';
/** A SKILL.md with Markdown sections, for the update merge (#324): its Input and Output lines are the ones the tests edit. */
export const skillDoc = (input: string, output: string): string =>
  `---\nname: new-build\ndescription: Build it\n---\n# new-build\n\n## Input\n\n${input}\n\n## Steps\n\nStep one.\nStep two.\n\n## Output\n\n${output}\n`;

type Snapshot = Record<string, string>;
export interface Fixture extends ItemSources {
  site: string;
  initial: { plugin: Snapshot; site: Snapshot };
}

export async function put(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

/** Every file under `dir`, by relative path, with its bytes: two folders compare byte for byte. */
export async function snapshot(dir: string): Promise<Snapshot> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
  return Object.fromEntries(await Promise.all(files.map(async (file) => [relative(dir, file), (await readFile(file)).toString('base64')] as const)));
}

/** A temporary home, a fake shipped plugin, and two workspaces: agent-hive (no .claude/) and hive-site (one skill, one specialist). */
export async function fixture(t: AfterHost): Promise<Fixture> {
  const [home, pluginSource, hive, site] = await Promise.all(['custom-home-', 'custom-plugin-', 'custom-ws-', 'custom-site-'].map((prefix) => tempDir(t, prefix)));
  await put(pluginSource, {
    '.claude-plugin/plugin.json': '{"name":"hive","version":"0.1.0"}',
    'skills/new-build/SKILL.md': SKILL,
    'skills/new-build/scripts/run.sh': 'echo hi\n',
    'agents/architect.md': SPECIALIST,
  });
  await put(site, { '.claude/skills/deploy/SKILL.md': REPO_SKILL, '.claude/agents/helper.md': REPO_SPECIALIST });
  const workspaces = [
    { name: 'agent-hive', path: hive },
    { name: 'hive-site', path: site },
  ];
  return { home, pluginSource, site, workspaces, initial: { plugin: await snapshot(pluginSource), site: await snapshot(site) } };
}

/** Nothing outside <home>/custom/ changed: the fake plugin and the fake repository still hold their first bytes. */
export async function assertUntouched(f: Fixture): Promise<void> {
  assert.deepEqual(await snapshot(f.pluginSource), f.initial.plugin, 'the shipped plugin');
  assert.deepEqual(await snapshot(f.site), f.initial.site, 'the repository');
}
