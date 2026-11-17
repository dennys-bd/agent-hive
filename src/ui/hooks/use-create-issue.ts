import { useState } from 'react';
import { toast } from 'sonner';
import type { CreatedRef, SourceFields, State } from '../../types.js';
import type { CreateDraft } from '@/hooks/use-create-draft';
import { t } from '@/i18n';
import { postJson } from '@/lib/api';
import { ISSUE_COPY, type IssueCopy } from '@/lib/create-targets';

const HTTP_BAD_REQUEST = 400;

/** POST /tasks' answer for an issue (src/create-task.ts `Created`, #767): the task once a source listed it, else why not. */
export type IssueAnswer = { id: string; ref: CreatedRef; stage?: string } | { ref: CreatedRef; notice: string };
/** Why the issue was not made (decisions 13 to 15); placed: it exists, off the Project, so nothing may post it again. */
export type IssueFailure = { kind: 'retry' | 'refused'; repository: string; reason?: string } | { kind: 'placed'; repository: string; ref: CreatedRef };

/** Decision 10: never workspace, stage or auto; the issue takes the auto its source's task properties give. #831: the type when the source has them. */
export const issueBodyOf = (draft: CreateDraft, source: string, status: string | null) =>
  ({ title: draft.title.trim(), body: draft.body, source, labels: draft.labels, status, ...(draft.issueType === undefined ? {} : { issueType: draft.issueType }) });

/** `repository` holds where the issue goes: the repository, or the Jira project (#831). A refusal keeps the server's words as its reason.
 * parseJson's error carries the status and the body (src/ui/lib/api.ts); a 502 that made the issue names it in body.ref (#767, #811). */
export function failureOf(err: unknown, repository: string): IssueFailure {
  const { status, body } = (err ?? {}) as { status?: unknown; body?: { ref?: CreatedRef; error?: unknown } };
  if (body?.ref !== undefined) return { kind: 'placed', repository, ref: body.ref };
  return { kind: status === HTTP_BAD_REQUEST ? 'refused' : 'retry', repository, ...(typeof body?.error === 'string' ? { reason: body.error } : {}) };
}

/** Decision 11: the flow is named only when the Comb has more than one, so it tells something apart. */
export function whereOf(flows: State['flows'], stage: string): string {
  const flow = flows.find((f) => f.stages.some((s) => s.name === stage));
  return flows.length > 1 && flow !== undefined ? `${flow.name} · ${stage}` : stage;
}

/** Decisions 11 and 12: the task's toast with abrir, or the info toast with ver no GitHub or Jira for an issue no source lists yet. */
export function toastIssue(made: IssueAnswer, { flows, isOffProject, onOpenTask, copy }: { flows: State['flows']; isOffProject: boolean; onOpenTask(id: string): void; copy: IssueCopy }): void {
  const refId = `${copy.refPrefix}${made.ref.id}`; // #831: GitHub's #912, Jira's ABC-7
  const { url } = made.ref;
  if ('id' in made) {
    const message = made.stage === undefined ? t('create.issueNoFlow', { id: refId }) : t('create.issueDone', { id: refId, where: whereOf(flows, made.stage) });
    toast(message, { action: { label: t('create.open'), onClick: () => onOpenTask(made.id) } });
    return;
  }
  toast.info(t('create.issueOutside', { id: refId }), {
    description: t(isOffProject ? 'create.issueOffProject' : 'create.issueOutsideHint'),
    action: { label: t(copy.view), onClick: () => window.open(url, '_blank', 'noreferrer') },
  });
}

export function useCreateIssue({ draft, repository, type, flows, onOpenTask }: { draft: CreateDraft; repository: string | undefined; type: SourceFields['type'] | undefined; flows: State['flows']; onOpenTask(id: string): void }) {
  const [failure, setFailure] = useState<IssueFailure>();
  const [isPosting, setIsPosting] = useState(false);
  const create = async (): Promise<void> => {
    const { source, status } = draft;
    if (source === undefined || status === undefined || repository === undefined || type === undefined) return;
    setFailure(undefined);
    setIsPosting(true);
    try {
      toastIssue(await postJson<IssueAnswer>('/tasks', issueBodyOf(draft, source, status)), { flows, isOffProject: status === null, onOpenTask, copy: ISSUE_COPY[type] });
    } catch (err) {
      setFailure(failureOf(err, repository)); // the dialog's own words (decision 13); the server left its own in hive.log (Task 1)
      throw err; // keeps the dialog open
    } finally {
      setIsPosting(false);
    }
  };
  // an edit answers a refusal (#771); an issue already made stays said, so no edit turns fechar back into a second create (decision 14)
  const clear = (): void => setFailure((f) => (f?.kind === 'placed' ? f : undefined));
  return { failure, isPosting, create, clear };
}
