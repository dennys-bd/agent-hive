import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';
import { getJson } from '@/lib/api';

/** The create-task dialog's draft (#771, #772 decision 9). Switching destination keeps every field, so switching back restores them.
 * stage undefined = sem fluxo; status null = fora do project, undefined = the source's options not loaded yet. */
export interface CreateDraft {
  title: string; body: string;
  destination: 'hive' | 'github';
  workspace: string | undefined; stage: string | undefined; // hive
  source: string | undefined; status: string | null | undefined; labels: string[]; // github
}

/** GET /sources/:name/create-options (#768). */
export interface CreateOptions { statuses: string[]; labels: string[] }
export type OptionsEntry = { state: 'loading' } | { state: 'ready'; options: CreateOptions } | { state: 'failed' };

export interface CreateDraftApi {
  draft: CreateDraft;
  options: OptionsEntry | undefined; retryOptions(): void; // the draft's source's, under the github destination only
  setTitle(title: string): void; setBody(body: string): void; setWorkspace(workspace: string): void; setStage(stage: string | undefined): void;
  setDestination(destination: CreateDraft['destination']): void; setSource(source: string): void; setStatus(status: string | null): void;
  addLabel(label: string): void; removeLabel(label: string): void;
}

type Entries = Readonly<Record<string, OptionsEntry>>;
const readyOf = (entry: OptionsEntry | undefined): CreateOptions | undefined => (entry?.state === 'ready' ? entry.options : undefined);

/** A source's first answer for the draft (#772, decision 7): its first Status option, fora do project when its Project has none, and only the
 * labels its repository has; a status or label of another repository would be a 400. A draft whose source moved on, or whose status is
 * already set, is left as it is. */
export function withOptions(draft: CreateDraft, source: string, options: CreateOptions | undefined): CreateDraft {
  if (options === undefined || draft.source !== source || draft.status !== undefined) return draft;
  return { ...draft, status: options.statuses[0] ?? null, labels: draft.labels.filter((l) => options.labels.includes(l)) };
}

// Module-level so the effect depends on the source alone: React's setters are stable. A failure shows the dialog's own line, and the route
// already left a GitHub failure's words in hive.log (Task 1). The route answers from the read model (#768), so there is no cache beyond the dialog's life
function requestOptions(source: string, setEntries: Dispatch<SetStateAction<Entries>>, setDraft: Dispatch<SetStateAction<CreateDraft>>): void {
  const put = (entry: OptionsEntry): void => setEntries((e) => ({ ...e, [source]: entry }));
  put({ state: 'loading' });
  getJson<CreateOptions>(`/sources/${encodeURIComponent(source)}/create-options`).then(
    (options) => { put({ state: 'ready', options }); setDraft((d) => withOptions(d, source, options)); },
    () => put({ state: 'failed' }),
  );
}

export function useCreateDraft(initial: { title?: string; workspace?: string; destination: CreateDraft['destination']; source?: string }): CreateDraftApi {
  const [draft, setDraft] = useState<CreateDraft>({
    title: initial.title ?? '', body: '', destination: initial.destination, workspace: initial.workspace, stage: undefined,
    source: initial.source, status: undefined, labels: [],
  });
  const [entries, setEntries] = useState<Entries>({});
  const patch = (change: Partial<CreateDraft>): void => setDraft((d) => ({ ...d, ...change }));
  // hive reads no source's options: the read waits for the github destination (decision 6)
  const wanted = draft.destination === 'github' ? draft.source : undefined;
  useEffect(() => {
    if (wanted !== undefined && entries[wanted] === undefined) requestOptions(wanted, setEntries, setDraft);
  }, [wanted, entries]);
  return {
    draft,
    options: wanted === undefined ? undefined : entries[wanted],
    retryOptions: () => { if (wanted !== undefined) requestOptions(wanted, setEntries, setDraft); },
    setTitle: (title) => patch({ title }), setBody: (body) => patch({ body }),
    setWorkspace: (workspace) => patch({ workspace }), setStage: (stage) => patch({ stage }),
    setDestination: (destination) => patch({ destination }),
    setSource: (source) => setDraft((d) => withOptions({ ...d, source, status: undefined }, source, readyOf(entries[source]))),
    setStatus: (status) => patch({ status }),
    addLabel: (label) => setDraft((d) => (d.labels.includes(label) ? d : { ...d, labels: [...d.labels, label] })),
    removeLabel: (label) => setDraft((d) => ({ ...d, labels: d.labels.filter((l) => l !== label) })),
  };
}
