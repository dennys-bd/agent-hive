import { LockIcon } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { isLocked as isLockedExperiment, mergeArm } from '../../../../benchmark/arms.js';
import { canonicalJson } from '../../../../benchmark/canonical.js';
import type { Arm, ArmSetup, Experiment, LaunchOptions } from '../../../../types';
import { TASKS_HASH_CHARS } from '@/components/benchmark/arms/ArmCard';
import { editArm, patchBase } from '@/components/benchmark/arms/arm-api';
import { armRows, cleanSetup, countText, diffOverrides, readRow, type RowKey, rowLabel, rowText, type RowValues, writeRow } from '@/components/benchmark/arms/arm-rows';
import { ItemsField } from '@/components/benchmark/arms/ItemsField';
import { ChipList } from '@/components/benchmark/arms/ChipList';
import { RulesField, WorktreeField } from '@/components/benchmark/arms/ListFields';
import { FixedRows } from '@/components/benchmark/arms/FixedRows';
import { GroupHeading, RowGroup } from '@/components/benchmark/arms/RowGroup';
import { StageFields } from '@/components/benchmark/arms/StageFields';
import { TasksField } from '@/components/benchmark/arms/TasksField';
import { DialogBase } from '@/components/DialogBase';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useLaunchOptions } from '@/hooks/use-launch-options';
import { t } from '@/i18n';
import { listOf } from '@/lib/settings-languages';
import { isMac } from '@/lib/shortcut-bindings';

export interface Draft {
  base: ArmSetup; setup: ArmSetup; start: ArmSetup; isArm: boolean; count: number;
  isOverridden(key: RowKey): boolean; edit<K extends RowKey>(key: K, value: RowValues[K]): void; reset(key: RowKey): void;
}

// Opening copies the base and the arm's merged setup (or the base) into local state; every edit changes only the draft. The base is frozen
// with it, so a base edited elsewhere meanwhile never turns the fields the arm left alone into overrides
function useDraft(experiment: Experiment, arm: Arm | undefined, isArm: boolean): Draft {
  const [base] = useState(() => experiment.base);
  const [start] = useState(() => (arm === undefined ? base : mergeArm(base, arm.overrides)));
  const [setup, setSetup] = useState(start);
  // An arm's draft stays the merge of its overrides, so a field set back to the base's value stops counting at once
  const settle = (next: ArmSetup): ArmSetup => (!isArm ? next : mergeArm(base, diffOverrides(base, next)));
  const rows = armRows(base, diffOverrides(base, setup));
  return {
    base, setup, start, isArm, count: rows.filter((r) => r.overridden).length,
    isOverridden: (key) => rows.some((r) => r.key === key && r.overridden),
    edit: (key, value) => setSetup((s) => settle(writeRow(s, key, value))),
    reset: (key) => setSetup((s) => settle(writeRow(s, key, readRow(base, key)))),
  };
}

// One post, only when the draft changed: an arm's overrides as what differs from the base, or the whole base
async function save(experiment: Experiment, arm: Arm | undefined, draft: Draft): Promise<boolean> {
  const setup = cleanSetup(draft.setup);
  if (canonicalJson(setup) === canonicalJson(cleanSetup(draft.start))) return true;
  return arm === undefined ? patchBase(experiment.id, setup) : editArm(experiment.id, arm.id, { overrides: diffOverrides(draft.base, setup) });
}

/** The letters of the arms that override a row, in arm order: the base's state column. */
export const overriddenBy = (experiment: Experiment, key: RowKey): string[] =>
  experiment.arms.filter((a) => armRows(experiment.base, a.overrides).some((r) => r.key === key && r.overridden)).map((a) => a.letter);

interface BodyProps { draft: Draft; options?: LaunchOptions; experiment: Experiment; isLocked: boolean; isOnlyOverrides: boolean; onShowConfig(): void }

function SettingsBody({ draft, options, experiment, isLocked, isOnlyOverrides, onShowConfig }: BodyProps) {
  const rowOf = (key: RowKey, children: ReactNode, was?: ReactNode): ReactNode => (
    <RowGroup
      key={key} label={t(rowLabel(key))} isArm={draft.isArm} isLocked={isLocked} isOverridden={draft.isOverridden(key)} locksItself={key === 'tasks'} was={was}
      overriddenBy={draft.isArm ? [] : overriddenBy(experiment, key)} onReset={() => draft.reset(key)}
    >
      {children}
    </RowGroup>
  );
  // Only overrides: an arm's untouched rows go, and so do the headings over them
  const group = (key: RowKey, children: ReactNode, was?: ReactNode): ReactNode => (isOnlyOverrides && !draft.isOverridden(key) ? null : rowOf(key, children, was));
  const heading = (title: string, hint?: string): ReactNode => (isOnlyOverrides ? null : <GroupHeading title={title} hint={hint} />);
  const { setup } = draft;
  const baseTasks = `${rowText(draft.base, 'tasks')} · t·${experiment.tasksHash.slice(0, TASKS_HASH_CHARS)}`;
  return (
    <div className="flex min-w-0 flex-col pb-2">
      {!draft.isArm && <FixedRows experiment={experiment} onShowConfig={onShowConfig} />}
      <StageFields draft={draft} options={options} group={group} />
      {heading(t('benchmark.arms.settings.group.items'))}
      {group('plugins', <ChipList id="arm-plugins" addLabel={t('benchmark.arms.settings.addPlugin')} placeholder={t('benchmark.arms.settings.pluginPlaceholder')} value={setup.plugins} isReadOnly={isLocked} onChange={(v) => draft.edit('plugins', v)} />)}
      {group('items', <ItemsField experimentId={experiment.id} value={setup.items} onChange={(v) => draft.edit('items', v)} />)}
      {heading(t('benchmark.arms.settings.group.tasks'), t('benchmark.arms.settings.group.tasksHint'))}
      {group('tasks', <TasksField value={setup.tasks} isReadOnly={isLocked} summary={draft.isArm && !draft.isOverridden('tasks') ? baseTasks : undefined} onChange={(v) => draft.edit('tasks', v)} />, draft.isArm && draft.isOverridden('tasks') ? <TasksWas text={baseTasks} /> : undefined)}
      {heading(t('benchmark.arms.settings.group.rules'))}
      {group('rules', <RulesField value={setup.rules} isReadOnly={isLocked} onChange={(v) => draft.edit('rules', v)} />)}
      {group('worktree', <WorktreeField value={setup.worktree} onChange={(v) => draft.edit('worktree', v)} />)}
    </div>
  );
}

