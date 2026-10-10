import { mayStart } from './deadline.js';
import { runRef } from './plan.js';
import { ARMS, type RunRef } from './types.js';

export interface LoopDeps {
  now(): Date; log(line: string): void;
  hasMetrics(ref: RunRef): Promise<boolean>; hasJudge(ref: RunRef): Promise<boolean>;
  execute(ref: RunRef, alone: boolean): Promise<void>; // the run and its metrics.json; a failure is recorded inside as an error run
  evaluate(ref: RunRef): Promise<void>; report(): Promise<void>;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// A failed evaluation is data, not a reason to stop; the report is rewritten either way
async function evaluated(ref: RunRef, deps: LoopDeps): Promise<void> {
  try {
    await deps.evaluate(ref);
  } catch (err) {
    deps.log(`evaluation of ${ref.id} failed: ${message(err)}`);
  }
  await deps.report();
}

// The pair's measured but unjudged runs, then its missing ones
async function sortPair(pair: readonly RunRef[], deps: LoopDeps): Promise<RunRef[]> {
  let missing: RunRef[] = [];
  for (const ref of pair) {
    if (!(await deps.hasMetrics(ref))) missing = [...missing, ref];
    else if (!(await deps.hasJudge(ref))) await evaluated(ref, deps);
  }
  return missing;
}

/** The night (#105, the user): pair n is run n of A and run n of B, started together; the next pair waits for both. No pair starts at or after
 *  the deadline, and a pair going is never cut. A half-finished pair reruns its missing run alone (unpaired). Evaluations run one at a time. */
export async function runLoop(pairs: number, deadline: Date | undefined, deps: LoopDeps): Promise<string[]> {
  let ran: string[] = [];
  for (let n = 1; n <= pairs; n += 1) {
    const missing = await sortPair(ARMS.map((arm) => runRef(arm, n)), deps);
    if (missing.length === 0) continue;
    if (!mayStart(deps.now(), deadline)) {
      deps.log(`--until reached: pair ${n} and the later pairs wait for the next call`);
      break;
    }
    const alone = missing.length === 1;
    deps.log(alone ? `${missing[0].id} reruns alone (unpaired)` : `pair ${n} starts`);
    await Promise.all(missing.map((ref) => deps.execute(ref, alone)));
    ran = [...ran, ...missing.map((ref) => ref.id)];
    for (const ref of missing) await evaluated(ref, deps);
  }
  return ran;
}
