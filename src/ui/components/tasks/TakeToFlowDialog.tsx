import { useState } from 'react';
import { DialogBase } from '@/components/DialogBase';
import { t } from '@/i18n';
import { taskLabel } from '../../../tasks';
import type { Flow, Stage, StageAction, Task } from '../../../types';
import { takeToFlow } from './flow-actions.js';

// A task is taken to a stage a person drives; the end of a flow runs by itself, so those stages are shown but never offered (#579)
const AUTOMATIC: readonly StageAction[] = ['commands', 'waitForCi', 'evaluate', 'deleteActivity'];

/** The stages to pick from and the run of automatic ones at the end of the flow, folded into one row. */
function split(stages: readonly Stage[]): { pickable: Stage[]; folded: Stage[] } {
  let cut = stages.length;
  while (cut > 0 && stages[cut - 1].action !== undefined && AUTOMATIC.includes(stages[cut - 1].action as StageAction)) cut -= 1;
  return { pickable: stages.slice(0, cut), folded: stages.slice(cut) };
}

interface Props { task: Task; flows: readonly Flow[]; open: boolean; onOpenChange(open: boolean): void }

/** Takes a task outside the flow to a stage of one flow (#579): the flow, then its stage, the entry preselected. */
export function TakeToFlowDialog({ task, flows, open, onOpenChange }: Props) {
  const [flowName, setFlowName] = useState(flows[0]?.name);
  const flow = flows.find((f) => f.name === flowName) ?? flows[0];
  const { pickable, folded } = split(flow?.stages ?? []);
  const [picked, setPicked] = useState<string>();
  const stage = pickable.find((s) => s.name === picked)?.name ?? pickable[0]?.name; // a switched flow falls back to its own entry
  const [error, setError] = useState<string>();

  const confirm = async (): Promise<void> => {
    const message = await takeToFlow(task, stage as string);
    if (message === undefined) return;
    setError(message === '' ? undefined : message);
    throw new Error(message); // a rejection holds the dialog open
  };
  return (
    <DialogBase
      open={open} onOpenChange={onOpenChange} title={t('takeToFlow.title')} context={taskLabel(task)} error={error}
      primary={{ label: t('takeToFlow.confirm'), shortcut: '↵', onConfirm: confirm, disabled: stage === undefined }}
    >
      <div className="flex flex-col gap-3">
        <fieldset aria-label={t('takeToFlow.flow')} className="flex flex-col gap-1.5">
          {flows.map((f) => (
            <label key={f.name} className="flex items-center gap-2 text-[13px]">
              <input type="radio" name="take-flow" value={f.name} checked={f.name === flow?.name} onChange={() => { setFlowName(f.name); setPicked(undefined); setError(undefined); }} />
              {f.name}
            </label>
          ))}
        </fieldset>
        <fieldset aria-label={t('takeToFlow.stage')} className="flex flex-col gap-1.5">
          {pickable.map((s, i) => (
            <label key={s.name} className="flex items-center gap-2 text-[13px]">
              <input type="radio" name="take-stage" value={s.name} checked={s.name === stage} onChange={() => setPicked(s.name)} />
              {s.name}
              {i === 0 && <span className="text-xs text-muted-foreground">{t('takeToFlow.entry')}</span>}
            </label>
          ))}
          {folded.length > 0 && <div className="pl-6 text-[13px] text-muted-foreground">{folded.map((s) => s.name).join(' · ')}</div>}
        </fieldset>
        <p className="text-xs text-muted-foreground">{t('takeToFlow.note')}</p>
      </div>
    </DialogBase>
  );
}
