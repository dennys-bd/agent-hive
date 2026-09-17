// Every dashboard action: same route and body as before, a toast instead of the error bar.
import { toast } from 'sonner';
import { postJson } from '../lib/api.js';

export function act(path: string, body?: unknown): void {
  postJson(path, body).catch((err: Error) => toast.error(err.message));
}
