import { createBoard } from './board.js';
import { DEFAULT_CONFIG, loadConfigIfPresent } from './config.js';
import { prepareHiveDir } from './hooks-settings.js';
import { createServer, detectAlive, type HiveServer } from './server.js';
import { loadState } from './state-store.js';

export interface BootedHive {
  port: number;
  server: HiveServer;
}

export async function bootHive(repo: string): Promise<BootedHive> {
  const config = await loadConfigIfPresent(repo);
  if (!config) return bootSetupMode(repo);
  const { hiveDir, hooksPath, promptsDir } = await prepareHiveDir(repo, config.port);
  const board = createBoard(config, { repo });
  await board.resolveFields();
  // state.json carries a copy of the budget; the config file is the source, so a hand edit wins on boot
  const saved = { ...(await loadState(hiveDir, config.maxConcurrent)), budget: config.budget, usageRules: config.usageRules };
  const server = createServer({ repo, runtime: { config, board, hiveDir, hooksPath, promptsDir }, state: saved });
  const port = await server.listen(config.port);
  await server.dispatch({ type: 'boot', aliveSlugs: await detectAlive(saved) });
  await server.poll();
  console.log(`Agent Hive em http://127.0.0.1:${port} (repo: ${repo})`);
  return { port, server };
}

// No hive.config.json: serve only the setup form; POST /setup finishes the boot in place.
async function bootSetupMode(repo: string): Promise<BootedHive> {
  const server = createServer({ repo });
  const port = await server.listen(DEFAULT_CONFIG.port);
  console.log(`Agent Hive em modo setup em http://127.0.0.1:${port} (repo: ${repo}, sem hive.config.json)`);
  return { port, server };
}