// The base's tasks struck, and the yellow line: the arm's own tasks are not the base's, so its runs compare per run only
function TasksWas({ text }: { text: string }) {
  return (
    <>
      <span>{t('benchmark.arms.settings.wasBase')} <s>{text}</s></span>
      <p className="m-0 flex items-start gap-1.5 text-waiting"><span aria-hidden="true">●</span>{t('benchmark.arms.tasksWarning')}</p>
    </>
  );
}

function SettingsTitle({ arm }: { arm?: Arm }) {
  if (arm === undefined) return <>{t('benchmark.arms.settings.baseTitle')}</>;
  // the literal space keeps the accessible name "B Skills do plugin"; the flex gap ignores it
  return <span className="flex items-center gap-2.5"><Badge variant="secondary">{arm.letter}</Badge>{' '}{arm.name.charAt(0).toUpperCase() + arm.name.slice(1)}</span>;
}

interface ContextProps { draft: Draft; isLocked: boolean; isOnlyOverrides: boolean; onOnlyOverrides(isOn: boolean): void }

function SettingsContext({ draft, isLocked, isOnlyOverrides, onOnlyOverrides }: ContextProps) {
  const text = !draft.isArm ? t('benchmark.arms.settings.context.base')
    : draft.count === 0 ? t('benchmark.arms.settings.context.none') : t('benchmark.arms.settings.context.arm', { count: countText(draft.count) });
  return (
    <>
      <span className="flex items-center gap-3">
        <span className="flex-1">{text}</span>
        {draft.isArm && (
          <span className="flex items-center gap-2">
            <label htmlFor="arm-only-overrides" className="text-xs">{t('benchmark.arms.settings.onlyOverrides')}</label>
            <Switch id="arm-only-overrides" checked={isOnlyOverrides} onCheckedChange={onOnlyOverrides} />
          </span>
        )}
      </span>
      {isLocked && <span role="status" className="mt-1 flex items-center gap-1.5 text-xs"><LockIcon aria-hidden="true" className="size-3" />{t('benchmark.arms.settings.locked')}</span>}
    </>
  );
}

export interface ArmSettingsProps { experiment: Experiment; armId?: string; onClose(): void; onShowConfig(): void; onOpenFlowSettings?(): void } // onOpenFlowSettings: the flow group's link to Settings, left out when absent

/** An arm's settings, or the base's when armId is absent (#462, #536). Editing changes a draft; salvar posts it once when it changed, and
 *  cancelar, Esc, the × and the overlay drop it. A refused post keeps the dialog open behind the toast. While the experiment runs or sleeps it
 *  opens read only. */
export function ArmSettings({ experiment, armId, onClose, onShowConfig }: ArmSettingsProps) {
  const arm = experiment.arms.find((a) => a.id === armId);
  const isGone = armId !== undefined && arm === undefined; // removed elsewhere while open: never fall back to editing the base
  const draft = useDraft(experiment, arm, armId !== undefined);
  const isLocked = isLockedExperiment(experiment);
  const options = useLaunchOptions(experiment.workspace);
  const [isOnlyOverrides, setOnlyOverrides] = useState(false);
  useEffect(() => { if (isGone) onClose(); }, [isGone, onClose]);
  if (isGone) return null;
  // A rejection keeps the dialog open: arm-api already told why
  const saveDraft = async (): Promise<void> => { if (!(await save(experiment, arm, draft))) throw new Error('save refused'); };
  const letters = listOf(experiment.arms.map((a) => a.letter), t('settings.formatters.and'));
  const isEmpty = isOnlyOverrides && draft.count === 0;
  return (
    <DialogBase
      open size="wide" isOverlayDismissable primaryKey="mod" title={<SettingsTitle arm={arm} />}
      onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}
      cancelLabel={isLocked ? t('benchmark.arms.settings.close') : t('benchmark.arms.settings.cancel')}
      context={<SettingsContext draft={draft} isLocked={isLocked} isOnlyOverrides={isOnlyOverrides} onOnlyOverrides={setOnlyOverrides} />}
      footerNote={draft.isArm ? t('benchmark.arms.settings.footer.arm') : t('benchmark.arms.settings.footer.base', { arms: letters })}
      primary={isLocked ? undefined : { label: t('benchmark.arms.settings.save'), shortcut: isMac() ? '⌘↵' : 'Ctrl+↵', onConfirm: saveDraft }}
    >
      {isEmpty && <p className="m-0 py-6 text-[13px] text-muted-foreground">{t('benchmark.arms.settings.onlyEmpty')}</p>}
      <SettingsBody draft={draft} options={options} experiment={experiment} isLocked={isLocked} isOnlyOverrides={isOnlyOverrides} onShowConfig={onShowConfig} />
    </DialogBase>
  );
}
