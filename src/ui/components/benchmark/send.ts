import { toast } from 'sonner';
import { statusOf } from '@/hooks/use-plugins';
import { type MessageKey, t } from '@/i18n';
import { sendJson } from '@/lib/api';

// A refusal's status as the copy the toast shows (root design, Routes): the route logs a 500's detail; its words never reach the screen
const FAILED: Readonly<Record<number, MessageKey>> = { 400: 'benchmark.header.failed.invalid', 404: 'benchmark.header.failed.gone', 409: 'benchmark.header.failed.running' };

/** The refusal's toast, shared with the config tab's writes (#463) so every benchmark post says the same thing for the same status. */
export const toastRefusal = (err: unknown): void => void toast.error(t(FAILED[statusOf(err)] ?? 'benchmark.header.failed.unknown'));

/** The answer, or undefined once the toast told why (#461; shared by the shell and the arms tab, #462). */
export async function send<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T | undefined> {
  try {
    return await sendJson<T>(method, path, body);
  } catch (err) {
    toastRefusal(err);
    return undefined;
  }
}
