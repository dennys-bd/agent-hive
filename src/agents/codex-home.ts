// The Hive's plugin in Codex's shape (#934, finding.codex-surface §10, §11). The skills go as a plugin in Codex's plugin cache, turned on by a -c
// override; each agent goes as a role file in the Hive's home, named by another. Neither the user's config.toml nor their skills are written.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pluginSource } from '../hooks-settings.js';

/** The plugin's name in Codex, and the prefix the skills dispatch every agent under (hive:<name>), as for Claude. */
export const CODEX_PLUGIN = 'hive';

const MARKETPLACE_PREFIX = 'agent-hive-';
const MARKETPLACE_HASH_CHARS = 8;
const PLUGIN_VERSION_DIR = 'current'; // Codex loads whatever the version folder is called (probed)
const ROLES_DIR = join('codex', 'agents');
const READ_ONLY_ROLE = 'sandbox_mode = "read-only"\n';
const AGENTS_DIR = 'agents';
const AGENT_SUFFIX = '.md';
const FENCE = '---';
const AGENT_NAME = /^[a-z0-9-]+$/; // it names a file under the home and a -c key, where '.', '/' or '=' would escape or split it
const WRITING_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'Bash']); // what Codex's workspace sandbox allows and read-only refuses

/** One agent of assets/plugin/agents, as Codex gets it: no model (a Claude alias has no Codex name), its tools reduced to read-only or not. */
export interface AgentRole {
  name: string;
  description: string;
  readOnly: boolean;
  instructions: string;
}

/** A TOML basic string: JSON's escapes are TOML's, except DEL, which TOML wants escaped and JSON leaves raw. */
export const tomlString = (text: string): string => JSON.stringify(text).replace(/\u007f/g, '\\u007f');

/** Where Codex reads its plugins; the user's auth and sessions stay there too. */
export const codexHome = (env: NodeJS.ProcessEnv): string => env.CODEX_HOME || join(homedir(), '.codex'); // empty is unset, as Codex reads it: never a cwd-relative tree

/** One name per Hive home, so two Hives sharing a CODEX_HOME never wipe each other's copy. Hex: no '.', which Codex splits -c keys on.
 * Hashed as given, so boot's `home` and launch's dirname(run.pluginDir) name the same marketplace. */
export const marketplaceName = (home: string): string =>
  `${MARKETPLACE_PREFIX}${createHash('sha256').update(home).digest('hex').slice(0, MARKETPLACE_HASH_CHARS)}`;

export const pluginCacheDir = (codexHome: string, home: string): string =>
  join(codexHome, 'plugins', 'cache', marketplaceName(home), CODEX_PLUGIN, PLUGIN_VERSION_DIR);

export const roleFile = (home: string, name: string): string => join(home, ROLES_DIR, `${name}.toml`);

/** A role's config file: the agent's body as developer_instructions, read-only when it never writes. */
export const renderRole = (role: AgentRole): string =>
  `developer_instructions = ${tomlString(role.instructions)}\n${role.readOnly ? READ_ONLY_ROLE : ''}`;

// Single-line `key: value` pairs, as every agent file writes its frontmatter: no YAML dependency for ten files the Hive ships
function frontmatter(lines: readonly string[]): Map<string, string> {
  return new Map(lines.flatMap((line): [string, string][] => {
    const at = line.indexOf(':');
    return at < 0 ? [] : [[line.slice(0, at).trim(), line.slice(at + 1).trim()]];
  }));
}

/** One agent file's role. Only name, description and tools count: model goes (a Claude alias), and a tool Codex has no equivalent for
 * (Agent) only ever counts as not writing. The body after the second --- is kept verbatim, a later --- line included. */
export function readAgent(file: string, text: string): AgentRole {
  const lines = text.split(/\r?\n/); // a CRLF checkout too
  const end = lines[0] === FENCE ? lines.indexOf(FENCE, 1) : -1;
  if (end < 0) throw new Error(`${file}: no frontmatter between two ${FENCE} lines`);
  const fields = frontmatter(lines.slice(1, end));
  const name = fields.get('name');
  const description = fields.get('description');
  if (!name || !description) throw new Error(`${file}: its frontmatter has no name or no description`);
  if (!AGENT_NAME.test(name)) throw new Error(`${file}: its name "${name}" is not lowercase letters, digits and hyphens`);
  const tools = fields.get('tools')?.split(',').map((tool) => tool.trim());
  const readOnly = tools !== undefined && !tools.some((tool) => WRITING_TOOLS.has(tool)); // no list: Claude gives every tool
  return { name, description, readOnly, instructions: lines.slice(end + 1).join('\n') };
}

/** Every agent of the plugin at `source`, sorted by file name: readdir's order differs between macOS and Linux. Synchronous, since launch is. */
export function agentRoles(source: string): AgentRole[] {
  const dir = join(source, AGENTS_DIR);
  return readdirSync(dir)
    .filter((file) => file.endsWith(AGENT_SUFFIX))
    .sort()
    .map((file) => readAgent(file, readFileSync(join(dir, file), 'utf8')));
}

/** Codex's copy of the Hive's plugin and the roles' files, for `home`. Wiped and rewritten on every boot, as <home>/plugin is: upgrading the
 * Hive refreshes them, and a skill or agent deleted upstream stops existing. Nothing else under CODEX_HOME is touched. */
export async function prepareCodexHome(home: string, env: NodeJS.ProcessEnv): Promise<void> {
  const cache = pluginCacheDir(codexHome(env), home);
  await rm(cache, { recursive: true, force: true });
  await cp(pluginSource(), cache, { recursive: true }); // creates plugins/cache/<marketplace>/hive on the way
  const roles = join(home, ROLES_DIR);
  await rm(roles, { recursive: true, force: true });
  await mkdir(roles, { recursive: true });
  await Promise.all(agentRoles(pluginSource()).map((role) => writeFile(roleFile(home, role.name), renderRole(role))));
}
