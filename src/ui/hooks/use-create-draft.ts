import { useState } from 'react';

/** The create-task dialog's draft (#771). A plain object so a later destination, source, status or labels field joins it without reshaping.
 * stage undefined = sem fluxo. */
export interface CreateDraft { title: string; body: string; workspace: string | undefined; stage: string | undefined }

export interface CreateDraftApi {
  draft: CreateDraft;
  setTitle(title: string): void; setBody(body: string): void; setWorkspace(workspace: string): void; setStage(stage: string | undefined): void;
}

export function useCreateDraft(initial: { title?: string; workspace?: string }): CreateDraftApi {
  const [draft, setDraft] = useState<CreateDraft>({ title: initial.title ?? '', body: '', workspace: initial.workspace, stage: undefined });
  const patch = (change: Partial<CreateDraft>): void => setDraft((d) => ({ ...d, ...change }));
  return {
    draft,
    setTitle: (title) => patch({ title }), setBody: (body) => patch({ body }),
    setWorkspace: (workspace) => patch({ workspace }), setStage: (stage) => patch({ stage }),
  };
}
