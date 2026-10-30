import { type ReactNode, useContext, useState } from 'react';
import type { BenchEvaluation, Experiment } from '../../../../types.js';
import { collectorText, judgeableRuns, linesOf, rowDraft, rowFrom, rowText, scenariosText } from '@/components/benchmark/config/config-lib';
import { evaluateAgain, toastRefusal } from '@/components/benchmark/config/save-section';
import { EditButton, EditFoot, Field, Pill, Row, Section, type SectionEdit, useDraft, useSave, Values } from '@/components/benchmark/config/Section';
import { Confirm } from '@/components/Confirm';
import { AgentsContext, DefaultAgentContext } from '@/components/NewRunButton';
import { Picks, ReviewerRow, type RowProps } from '@/components/settings/StageEvaluate';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useLaunchOptions } from '@/hooks/use-launch-options';
import { t, tPlural } from '@/i18n';
import { emptyRow, type EvaluateRowDraft } from '@/lib/settings-stages';

interface EvaluationProps { experiment: Experiment; edit: SectionEdit; seedEdit: SectionEdit }
interface Head { title: string; sub: string; side: ReactNode }
interface EvaluationDraft { collectors: EvaluateRowDraft[]; dynamic: boolean; tester: EvaluateRowDraft; scenarioWalks: string; judge: EvaluateRowDraft; rubric: string }
type PickProps = Pick<RowProps, 'agents' | 'menu' | 'onMenu'> & { options: ReturnType<typeof useLaunchOptions> };
const COLS = ['agent', 'model', 'specializedAgent'] as const;
const col = (key: (typeof COLS)[number]): string => t(`settings.stages.evaluate.col.${key}`);
const L = {
  collectors: (): string => t('benchmark.config.eval.collectors'), dynamic: (): string => t('benchmark.config.eval.dynamic'), tester: (): string => t('benchmark.config.eval.tester'),
  judge: (): string => t('benchmark.config.eval.judge'), rubric: (): string => t('benchmark.config.eval.rubric'),
};

const draftOf = (e: BenchEvaluation): EvaluationDraft => ({
  collectors: e.collectors.map(rowDraft), dynamic: e.dynamic, tester: rowDraft(e.tester), scenarioWalks: String(e.scenarioWalks), judge: rowDraft(e.judge), rubric: e.rubric,
});
const evaluationOf = (d: EvaluationDraft): BenchEvaluation => ({
  collectors: d.collectors.map(rowFrom), dynamic: d.dynamic, tester: rowFrom(d.tester), scenarioWalks: Number(d.scenarioWalks), judge: rowFrom(d.judge), rubric: d.rubric,
});

const dynamicText = ({ evaluation, seed }: Experiment): string =>
  (evaluation.dynamic ? t('benchmark.config.eval.dynamicLine', { scenarios: scenariosText(seed.scenarios), n: evaluation.scenarioWalks }) : t('benchmark.config.off'));

// It replaces every ended run's evaluation, so it confirms first (design_handoff_confirmacoes); the route answers at once, the result streams in
function Rejudge({ experiment, isLocked }: { experiment: Experiment; isLocked: boolean }) {
  const [isAsking, setAsking] = useState(false);
  const n = judgeableRuns(experiment);
  const run = async (): Promise<void> => {
    try {
      await evaluateAgain(experiment.id);
    } catch (err) {
      toastRefusal(err);
    }
  };
  return (
    <>
      <Button type="button" variant="outline" size="sm" className="self-center" disabled={isLocked || n === 0} onClick={() => setAsking(true)}>{t('benchmark.config.eval.rejudge')}</Button>
      <Confirm
        open={isAsking} onOpenChange={setAsking} title={t('benchmark.config.eval.rejudgeTitle')} context={tPlural('benchmark.config.eval.rejudgeRuns', n, { n })}
        message={t('benchmark.config.eval.rejudgeText')} confirmLabel={t('benchmark.config.eval.rejudgeConfirm')} onConfirm={run}
      />
    </>
  );
}

function EvaluationRows({ experiment, seedEdit }: Omit<EvaluationProps, 'edit'>) {
  const { evaluation } = experiment;
  return (
    <>
      <Row label={L.collectors()} hint={t('benchmark.config.eval.collectors.hint')}><Values texts={evaluation.collectors.map(collectorText)} /></Row>
      <Row label={L.dynamic()} hint={t('benchmark.config.eval.dynamic.hint')} side={<EditButton edit={seedEdit} label={t('benchmark.config.eval.editScenarios')} />}><Pill>{dynamicText(experiment)}</Pill></Row>
      {evaluation.dynamic && <Row label={L.tester()} hint={t('benchmark.config.eval.tester.hint')}><Pill>{rowText(evaluation.tester)}</Pill></Row>}
      <Row label={L.judge()} hint={t('benchmark.config.eval.judge.hint')}><Pill>{rowText(evaluation.judge)}</Pill></Row>
      <Row label={L.rubric()} hint={t('benchmark.config.eval.rubric.hint')}><Values texts={linesOf(evaluation.rubric)} /></Row>
    </>
  );
}

