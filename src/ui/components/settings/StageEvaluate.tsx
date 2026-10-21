import { XIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { AgentField, ModelMenu, SpecializedAgentMenu } from '@/components/LaunchMenus';
import type { AgentProps, BlockProps } from '@/components/settings/StageBlocks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/i18n';
import { settingAnchor } from '@/lib/settings-search';
import { emptyRow, type EvaluateRowDraft } from '@/lib/settings-stages';
import type { AgentId, AgentLaunchOptions } from '../../../types';

// An evaluate stage's executa block (#877, the handoff's `avaliar`): the reviewers' grid under its column header, the judge on the same columns
// with the threshold, and the rubric. Rows are named by aria-label, having column headers instead of a <Label>. Colour: only the agent mark.

type Props = BlockProps & AgentProps;
const REVIEWER_COLS = 'grid-cols-[9.5rem_11rem_14rem_minmax(0,1fr)_2rem]';
const COLUMNS = ['agent', 'model', 'specializedAgent', 'focus'] as const;

const Hint = ({ text }: { text: string }) => <p className="text-muted-foreground text-xs">{text}</p>;

interface RowProps {
  row: EvaluateRowDraft; agents: Props['agents']; options?: AgentLaunchOptions; menu: string | undefined; menuKey: string;
  labels: { agent: string; model: string; specializedAgent: string };
  heads?: readonly [string, string, string]; // the judge row has no column header, so each pick carries its own
  onMenu(key: string | undefined): void; onChange(row: EvaluateRowDraft): void;
}

// The three picks both a reviewer and the judge carry; another agent clears the model and the specialized agent, both named per agent (#710 decision 8)
function Picks({ row, agents, options, menu, menuKey, labels, heads, onMenu, onChange }: RowProps) {
  const toggle = (which: string) => (isOpen: boolean): void => onMenu(isOpen ? `${menuKey}:${which}` : undefined);
  const head = (i: 0 | 1 | 2, node: ReactNode): ReactNode => (heads === undefined ? node : <Column label={heads[i]}>{node}</Column>);
  return (
    <>
      {head(0, <AgentField id={`${menuKey}-agent`} label={labels.agent} value={row.agent} agents={agents} onOpenChange={toggle('agent')} onChange={(agent: AgentId) => onChange({ ...row, agent, model: '', specializedAgent: '' })} />)}
      {head(1, <ModelMenu label={labels.model} agent={row.agent} options={options} value={row.model} open={menu === `${menuKey}:model`} onOpenChange={toggle('model')} onPick={(model) => onChange({ ...row, model })} />)}
      {head(2, <SpecializedAgentMenu
        label={labels.specializedAgent} agent={row.agent} agents={options?.specializedAgents} value={row.specializedAgent}
        open={menu === `${menuKey}:specialized`} onOpenChange={toggle('specialized')} onPick={(specializedAgent) => onChange({ ...row, specializedAgent })}
      />)}
    </>
  );
}

const reviewerLabel = (field: string, n: number): string => t('settings.stages.evaluate.reviewerField', { field, n });

function ReviewerRow({ n, onRemove, onChange, ...rest }: RowProps & { n: number; onRemove(): void }) {
  const { row } = rest;
  return (
    <fieldset aria-label={t('settings.stages.evaluate.reviewer', { n })} className={`grid ${REVIEWER_COLS} items-center gap-2 px-3 py-2`}>
      <Picks {...rest} onChange={onChange} />
      <Input aria-label={reviewerLabel(t('settings.stages.evaluate.col.focus'), n)} value={row.focus} onChange={(e) => onChange({ ...row, focus: e.target.value })} />
      <Button type="button" variant="ghost" size="icon-sm" aria-label={t('settings.stages.evaluate.reviewers.remove', { n })} onClick={onRemove}><XIcon /></Button>
    </fieldset>
  );
}

function Column({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-1"><span className="font-medium text-sm leading-none">{label}</span>{children}</div>;
}

export function StageEvaluate({ id, stage, onUpdate, agents, defaultAgent, launchOptions }: Props) {
  const [menu, setMenu] = useState<string>();
  const { reviewers, judge } = stage;
  const setRow = (i: number, row: EvaluateRowDraft): void => onUpdate({ reviewers: reviewers.map((r, j) => (j === i ? row : r)) });
  const col = (key: (typeof COLUMNS)[number]): string => t(`settings.stages.evaluate.col.${key}`);
  const judgeLabel = (field: string): string => t('settings.stages.evaluate.judgeField', { field });
  return (
    <div className="flex flex-col gap-3">
      <div id={settingAnchor('settings.stages.evaluate.reviewers', stage.id)} className="flex flex-col gap-1">
        <span className="font-medium text-sm leading-none">{t('settings.stages.evaluate.reviewers')}</span>
        <div className="rounded-md border">
          <div aria-hidden="true" className={`grid ${REVIEWER_COLS} gap-2 px-3 pt-2 pb-1.5 text-muted-foreground text-xs`}>
            {COLUMNS.map((key) => <span key={key}>{col(key)}</span>)}<span />
          </div>
          {reviewers.map((row, i) => (
            <ReviewerRow
              key={row.id} n={i + 1} row={row} agents={agents} options={launchOptions?.[row.agent]} menu={menu} menuKey={row.id} onMenu={setMenu}
              labels={{ agent: reviewerLabel(col('agent'), i + 1), model: reviewerLabel(col('model'), i + 1), specializedAgent: reviewerLabel(col('specializedAgent'), i + 1) }}
              onChange={(next) => setRow(i, next)} onRemove={() => onUpdate({ reviewers: reviewers.filter((_, j) => j !== i) })}
            />
          ))}
          <div className="px-2 py-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => onUpdate({ reviewers: [...reviewers, emptyRow(defaultAgent)] })}>{t('settings.stages.evaluate.reviewers.add')}</Button>
          </div>
        </div>
        <Hint text={t('settings.stages.evaluate.reviewers.hint')} />
      </div>
      <div id={settingAnchor('settings.stages.evaluate.judge', stage.id)} className="grid grid-cols-[9.5rem_11rem_14rem_7rem] items-start gap-2 px-[13px]">
        <Picks
          row={judge} agents={agents} options={launchOptions?.[judge.agent]} menu={menu} menuKey={`${id}-judge`} onMenu={setMenu} onChange={(next) => onUpdate({ judge: next })}
          labels={{ agent: t('settings.stages.evaluate.judge'), model: judgeLabel(col('model')), specializedAgent: judgeLabel(col('specializedAgent')) }}
          heads={[t('settings.stages.evaluate.judge'), col('model'), col('specializedAgent')]}
        />
        <div id={settingAnchor('settings.stages.evaluate.threshold', stage.id)} className="flex flex-col gap-1">
          <Label htmlFor={`${id}-threshold`}>{t('settings.stages.evaluate.threshold')}</Label>
          <Input id={`${id}-threshold`} type="number" min={0} max={10} step={1} value={stage.threshold} onChange={(e) => onUpdate({ threshold: e.target.value })} />
          <Hint text={t('settings.stages.evaluate.threshold.hint')} />
        </div>
      </div>
      <div id={settingAnchor('settings.stages.evaluate.rubric', stage.id)} className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={`${id}-rubric`}>{t('settings.stages.evaluate.rubric')}</Label>
        <Textarea id={`${id}-rubric`} rows={3} spellCheck={false} value={stage.rubric} onChange={(e) => onUpdate({ rubric: e.target.value })} />
        <Hint text={t('settings.stages.evaluate.rubric.hint')} />
      </div>
    </div>
  );
}
