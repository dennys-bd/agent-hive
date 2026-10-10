import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const DIR_NAME = 'agent-hive';

/**
 * HIVE_HOME when set (an absolute path, no `agent-hive` suffix appended: it IS the home), else
 * `${XDG_CONFIG_HOME:-~/.config}/agent-hive`: the Hive's own directory (#202, #310) — hive.config.json, state.json, view-state.json,
 * hive.log, hooks.json, prompts/ and credentials.json. Per the XDG base-directory spec, an empty or relative XDG_CONFIG_HOME is invalid
 * and counts as unset; otherwise a bare `XDG_CONFIG_HOME=""` would resolve against process.cwd(), which can be the repo itself.
 * HIVE_HOME follows the same "empty counts as unset" rule, but a relative one throws instead of falling back to the real
 * home: silently ignoring it would start a test Hive on the user's actual data. Plain Node: run.js and bin/hive.js resolve
 * it without Electron.
 */
export function hiveHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HIVE_HOME;
  if (home) {
    if (!isAbsolute(home)) throw new Error(`HIVE_HOME must be an absolute path: ${home}`);
    return home;
  }
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.config'), DIR_NAME);
}
