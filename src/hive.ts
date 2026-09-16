import { createBoard } from './board.js';
import { loadConfig } from './config.js';
import { prepareHiveDir } from './hooks-settings.js';
import { createServer, detectAlive, type HiveServer } from './server.js';
import { loadState } from './state-store.js';

export async function bootHive(repo: string): Promise<{ port: number; server: HiveServer }> {
  const config = await loadConfig(repo);
  const { hiveDir, hooksPath, promptsDir } = await prepareHiveDir(repo, config.port);
  const board = createBoard(config);
  await board.resolveFields();
  const saved = await loadState(hiveDir, config.maxConcurrent);
  const server = createServer({ repo, runtime: { config, board, hiveDir, hooksPath, promptsDir }, state: saved });
  await server.listen(config.port);
  await server.dispatch({ type: 'boot', aliveSlugs: await detectAlive(saved) });
  await server.poll();
  console.log(`Agent Hive em http://127.0.0.1:${config.port} (repo: ${repo})`);
  return { port: config.port, server };
}
