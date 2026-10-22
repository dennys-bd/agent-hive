import { type ReactNode, useRef, useState } from 'react';
import { isLocked as isLockedExperiment, mergeArm } from '../../../../benchmark/arms.js';
import { canonicalJson } from '../../../../benchmark/canonical.js';
import type { Arm, ArmSetup, Experiment, LaunchOptions } from '../../../../types';
import { editArm, patchBase } from '@/components/benchmark/arms/arm-api';
import { armRows, cleanSetup, countText, diffOverrides, readRow, type RowKey, rowLabel, type RowValues, writeRow } from '@/components/benchmark/arms/arm-rows';
import { ItemsField } from '@/components/benchmark/arms/ItemsField';
import { ListField, RulesField, WorktreeField } from '@/components/benchmark/arms/ListFields';
import { RowGroup } from '@/components/benchmark/arms/RowGroup';
import { StageFields } from '@/components/benchmark/arms/StageFields';
import { TasksField } from '@/components/benchmark/arms/TasksField';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLaunchOptions } from '@/hooks/use-launch-options';
import { t } from '@/i18n';

export interface Draft {
  base: ArmSetup; setup: ArmSetup; start: ArmSetup; isArm: boolean; count: number;
  isOverridden(key: RowKey): boolean; edit<K extends RowKey>(key: K, value: RowValues[K]): void; reset(key: RowKey): void;
}

// Opening copies the arm's merged setup (or the base) into local state; every edit changes only the draft
function useDraft(experiment: Experiment, arm: Arm | undefined): Draft {
  const { base } = experiment;
  const [start] = useState(() => (arm === undefined ? base : mergeArm(base, arm.overrides)));
  const [setup, setSetup] = useState(start);
  // An arm's draft stays the merge of its overrides, so a field set back to the base's value stops counting at once
  const settle = (next: ArmSetup): ArmSetup => (arm === undefined ? next : mergeArm(base, diffOverrides(base, next)));
  const rows = armRows(base, diffOverrides(base, setup));
  return {
    base, setup, start, isArm: arm !== undefined, count: rows.filter((r) => r.overridden).length,
    isOverridden: (key) => rows.some((r) => r.key === key && r.overridden),
    edit: (key, value) => setSetup((s) => settle(writeRow(s, key, value))),
    reset: (key) => setSetup((s) => settle(writeRow(s, key, readRow(base, key)))),
  };
}

// One post, only when the draft changed: an arm's overrides as what differs from the base, or the whole base
async function save(experiment: Experiment, arm: Arm | undefined, draft: Draft): Promise<boolean> {
  const setup = cleanSetup(draft.setup);
  if (canonicalJson(setup) === canonicalJson(cleanSetup(draft.start))) return true;
  return arm === undefined ? patchBase(experiment.id, setup) : editArm(experiment.id, arm.id, { overrides: diffOverrides(experiment.base, setup) });
}

function SettingsBody({ draft, options, experimentId }: { draft: Draft; options?: LaunchOptions; experimentId: string }) {
  const group = (key: RowKey, children: ReactNode): ReactNode => (
    <RowGroup key={key} label={t(rowLabel(key))} isArm={draft.isArm} isOverridden={draft.isOverridden(key)} onReset={() => draft.reset(key)}>{children}</RowGroup>
  );
  const { setup } = draft;
  return (
    <>
      <StageFields draft={draft} options={options} group={group} />
      {group('plugins', <ListField id="arm-plugins" label={t('benchmark.arms.settings.listHint')} value={setup.plugins} onChange={(v) => draft.edit('plugins', v)} />)}
      {group('items', <ItemsField experimentId={experimentId} value={setup.items} onChange={(v) => draft.edit('items', v)} />)}
      {group('tasks', <TasksField value={setup.tasks} onChange={(v) => draft.edit('tasks', v)} />)}
      {group('rules', <RulesField value={setup.rules} onChange={(v) => draft.edit('rules', v)} />)}
      {group('worktree', <WorktreeField value={setup.worktree} onChange={(v) => draft.edit('worktree', v)} />)}
    </>
  );
}

export interface ArmSettingsProps { experiment: Experiment; armId?: string; onClose(): void }

/** An arm's settings, or the base's when armId is absent (#462). Closing (the button, Esc, the overlay) posts once when the draft changed; a
 *  refused post keeps it open behind the toast. While the experiment runs or sleeps it opens read only. */
export function ArmSettings({ experiment, armId, onClose }: ArmSettingsProps) {
  const arm = experiment.arms.find((a) => a.id === armId);
  const draft = useDraft(experiment, arm);
  const isLocked = isLockedExperiment(experiment);
  const options = useLaunchOptions(experiment.workspace);
  const isSaving = useRef(false); // Esc and the button together must not post twice
  const close = async (): Promise<void> => {
    if (isSaving.current) return;
    isSaving.current = true;
    const isSaved = isLocked || (await save(experiment, arm, draft));
    isSaving.current = false;
    if (isSaved) onClose();
  };
  const title = arm === undefined ? t('benchmark.arms.settings.baseTitle') : t('benchmark.arms.settings.title', { letter: arm.letter, name: arm.name });
  const context = isLocked ? t('benchmark.arms.settings.locked') : arm === undefined ? t('benchmark.arms.base.hint') : countText(draft.count);
  return (
    <Dialog open onOpenChange={(isOpen) => { if (!isOpen) void close(); }}>
      <DialogContent size="wide" showCloseButton={false} className="max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription className="text-[13px]">{context}</DialogDescription></DialogHeader>
        <fieldset disabled={isLocked} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
          <SettingsBody draft={draft} options={options} experimentId={experiment.id} />
        </fieldset>
        <DialogFooter><Button type="button" size="sm" onClick={() => void close()}>{t('benchmark.arms.settings.close')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
