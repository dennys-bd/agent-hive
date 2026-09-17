import { join } from 'node:path';
import { createBoard } from './board.js';
import { DEFAULT_CONFIG, loadConfigIfPresent } from './config.js';
import { HIVE_DIR, prepareHiveDir } from './hooks-settings.js';
import { languageFrom, systemLanguage } from './language.js';
import { createLogger, type Logger } from './log.js';
import { createServer, killStrays, type HiveServer, type ServerDeps } from './server.js';
import { loadState } from './state-store.js';
import type { Language } from './types.js';

export interface BootedHive {
  port: number;
  server: HiveServer;
}

export interface BootOptions extends Pick<ServerDeps, 'readPlanLimits'> {
  locale?: string; // Electron's app.getLocale(); absent (run.js) → the Node process locale
}

export async function bootHive(repo: string, options: BootOptions = {}): Promise<BootedHive> {
  const { locale, ...deps } = options;
  const language = locale === undefined ? systemLanguage() : languageFrom(locale);
  const log = createLogger(join(repo, HIVE_DIR)); // before anything else: a config that fails to parse and setup mode log too
  const config = await loadConfigIfPresent(repo).catch((err: Error) => {
    log.error(`config: ${err.message}`);
    throw err;
  });
  if (!config) return bootSetupMode(repo, log, language, deps);
  log.setLevel(config.logLevel);
  const { hiveDir, hooksPath, promptsDir } = await prepareHiveDir(repo, config.port);
  const board = createBoard(config, { repo, log });
  try {
    await board.resolveFields();
  } catch (err) {
    // A saved config whose board is gone (file deleted, project removed) must not kill the app: reopen the setup form with the reason.
    const error = (err as Error).message;
    log.error(`board: ${error}`);
    return bootSetupMode(repo, log, language, deps, { config, error });
  }
  log.info(`boot repo=${repo} mode=hive`);
  // state.json carries a copy of the budget; the config file is the source, so a hand edit wins on boot
  const saved = { ...(await loadState(hiveDir, config.maxConcurrent)), budget: config.budget, usageRules: config.usageRules, columns: config.columns };
  const server = createServer({ repo, runtime: { config, board, hiveDir, hooksPath, promptsDir }, state: saved, log, systemLanguage: language, ...deps });
  const port = await server.listen(config.port);
  await killStrays(saved);
  await server.dispatch({ type: 'boot' });
  await server.poll();
  await server.refreshPlanLimits(); // hive mode skips configure(): the same order, board first, then the account
  console.log(`Agent Hive em http://127.0.0.1:${port} (repo: ${repo})`);
  return { port, server };
}

// No hive.config.json (or one whose board cannot be read): serve only the setup form; POST /setup finishes the boot in place.
async function bootSetupMode(
  repo: string, log: Logger, language: Language, deps: Pick<ServerDeps, 'readPlanLimits'>, setupFallback?: ServerDeps['setupFallback'],
): Promise<BootedHive> {
  log.info(`boot repo=${repo} mode=setup reason=${setupFallback?.error ?? 'no hive.config.json'}`);
  const server = createServer({ repo, setupFallback, log, systemLanguage: language, ...deps });
  const port = await server.listen(setupFallback?.config.port ?? DEFAULT_CONFIG.port);
  console.log(`Agent Hive em modo setup em http://127.0.0.1:${port} (repo: ${repo}, ${setupFallback?.error ?? 'sem hive.config.json'})`);
  return { port, server };
}
