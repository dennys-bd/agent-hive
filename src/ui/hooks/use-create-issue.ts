import { useState } from 'react';
import { toast } from 'sonner';
import type { State } from '../../types.js';
import type { CreateDraft } from '@/hooks/use-create-draft';
import { t } from '@/i18n';
import { postJson } from '@/lib/api';

const HTTP_BAD_REQUEST = 400;

type IssueRef = { number: number; url: string };
/** POST /tasks' answer for an issue (src/create-task.ts `Created`, #767): the task once a source listed it, else why not. */
export type IssueAnswer = { id: string; issue: IssueRef; stage?: string } | { issue: IssueRef; notice: string };
/** Why the issue was not made (decisions 13 to 15); placed: it exists, off the Project, so nothing may post it again. */
export type IssueFailure = { kind: 'retry' | 'refused'; repository: string } | { kind: 'placed'; repository: string; issue: IssueRef };

/** Decision 10: never workspace, stage or auto; the issue takes the auto its source's task properties give. */
export const issueBodyOf = (draft: CreateDraft, source: string, status: string | null) =>
  ({ title: draft.title.trim(), body: draft.body, source, labels: draft.labels, status });

/** parseJson's error carries the status and the body (src/ui/lib/api.ts); a 502 that made the issue names it in body.issue (#767). */
export function failureOf(err: unknown, repository: string): IssueFailure {
  const { status, body } = (err ?? {}) as { status?: unknown; body?: { issue?: IssueRef } };
  if (body?.issue !== undefined) return { kind: 'placed', repository, issue: body.issue };
  return { kind: status === HTTP_BAD_REQUEST ? 'refused' : 'retry', repository };
}

/** Decision 11: the flow is named only when the Comb has more than one, so it tells something apart. */
export function whereOf(flows: State['flows'], stage: string): string {
  const flow = flows.find((f) => f.stages.some((s) => s.name === stage));
  return flows.length > 1 && flow !== undefined ? `${flow.name} · ${stage}` : stage;
}

/** Decisions 11 and 12: the task's toast with abrir, or the info toast with ver no GitHub for an issue no source lists yet. */
export function toastIssue(made: IssueAnswer, { flows, isOffProject, onOpenTask }: { flows: State['flows']; isOffProject: boolean; onOpenTask(id: string): void }): void {
  const { number, url } = made.issue;
  if ('id' in made) {
    const message = made.stage === undefined ? t('create.issueNoFlow', { number }) : t('create.issueDone', { number, where: whereOf(flows, made.stage) });
    toast(message, { action: { label: t('create.open'), onClick: () => onOpenTask(made.id) } });
    return;
  }
  toast.info(t('create.issueOutside', { number }), {
    description: t(isOffProject ? 'create.issueOffProject' : 'create.issueOutsideHint'),
    action: { label: t('create.viewOnGitHub'), onClick: () => window.open(url, '_blank', 'noreferrer') },
  });
}

export function useCreateIssue({ draft, repository, flows, onOpenTask }: { draft: CreateDraft; repository: string | undefined; flows: State['flows']; onOpenTask(id: string): void }) {
  const [failure, setFailure] = useState<IssueFailure>();
  const [isPosting, setIsPosting] = useState(false);
  const create = async (): Promise<void> => {
    const { source, status } = draft;
    if (source === undefined || status === undefined || repository === undefined) return;
    setFailure(undefined);
    setIsPosting(true);
    try {
      toastIssue(await postJson<IssueAnswer>('/tasks', issueBodyOf(draft, source, status)), { flows, isOffProject: status === null, onOpenTask });
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
