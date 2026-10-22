// The spend cap (#472, root design "Pace"): no new round once the experiment's tokens pass cap.tokens, or once the Hive's latest
// rate-limit reading, its highest window across every agent, passes cap.planPercent. Pure: the runner passes state.rateLimits.
import type { Experiment, PlanReadings } from '../types.js';

/** Every run's tokens: an ended run's final metrics, a running one's last progress read (3.2 writes it), an interrupted one's spend. */
export const experimentTokens = (experiment: Experiment): number =>
  experiment.rounds.flatMap((round) => round.runs).reduce((sum, run) => sum + (run.metrics?.tokens ?? 0), 0);

export function highestPercent(readings: PlanReadings | undefined): number | undefined {
  const percents = Object.values(readings ?? {}).flatMap((reading) => Object.values(reading?.windows ?? {}).map((w) => w.usedPercent));
  return percents.length === 0 ? undefined : Math.max(...percents);
}

export function capReached(experiment: Experiment, readings: PlanReadings | undefined): boolean {
  const { tokens, planPercent } = experiment.pace.cap;
  if (tokens !== undefined && experimentTokens(experiment) > tokens) return true;
  const highest = highestPercent(readings);
  return planPercent !== undefined && highest !== undefined && highest > planPercent;
}
