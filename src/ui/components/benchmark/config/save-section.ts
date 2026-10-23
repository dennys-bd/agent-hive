// The config tab's writes (#463): one PATCH per section, the seed's uploads and the evaluate route. The refusal's toast is send.ts's,
// so the tab and the shell say the same thing for the same status.
import type { Experiment } from '../../../../types.js';
import type { SectionId } from '@/components/benchmark/config/config-lib';
import { toastRefusal } from '@/components/benchmark/send';
import { statusOf } from '@/hooks/use-plugins';
import { sendJson } from '@/lib/api';

const E = '/benchmark/experiments';
const pathOf = (id: string): string => `${E}/${encodeURIComponent(id)}`;

export interface Refusal { status: number; error?: string; message?: string }

/** The route's code and message on a refusal (parseJson keeps the body): what the seed form reads to show unknown_path or seed_locked inline. */
export function refusalOf(err: unknown): Refusal {
  const body = (err as { body?: { error?: unknown; message?: unknown } } | undefined)?.body;
  return {
    status: statusOf(err),
    ...(typeof body?.error === 'string' ? { error: body.error } : {}),
    ...(typeof body?.message === 'string' ? { message: body.message } : {}),
  };
}

export { toastRefusal };

/** PATCH with that section alone: the answer is the experiment's own id, or a fork's when a seed edit of an experiment with rounds forked it. */
export async function saveSection<K extends SectionId>(id: string, section: K, value: Experiment[K]): Promise<string> {
  return (await sendJson<{ id: string }>('PATCH', pathOf(id), { [section]: value })).id;
}

/** Only writes the file (#459): the seed lists it as upload:<name> through the PATCH on salvar. */
export const uploadSeedFile = (id: string, name: string, content: string): Promise<unknown> =>
  sendJson('PUT', `${pathOf(id)}/seed/files/${encodeURIComponent(name)}`, { content });

export const evaluateAgain = (id: string): Promise<unknown> => sendJson('POST', `${pathOf(id)}/evaluate`);
