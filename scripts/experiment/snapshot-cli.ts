import { readFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { hiveHome } from '../../src/home.js';
import { createDaemonClient } from '../../src/benchmark/daemon-client.js';
import { writeText } from './files.js';
import { parseStagesSeed, SEED_DIR } from './seed.js';
import { assertClean, missingStates, sanitizeState } from './snapshot.js';

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const names = (stages: unknown): string[] =>
  (Array.isArray(stages) ? (stages as unknown[]) : []).flatMap((s) => (typeof s === 'object' && s !== null && typeof (s as { name?: unknown }).name === 'string' ? [(s as { name: string }).name] : []));

/** pnpm experiment:snapshot (#105, the user): the live Hive of HIVE_HOME (else the default home), sanitized, as the sample. */
async function main(): Promise<void> {
  const payload = await createDaemonClient(hiveHome(process.env)).payload();
  const seedStages = parseStagesSeed(JSON.parse(await readFile(join(SEED_DIR, 'stages.json'), 'utf8'))).stages.map((s) => String(s.name));
  const options = { liveStages: names(payload.stages), seedStages, username: userInfo().username, home: homedir() };
  const state = sanitizeState(payload, options);
  const missing = missingStates(state);
  if (missing.length > 0) throw new Error(`the live Hive lacks ${missing.join(', ')}: take the snapshot when it has them`);
  const text = `${JSON.stringify(state, null, 2)}\n`;
  assertClean(text, options);
  await writeText(join(SEED_DIR, 'sample-state.json'), text);
  console.log(`sample-state.json: ${(state.tasks as unknown[]).length} activities; review it before committing`);
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error(message(err));
  process.exit(1);
}
