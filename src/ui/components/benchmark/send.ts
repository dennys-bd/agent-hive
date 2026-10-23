import { toast } from 'sonner';
import { failedText } from '@/components/benchmark/failed';
import { sendJson } from '@/lib/api';

/** The refusal's toast, shared with the config tab's writes (#463) so every benchmark post says the same thing for the same status. */
export const toastRefusal = (err: unknown): void => void toast.error(failedText(err));

/** The answer, or undefined once the toast told why (#461; shared by the shell and the arms tab, #462). */
export async function send<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T | undefined> {
  try {
    return await sendJson<T>(method, path, body);
  } catch (err) {
    toastRefusal(err);
    return undefined;
  }
}
