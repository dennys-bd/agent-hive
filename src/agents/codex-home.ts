// The Hive's plugin in Codex's shape (#934, finding.codex-surface §10, §11). The skills go as a plugin in Codex's plugin cache, turned on by a -c
// override; each agent goes as a role file in the Hive's home, named by another. Neither the user's config.toml nor their skills are written.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The plugin's name in Codex, and the prefix the skills dispatch every agent under (hive:<name>), as for Claude. */
export const CODEX_PLUGIN = 'hive';

const MARKETPLACE_PREFIX = 'agent-hive-';
const MARKETPLACE_HASH_CHARS = 8;
const PLUGIN_VERSION_DIR = 'current'; // Codex loads whatever the version folder is called (probed)
const ROLES_DIR = join('codex', 'agents');
const READ_ONLY_ROLE = 'sandbox_mode = "read-only"\n';

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
export const codexHome = (env: NodeJS.ProcessEnv): string => env.CODEX_HOME ?? join(homedir(), '.codex');

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
