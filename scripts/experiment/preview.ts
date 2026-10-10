import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopTestHive } from '../test-home.js';
import { execRun } from './exec.js';
import { repoRoot } from './git.js';
import { stateRoot } from './plan.js';
import { previewHome } from './preview-home.js';
import { prepareState, writeHome } from './run-home.js';
import { parseStagesSeed, parseTasks, SEED_DIR } from './seed.js';
import { ARMS, type Arm } from './types.js';

const HIVE_BIN = fileURLToPath(new URL('../../../bin/hive.js', import.meta.url));
const readSeed = (name: string): Promise<string> => readFile(join(SEED_DIR, name), 'utf8');

function armOf(args: readonly string[]): Arm {
  const arm = ARMS.find((a) => a === args[0]);
  if (arm === undefined || args.length !== 1) throw new Error(`uso: node dist/scripts/experiment/preview.js <${ARMS.join('|')}>`);
  return arm;
}

// bin/hive.js starts the daemon of HIVE_HOME if none answers and opens the window, as test-hive.ts does
function launch(home: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HIVE_BIN], { env: { ...process.env, HIVE_HOME: home }, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

// The seed is read without loadSeed: a preview needs neither the screens nor the sample state, which the user adds before a night
async function main(): Promise<number> {
  const arm = armOf(process.argv.slice(2));
  const handoff = await readSeed(join('handoff', 'README.md'));
  const seed = { stages: parseStagesSeed(JSON.parse(await readSeed('stages.json'))), tasks: parseTasks(JSON.parse(await readSeed('tasks.json')), handoff) };
  const state = stateRoot(process.env, homedir());
  await prepareState(state);
  const preview = previewHome(seed, arm, await repoRoot(execRun), state);
  await stopTestHive(preview.home); // a live preview daemon would save its own state over the fresh one
  await writeHome(preview.home, preview.config, preview.state);
  console.log(`Hive de preview do braço ${arm}: ${preview.home}`);
  return launch(preview.home);
}

try {
  process.exit(await main());
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
