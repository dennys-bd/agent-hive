// The run result's routes (#466): judge again (#474), the median override (#476) and the run's own Hive (#475). They go through the shell's
// send (#461), so a refusal is its toast and never the server's words. 2.5's abrir reuses openRunHive, so both buttons move the window alike.
import { send } from '@/components/benchmark/send';

const runPath = (id: string, token: string): string => `/benchmark/experiments/${encodeURIComponent(id)}/runs/${encodeURIComponent(token)}`;

// The route answers 202 at once; the new scores arrive through /events
export async function evaluateRun(id: string, token: string): Promise<void> {
  await send('POST', `${runPath(id, token)}/evaluate`);
}

export async function setInMedian(id: string, token: string, inMedian: boolean): Promise<void> {
  await send('PATCH', runPath(id, token), { inMedian });
}

/** The open route boots or finds the run's daemon and sets this host's cookie for its port (#467), so the window can move there. */
export async function openRunHive(id: string, token: string): Promise<void> {
  const answer = await send<{ port: number }>('POST', `${runPath(id, token)}/open`);
  if (answer !== undefined) location.assign(`${location.protocol}//${location.hostname}:${answer.port}/`);
}
