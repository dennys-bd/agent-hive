// The run result's routes (#466): judge again (#474) and the median override (#476) go through the shell's send (#461), so a refusal is its
// toast and never the server's words; the run's own Hive (#475) goes through the execution tab's helpers (#465), so both buttons move alike.
import { toast } from 'sonner';
import { send } from '@/components/benchmark/send';
import { t } from '@/i18n';
import { goToRunHive, openRunHive } from '@/lib/benchmark-run-api';

const runPath = (id: string, token: string): string => `/benchmark/experiments/${encodeURIComponent(id)}/runs/${encodeURIComponent(token)}`;

// The route answers 202 at once; the new scores arrive through /events
export async function evaluateRun(id: string, token: string): Promise<void> {
  await send('POST', `${runPath(id, token)}/evaluate`);
}

export async function setInMedian(id: string, token: string, inMedian: boolean): Promise<void> {
  await send('PATCH', runPath(id, token), { inMedian });
}

/** abrir hive do run, as the execution tab's abrir (#465): the shared open route and the move to the answered port on this host. A refusal
 *  is the execution tab's own toast line, since both buttons do the same thing. */
export async function openHive(id: string, token: string): Promise<void> {
  try {
    goToRunHive((await openRunHive(id, token)).port);
  } catch {
    toast.error(t('benchmark.execution.failed.open'));
  }
}
