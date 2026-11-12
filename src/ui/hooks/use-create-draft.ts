import { useState } from 'react';

/** The create-task dialog's draft (#771, #772 decision 9). Switching destination keeps every field, so switching back restores them.
 * stage undefined = sem fluxo. */
export interface CreateDraft {
  title: string; body: string;
  destination: 'hive' | 'github';
  workspace: string | undefined; stage: string | undefined; // hive
  source: string | undefined; // github
}

export interface CreateDraftApi {
  draft: CreateDraft;
  setTitle(title: string): void; setBody(body: string): void; setWorkspace(workspace: string): void; setStage(stage: string | undefined): void;
  setDestination(destination: CreateDraft['destination']): void;
}

export function useCreateDraft(initial: { title?: string; workspace?: string; destination: CreateDraft['destination']; source?: string }): CreateDraftApi {
  const [draft, setDraft] = useState<CreateDraft>({
    title: initial.title ?? '', body: '', destination: initial.destination, workspace: initial.workspace, stage: undefined, source: initial.source,
  });
  const patch = (change: Partial<CreateDraft>): void => setDraft((d) => ({ ...d, ...change }));
  return {
    draft,
    setTitle: (title) => patch({ title }), setBody: (body) => patch({ body }),
    setWorkspace: (workspace) => patch({ workspace }), setStage: (stage) => patch({ stage }),
    setDestination: (destination) => patch({ destination }),
  };
}
