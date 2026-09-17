import { createBoard } from './board.js';
import { DEFAULT_CONFIG, loadConfigIfPresent } from './config.js';
import { prepareHiveDir } from './hooks-settings.js';
import { createServer, killStrays, type HiveServer, type ServerDeps } from './server.js';
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
  try {
    await board.resolveFields();
  } catch (err) {
    // A saved config whose board is gone (file deleted, project removed) must not kill the app: reopen the setup form with the reason.
    return bootSetupMode(repo, { config, error: (err as Error).message });
  }
  // state.json carries a copy of the budget; the config file is the source, so a hand edit wins on boot
  const saved = { ...(await loadState(hiveDir, config.maxConcurrent)), budget: config.budget, usageRules: config.usageRules };
  const server = createServer({ repo, runtime: { config, board, hiveDir, hooksPath, promptsDir }, state: saved });
  const port = await server.listen(config.port);
  await killStrays(saved);
  await server.dispatch({ type: 'boot' });
  await server.poll();
  console.log(`Agent Hive em http://127.0.0.1:${port} (repo: ${repo})`);
  return { port, server };
}

// No hive.config.json (or one whose board cannot be read): serve only the setup form; POST /setup finishes the boot in place.
async function bootSetupMode(repo: string, setupFallback?: ServerDeps['setupFallback']): Promise<BootedHive> {
  const server = createServer({ repo, setupFallback });
  const port = await server.listen(setupFallback?.config.port ?? DEFAULT_CONFIG.port);
  console.log(`Agent Hive em modo setup em http://127.0.0.1:${port} (repo: ${repo}, ${setupFallback?.error ?? 'sem hive.config.json'})`);
  return { port, server };
}
