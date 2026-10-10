import { useState } from 'react';
import type { AgentProps } from '@/components/settings/StageBlocks';
import { type ChartSelection, StageChart } from '@/components/settings/StageChart';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { StageDetail } from '@/components/settings/StageDetail';
import { TransitionEditor } from '@/components/settings/TransitionEditor';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { emptyStage, type StageDraft } from '@/lib/settings-stages';
import { emptyTransition, type TransitionDraft, withoutStage } from '@/lib/settings-transitions';
import type { Command, SourceFields } from '../../../types';

/** A source row of Settings › fluxo (#180): its draft id, its shown name, its type (what it can do, #286) and its loaded columns. */
export interface StageSource { id: string; name: string; type: SourceFields['type']; options: string[] }

interface Flow { stages: StageDraft[]; transitions: TransitionDraft[] }
interface StageEditorProps extends AgentProps, Flow { sources: StageSource[]; commands: Command[]; workspaces: string[]; onChange(next: Flow): void }

// + etapa and + transição in the card's header (#887, 6b); + transição needs a stage to leave from
function StageActions({ onAddStage, onAddTransition, canAddTransition }: { onAddStage(): void; onAddTransition(): void; canAddTransition: boolean }) {
  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={onAddStage}>{t('settings.stages.add')}</Button>
      <Button type="button" variant="ghost" size="sm" onClick={onAddTransition} disabled={!canAddTransition}>{t('settings.transitions.add')}</Button>
    </>
  );
}

// The stage whose saídas opened the selected transition (#887); one gone since (a reverted draft) gives no way back
const backOf = (selection: ChartSelection, stages: readonly StageDraft[]): StageDraft | undefined =>
  (selection.kind === 'transition' && selection.back !== undefined ? stages.find((s) => s.id === selection.back) : undefined);

/** Settings › fluxo's etapas card (#134, 6b; its own card since #887): + etapa and + transição in the header, the load hint, the chart, its
 * legend, then the selected stage's or transition's editor. Every update is immutable; the selection is local, and a stale id (a reverted draft)
 * reads as the first stage. */
export function StageEditor({ stages, transitions, sources, commands, workspaces, agents, defaultAgent, onChange }: StageEditorProps) {
  const [selection, setSelection] = useState<ChartSelection>({ kind: 'stage', id: stages[0]?.id ?? '' });
  const transition = selection.kind === 'transition' ? transitions.find((d) => d.id === selection.id) : undefined;
  const index = Math.max(0, stages.findIndex((s) => s.id === (selection.kind === 'stage' ? selection.id : transition?.from)));
  const stage = stages[index];
  const back = backOf(selection, stages);
  const setStages = (next: StageDraft[]): void => onChange({ stages: next, transitions });
  const setTransitions = (next: TransitionDraft[]): void => onChange({ stages, transitions: next });
  const move = (to: number): void => {
    if (to < 0 || to >= stages.length) return;
    setStages(stages.map((s, j) => (j === index ? stages[to] : j === to ? stages[index] : s))); // the id travels with the stage, so the selection and its arrows follow it
  };
  const removeStage = (): void => {
    const next = stages.filter((_, j) => j !== index);
    onChange({ stages: next, transitions: withoutStage(transitions, stage.id) });
    setSelection({ kind: 'stage', id: next[Math.min(index, next.length - 1)]?.id ?? '' });
  };
  const addStage = (): void => {
    const added = emptyStage();
    setStages([...stages, added]);
    setSelection({ kind: 'stage', id: added.id });
  };
  const addTransition = (): void => {
    if (stage === undefined) return;
    const added = emptyTransition(stage, stages);
    setTransitions([...transitions, added]);
    setSelection({ kind: 'transition', id: added.id });
  };
  return (
    <SettingsGroup title="settings.stages" hint="settings.transitions.hint" action={<StageActions onAddStage={addStage} onAddTransition={addTransition} canAddTransition={stage !== undefined} />}>
      {sources.length > 0 && <p className="text-muted-foreground text-xs">{t('settings.stages.loadHint')}</p>}
      <StageChart stages={stages} transitions={transitions} selection={transition ? selection : { kind: 'stage', id: stage?.id ?? '' }} defaultAgent={defaultAgent} onSelect={setSelection} />
      <p className="text-muted-foreground text-xs">{t('settings.transitions.legend')}</p>
      {transition && (
        <TransitionEditor
          key={transition.id} transition={transition} stages={stages} sources={sources}
          backTo={back && (back.name.trim() || t('settings.stages.unnamed'))} onBack={() => setSelection({ kind: 'stage', id: back?.id ?? transition.from })}
          onUpdate={(patch) => setTransitions(transitions.map((d) => (d.id === transition.id ? { ...d, ...patch } : d)))}
          onRemove={() => { setTransitions(transitions.filter((d) => d.id !== transition.id)); setSelection({ kind: 'stage', id: transition.from }); }}
        />
      )}
      {!transition && stage && (
        <StageDetail
          key={stage.id} stage={stage} index={index} total={stages.length} stages={stages} transitions={transitions} sources={sources} commands={commands} workspaces={workspaces}
          agents={agents} defaultAgent={defaultAgent} onUpdate={(patch) => setStages(stages.map((s, j) => (j === index ? { ...s, ...patch } : s)))} onMove={move} onRemove={removeStage}
          onSelectTransition={(id) => setSelection({ kind: 'transition', id, back: stage.id })} onAddTransition={addTransition}
        />
      )}
    </SettingsGroup>
  );
}
