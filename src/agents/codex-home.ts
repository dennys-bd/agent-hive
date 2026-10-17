// The Hive's plugin in Codex's shape (#934, finding.codex-surface §10, §11). The skills go as a plugin in Codex's plugin cache, turned on by a -c
// override; each agent goes as a role file beside the plugin folder, named by another. One copy and one set of roles per plugin folder:
// each workspace's (#316). Neither the user's config.toml nor their skills are written.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** The plugin's name in Codex, and the prefix the skills dispatch every agent under (hive:<name>), as for Claude. */
export const CODEX_PLUGIN = 'hive';

const MARKETPLACE_PREFIX = 'agent-hive-';
const MARKETPLACE_HASH_CHARS = 8;
const PLUGIN_VERSION_DIR = 'current'; // Codex loads whatever the version folder is called (probed)
const ROLES_DIR = '.codex'; // <parent>/.codex/<folder>: beside the plugin folder, never in it, so the folder stays what Claude loads (#316)
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

/** One name per plugin folder (#316): every workspace has a marketplace of its own, and two Hives sharing a CODEX_HOME never wipe each other's
 * copy. Hex: no '.', which Codex splits -c keys on. Hashed as given, so the render's folder and the run's pluginDir name the same marketplace. */
export const marketplaceName = (pluginDir: string): string =>
  `${MARKETPLACE_PREFIX}${createHash('sha256').update(pluginDir).digest('hex').slice(0, MARKETPLACE_HASH_CHARS)}`;

const marketplaceDir = (codexHome: string, pluginDir: string): string => join(codexHome, 'plugins', 'cache', marketplaceName(pluginDir));

export const pluginCacheDir = (codexHome: string, pluginDir: string): string => join(marketplaceDir(codexHome, pluginDir), CODEX_PLUGIN, PLUGIN_VERSION_DIR);

/** A plugin folder's roles (#316): <home>/plugins/<ws> -> <home>/plugins/.codex/<ws>. */
export const rolesDir = (pluginDir: string): string => join(dirname(pluginDir), ROLES_DIR, basename(pluginDir));

export const roleFile = (pluginDir: string, name: string): string => join(rolesDir(pluginDir), `${name}.toml`);

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

/** Codex's copy of one plugin folder and its roles' files (#934, #316): wiped and rewritten on every render of the folder, so a skill or an agent
 * it no longer has stops existing. Nothing else under CODEX_HOME is touched. */
export async function prepareCodexWorkspace(dir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const cache = pluginCacheDir(codexHome(env), dir);
  await rm(cache, { recursive: true, force: true });
  await cp(dir, cache, { recursive: true }); // creates plugins/cache/<marketplace>/hive on the way
  const roles = rolesDir(dir);
  await rm(roles, { recursive: true, force: true });
  await mkdir(roles, { recursive: true });
  await Promise.all(agentRoles(dir).map((role) => writeFile(roleFile(dir, role.name), renderRole(role))));
}

/** A removed workspace's Codex copy and roles (#316): its whole marketplace, found by hashing the folder it had. Never by the agent-hive- prefix:
 * another Hive may share this CODEX_HOME. */
export async function removeCodexWorkspace(dir: string, env: NodeJS.ProcessEnv): Promise<void> {
  await rm(marketplaceDir(codexHome(env), dir), { recursive: true, force: true });
  await rm(rolesDir(dir), { recursive: true, force: true });
}
