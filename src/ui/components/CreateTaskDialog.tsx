import { useContext, useState } from 'react';
import { toast } from 'sonner';
import { HIVE_SOURCE } from '../../tasks';
import type { State } from '../../types';
import { CreateField as Field } from '@/components/CreateField';
import { CreateRouteBox } from '@/components/CreateRouteBox';
import { CreateIssueFields } from '@/components/CreateIssueFields';
import { type DialogAction, DialogBase } from '@/components/DialogBase';
import { SEGMENT } from '@/components/StartFields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { type CreateDraft, useCreateDraft } from '@/hooks/use-create-draft';
import { type IssueFailure, useCreateIssue } from '@/hooks/use-create-issue';
import { t } from '@/i18n';
import { postJson } from '@/lib/api';
import { type CreateTargets, CreateTargetsContext, preselect } from '@/lib/create-targets';

export interface CreateTaskDialogProps {
  state: Pick<State, 'workspaces' | 'flows' | 'sourceWorkspaces'>;
  title?: string; workspace?: string; source?: string; // what the dialog opened with: the typed title, its workspace, the source 4.4's header button names
  onOpenTask(taskId: string): void; onClose(): void;
}

// Radix items cannot carry an empty value, so sem fluxo has a value no stage can have: a NUL never appears in a stage name
const NO_FLOW = '\u0000no-flow';
const errorOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function WorkspaceMenu({ workspaces, current, value, onPick }: { workspaces: string[]; current?: string; value?: string; onPick(w: string): void }) {
  return (
    <Select value={value} onValueChange={onPick}>
      <SelectTrigger id="create-workspace" className="w-full"><SelectValue placeholder={t('create.workspacePlaceholder')} /></SelectTrigger>
      <SelectContent>
        {workspaces.map((w) => (
          <SelectItem key={w} value={w}>{w}{w === current && <span className="text-muted-foreground text-xs"> · {t('create.current')}</span>}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function StageMenu({ flows, value, onPick }: { flows: State['flows']; value?: string; onPick(stage: string | undefined): void }) {
  return (
    <Select value={value ?? NO_FLOW} onValueChange={(v) => onPick(v === NO_FLOW ? undefined : v)}>
      <SelectTrigger id="create-stage" className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_FLOW}>{t('create.noFlow')}</SelectItem>
        {flows.map((flow) => (
          <SelectGroup key={flow.name}>
            <SelectLabel>{flow.name}</SelectLabel>
            {flow.stages.map((s) => <SelectItem key={s.name} value={s.name}>{s.name}</SelectItem>)}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

const bodyOf = (d: CreateDraft, workspace: string) =>
  ({ title: d.title.trim(), body: d.body, source: HIVE_SOURCE, workspace, auto: false, ...(d.stage === undefined ? {} : { stage: d.stage }) });

// Decision 3: both options stay, the unavailable one disabled with its reason; decision 2: the hint only when the workspace picked the source
function DestinationSwitch({ value, targets, hint, onPick }: { value: CreateDraft['destination']; targets: CreateTargets; hint?: string; onPick(d: CreateDraft['destination']): void }) {
  const isGithubOff = targets.sources.length === 0;
  const lines = [...(hint === undefined ? [] : [hint]), ...(targets.hiveSource ? [] : [t('create.hiveOff')]), ...(isGithubOff ? [t('create.noRepository')] : [])];
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span id="create-in" className="text-[13px] text-muted-foreground">{t('create.in')}</span>
      <ToggleGroup type="single" aria-labelledby="create-in" value={value} onValueChange={(v) => { if (v) onPick(v as CreateDraft['destination']); }} className="w-full gap-0.5 bg-muted p-0.5">
        <ToggleGroupItem value="hive" disabled={!targets.hiveSource} className={SEGMENT}>{t('create.inHive')}</ToggleGroupItem>
        <ToggleGroupItem value="github" disabled={isGithubOff} className={SEGMENT}>{t('create.inGithub')}</ToggleGroupItem>
      </ToggleGroup>
      {lines.map((line) => <span key={line} className="text-muted-foreground text-xs">{line}</span>)}
    </div>
  );
}

interface HiveFieldsProps { draft: CreateDraft; workspaces: string[]; current?: string; flows: State['flows']; onWorkspace(w: string): void; onStage(stage: string | undefined): void }

function HiveFields({ draft, workspaces, current, flows, onWorkspace, onStage }: HiveFieldsProps) {
  return (
    <>
      <Field id="create-workspace" label={t('create.workspace')}>
        <WorkspaceMenu workspaces={workspaces} current={current} value={draft.workspace} onPick={onWorkspace} />
      </Field>
      <Field id="create-stage" label={t('create.stage')} note={t('create.optional')} hint={t('create.stageHint')}>
        <StageMenu flows={flows} value={draft.stage} onPick={onStage} />
        {draft.stage === undefined && <span className="text-muted-foreground text-xs">{t('create.noFlowHint')}</span>}
      </Field>
    </>
  );
}

// #771: the hive task, posted exactly as before; a refusal stays on screen and rethrows to keep the dialog open
function hiveAction(draft: CreateDraft, setError: (error: string | undefined) => void, onOpenTask: (id: string) => void): DialogAction {
  const { workspace } = draft;
  const create = async (): Promise<void> => {
    if (workspace === undefined) return;
    setError(undefined);
    try {
      const made = await postJson<{ id: string }>('/tasks', bodyOf(draft, workspace));
      toast(t('create.done', { workspace, stage: draft.stage ?? t('create.noFlow') }), { action: { label: t('create.open'), onClick: () => onOpenTask(made.id) } });
    } catch (err) {
      setError(errorOf(err));
      throw err; // keeps the dialog open
    }
  };
  return { label: t('create.submit'), onConfirm: create, disabled: draft.title.trim() === '' || workspace === undefined };
}

// Decisions 13 to 15: the dialog's own words, the repository named; the server's are in hive.log (Task 1)
function IssueFailureLine({ failure }: { failure: IssueFailure }) {
  // a 400 created nothing, so the retry is safe once a field changes (decision 15); its line says why, not that GitHub failed
  if (failure.kind !== 'placed') return <>{t(failure.kind === 'refused' ? 'create.issueRefused' : 'create.issueFailed', { repository: failure.repository })}</>;
  const { id, url } = failure.ref;
  return (
    <>
      {t('create.issuePlaced', { id, repository: failure.repository })}{' '}
      <Button type="button" variant="link" size="xs" className="h-auto p-0" onClick={() => window.open(url, '_blank', 'noreferrer')}>{t('create.viewOnGitHub')}</Button>
    </>
  );
}

// The CTA per answer (decisions 10, 13 and 14): busy, a retry of the same body, or fechar once the issue exists, which posts nothing
function issueAction({ failure, isPosting, create }: ReturnType<typeof useCreateIssue>, isReady: boolean): DialogAction {
  if (failure?.kind === 'placed') return { label: t('create.close'), onConfirm: () => undefined };
  const label = isPosting ? 'create.creatingIssue' : failure?.kind === 'retry' ? 'create.retry' : 'create.submitIssue';
  return { label: t(label), onConfirm: create, disabled: !isReady };
}

/** The create-task dialog (#771, #772): a hive task or a GitHub issue, and nothing else, no activity starts. */
export function CreateTaskDialog({ state, title, workspace: opened, source, onOpenTask, onClose }: CreateTaskDialogProps) {
  // a workspace gone from the Comb is no pick: the menu could not show it, and the CTA would post it unseen
  const workspace = opened !== undefined && state.workspaces.includes(opened) ? opened : undefined;
  const targets = useContext(CreateTargetsContext);
  // the destination the dialog opened on: computed once, so a later config push does not move the user's pick
  const [picked] = useState(() => preselect({ workspace, source }, targets, state.sourceWorkspaces));
  const api = useCreateDraft({ title, workspace, destination: picked.destination, source: picked.source ?? targets.sources[0]?.name });
  const { draft } = api;
  const [error, setError] = useState<string>();
  const repository = targets.sources.find((s) => s.name === draft.source)?.repository;
  const issue = useCreateIssue({ draft, repository, flows: state.flows, onOpenTask });
  const isGithub = draft.destination === 'github';
  const hint = picked.hinted && isGithub && opened !== undefined ? t('create.hinted', { workspace: opened }) : undefined;
  // an edit after a refusal answers it: the old message would describe a draft that is no longer there
  const edited = <T,>(set: (value: T) => void) => (value: T): void => { setError(undefined); issue.clear(); set(value); };
  // status is set once the source's options arrived (decision 6); a repository a config push took away would make the create a silent no-op
  const isIssueReady = draft.title.trim() !== '' && draft.status !== undefined && repository !== undefined;
  const { status } = draft;
  // no box without the source's config: routeOf would answer a confident "no source takes it" for an issue the poll takes
  const hasConfig = targets.configs?.some((s) => s.name === draft.source) === true;
  const routeBox = isGithub && status !== undefined && draft.source !== undefined && hasConfig
    ? <CreateRouteBox source={draft.source} title={draft.title} labels={draft.labels} status={status} sources={targets.configs ?? []} flows={state.flows} /> : null;
  // #774 decision 9: a source header names its table; from ⌘P the line is unchanged
  const context = source === undefined ? t('create.context') : `${t('create.context')}${t('create.fromSource', { source })}`;
  const primary: DialogAction = isGithub ? issueAction(issue, isIssueReady) : hiveAction(draft, setError, onOpenTask);

  return (
    <DialogBase
      open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }} title={t('create.title')} context={context}
      error={isGithub ? issue.failure && <IssueFailureLine failure={issue.failure} /> : error}
      initialFocus="none" primary={primary}
    >
      <div className="flex flex-col gap-4">
        <Field id="create-title" label={t('create.name')}>
          <Input id="create-title" autoFocus value={draft.title} onChange={(e) => edited(api.setTitle)(e.target.value)} />
        </Field>
        <Field id="create-body" label={t('create.body')}>
          <Textarea id="create-body" value={draft.body} onChange={(e) => edited(api.setBody)(e.target.value)} />
        </Field>
        <DestinationSwitch value={draft.destination} targets={targets} hint={hint} onPick={edited(api.setDestination)} />
        {isGithub ? <CreateIssueFields draft={draft} sources={targets.sources} options={api.options} onRetry={api.retryOptions} onSource={edited(api.setSource)} onStatus={edited(api.setStatus)} onAddLabel={edited(api.addLabel)} onRemoveLabel={edited(api.removeLabel)} /> : <HiveFields draft={draft} workspaces={state.workspaces} current={workspace} flows={state.flows} onWorkspace={edited(api.setWorkspace)} onStage={edited(api.setStage)} />}
        {routeBox}
      </div>
    </DialogBase>
  );
}
