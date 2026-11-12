import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { HIVE_SOURCE } from '../../tasks';
import type { State } from '../../types';
import { DialogBase } from '@/components/DialogBase';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { type CreateDraft, useCreateDraft } from '@/hooks/use-create-draft';
import { t } from '@/i18n';
import { postJson } from '@/lib/api';

export interface CreateTaskDialogProps {
  state: Pick<State, 'workspaces' | 'flows'>;
  title?: string; workspace?: string; // what the dialog opened with: the typed title, the workspace it opened in
  onOpenTask(taskId: string): void; onClose(): void;
}

// Radix items cannot carry an empty value, so sem fluxo has a value no stage can have: a NUL never appears in a stage name
const NO_FLOW = '\u0000no-flow';
const errorOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function Field({ id, label, optional = false, hint, children }: { id: string; label: string; optional?: boolean; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id} className="font-normal text-[13px] text-muted-foreground">
        {label}{optional && <small className="text-xs"> · {t('create.optional')}</small>}
      </Label>
      {children}
      {hint !== undefined && <span className="text-muted-foreground text-xs">{hint}</span>}
    </div>
  );
}

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

/** The create-task dialog (#771), hive destination: a task and nothing else, no activity starts. */
export function CreateTaskDialog({ state, title, workspace: opened, onOpenTask, onClose }: CreateTaskDialogProps) {
  // a workspace gone from the Comb is no pick: the menu could not show it, and the CTA would post it unseen
  const workspace = opened !== undefined && state.workspaces.includes(opened) ? opened : undefined;
  const api = useCreateDraft({ title, workspace });
  const { draft } = api;
  const [error, setError] = useState<string>();
  const picked = draft.workspace;
  // an edit after a refusal answers it: the old message would describe a draft that is no longer there
  const edited = <T,>(set: (value: T) => void) => (value: T): void => { setError(undefined); set(value); };
  const setTitle = edited(api.setTitle);
  const setBody = edited(api.setBody);
  const setWorkspace = edited(api.setWorkspace);
  const setStage = edited(api.setStage);

  const create = async (): Promise<void> => {
    if (picked === undefined) return;
    setError(undefined);
    try {
      const made = await postJson<{ id: string }>('/tasks', bodyOf(draft, picked));
      toast(t('create.done', { workspace: picked, stage: draft.stage ?? t('create.noFlow') }), { action: { label: t('create.open'), onClick: () => onOpenTask(made.id) } });
    } catch (err) {
      setError(errorOf(err));
      throw err; // keeps the dialog open
    }
  };

  return (
    <DialogBase
      open onOpenChange={(isOpen) => { if (!isOpen) onClose(); }} title={t('create.title')} context={t('create.context')} error={error}
      initialFocus="none"
      primary={{ label: t('create.submit'), onConfirm: create, disabled: draft.title.trim() === '' || picked === undefined }}
    >
      <div className="flex flex-col gap-4">
        <Field id="create-title" label={t('create.name')}>
          <Input id="create-title" autoFocus value={draft.title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field id="create-body" label={t('create.body')}>
          <Textarea id="create-body" value={draft.body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <Field id="create-workspace" label={t('create.workspace')}>
          <WorkspaceMenu workspaces={state.workspaces} current={workspace} value={picked} onPick={setWorkspace} />
        </Field>
        <Field id="create-stage" label={t('create.stage')} optional hint={t('create.stageHint')}>
          <StageMenu flows={state.flows} value={draft.stage} onPick={setStage} />
          {draft.stage === undefined && <span className="text-muted-foreground text-xs">{t('create.noFlowHint')}</span>}
        </Field>
      </div>
    </DialogBase>
  );
}
