import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEvaluateArgs } from './args.js';
import { evaluateRun } from './evaluate-run.js';
import { execRun, serialGit } from '../../src/benchmark/exec.js';
import { readJson } from './files.js';
import { repoRoot } from '../../src/benchmark/git.js';
import { docsClone } from './docs-git.js';
import { experimentDir, isMeasured, latest, parseManifest, runOrder, seedDrift, stateRoot } from './plan.js';
import { writeReport } from './report.js';
import { loadSeed, seedHash } from './seed.js';
import { FILES } from './types.js';
import { evalDeps, log, stopOnInterrupt } from './wiring.js';

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** pnpm experiment:evaluate --experiment <id> [--run <run-id>]: judges measured runs again, one at a time. */
async function main(): Promise<void> {
  const opts = parseEvaluateArgs(process.argv.slice(2));
  const git = serialGit(execRun);
  const root = await repoRoot(git);
  const { docs } = await docsClone(git, root);
  const state = stateRoot(process.env, homedir());
  const dir = experimentDir(state, opts.experiment);
  const manifest = await readJson(join(dir, FILES.manifest), parseManifest);
  if (!manifest) throw new Error(`no experiment ${opts.experiment} under ${state}`);
  const drift = seedDrift(manifest, await seedHash());
  if (drift !== undefined) log(drift);
  const seed = await loadSeed();
  const refs = runOrder(manifest.runs).filter((ref) => (opts.run === undefined || ref.id === opts.run) && isMeasured(manifest, ref));
  if (refs.length === 0) throw new Error('no measured run to evaluate');
  stopOnInterrupt();
  for (const ref of refs) {
    try {
      const token = latest(manifest, ref)?.token ?? '';
      await evaluateRun({ dir, baseline: manifest.baseline, docsBaseline: manifest.docsBaseline, token, seed, judgeModel: opts.judgeModel }, evalDeps(root, git, docs));
      log(`${ref.id} (${token}) evaluated`);
    } catch (err) {
      log(`evaluation of ${ref.id} failed: ${message(err)}`);
    }
    await writeReport(dir, manifest);
  }
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error(message(err));
  process.exit(1);
}