// #877's grid, reused as is: its rows keep their own reviewer labels; + coletor adds one on the default agent
function CollectorGrid({ rows, defaultAgent, onChange, ...pick }: PickProps & { rows: EvaluateRowDraft[]; defaultAgent: EvaluateRowDraft['agent']; onChange(rows: EvaluateRowDraft[]): void }) {
  const label = (key: (typeof COLS)[number], n: number): string => t('settings.stages.evaluate.reviewerField', { field: col(key), n });
  return (
    <span className="flex w-full flex-col rounded-md border">
      {rows.map((row, i) => (
        <ReviewerRow
          key={row.id} n={i + 1} row={row} agents={pick.agents} options={pick.options?.[row.agent]} menu={pick.menu} menuKey={row.id} onMenu={pick.onMenu}
          labels={{ agent: label('agent', i + 1), model: label('model', i + 1), specializedAgent: label('specializedAgent', i + 1) }}
          onChange={(next) => onChange(rows.map((r, j) => (j === i ? next : r)))} onRemove={() => onChange(rows.filter((_, j) => j !== i))}
        />
      ))}
      <Button type="button" variant="ghost" size="xs" className="m-1 self-start" onClick={() => onChange([...rows, emptyRow(defaultAgent)])}>{t('benchmark.config.eval.addCollector')}</Button>
    </span>
  );
}

// The tester has the judge's fields (#474): agent, model, specialized agent, no focus
function PickRow({ row, who, onChange, ...pick }: PickProps & { row: EvaluateRowDraft; who: 'tester' | 'judge'; onChange(row: EvaluateRowDraft): void }) {
  const field = (key: (typeof COLS)[number]): string => t(who === 'tester' ? 'benchmark.config.eval.testerField' : 'settings.stages.evaluate.judgeField', { field: col(key) });
  return (
    <div className="grid grid-cols-[9.5rem_11rem_14rem] gap-2">
      <Picks row={row} agents={pick.agents} options={pick.options?.[row.agent]} menu={pick.menu} menuKey={who} onMenu={pick.onMenu} onChange={onChange} labels={{ agent: field('agent'), model: field('model'), specializedAgent: field('specializedAgent') }} />
    </div>
  );
}

function EvaluationForm({ experiment, edit, head }: { experiment: Experiment; edit: SectionEdit; head: Head }) {
  const [draft, setDraft] = useDraft(() => draftOf(experiment.evaluation), edit);
  const [menu, setMenu] = useState<string>();
  const pick: PickProps = { agents: useContext(AgentsContext), options: useLaunchOptions(experiment.workspace), menu, onMenu: setMenu };
  const defaultAgent = useContext(DefaultAgentContext);
  const { isSaving, save } = useSave(experiment.id, edit);
  const set = (patch: Partial<EvaluationDraft>): void => setDraft({ ...draft, ...patch });
  const isWalksValid = /^\d+$/.test(draft.scenarioWalks.trim()) && Number(draft.scenarioWalks) >= 1;
  return (
    <Section {...head} edit={edit} foot={<EditFoot edit={edit} isValid={isWalksValid} isSaving={isSaving} onSave={() => void save('evaluation', evaluationOf(draft))} />}>
      <Row label={L.collectors()} hint={t('benchmark.config.eval.collectors.hint')}><CollectorGrid {...pick} rows={draft.collectors} defaultAgent={defaultAgent} onChange={(collectors) => set({ collectors })} /></Row>
      <Row label={L.dynamic()} hint={t('benchmark.config.eval.dynamic.hint')}>
        <Switch aria-label={L.dynamic()} checked={draft.dynamic} onCheckedChange={(dynamic) => set({ dynamic })} />
        <Field label={t('benchmark.config.eval.walksField')} value={draft.scenarioWalks} onChange={(scenarioWalks) => set({ scenarioWalks })} error={isWalksValid ? undefined : t('benchmark.config.error.positive')} />
      </Row>
      {draft.dynamic && <Row label={L.tester()} hint={t('benchmark.config.eval.tester.hint')}><PickRow {...pick} row={draft.tester} who="tester" onChange={(tester) => set({ tester })} /></Row>}
      <Row label={L.judge()} hint={t('benchmark.config.eval.judge.hint')}><PickRow {...pick} row={draft.judge} who="judge" onChange={(judge) => set({ judge })} /></Row>
      <Row label={L.rubric()} hint={t('benchmark.config.eval.rubric.hint')}>
        <Textarea aria-label={L.rubric()} rows={3} spellCheck={false} value={draft.rubric} onChange={(e) => set({ rubric: e.target.value })} className="w-80 text-xs" />
      </Row>
    </Section>
  );
}

/** avaliação (#463): the static collectors, the dynamic one with its tester and walks (#474), the judge, the rubric, and julgar de novo. */
export function EvaluationSection({ experiment, edit, seedEdit }: EvaluationProps) {
  const head: Head = { title: t('benchmark.config.eval.title'), sub: t('benchmark.config.eval.sub'), side: <Rejudge experiment={experiment} isLocked={edit.isLocked} /> };
  if (edit.isOpen) return <EvaluationForm experiment={experiment} edit={edit} head={head} />;
  return <Section {...head} edit={edit}><EvaluationRows experiment={experiment} seedEdit={seedEdit} /></Section>;
}
