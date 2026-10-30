import { useContext, useState } from 'react';
import { stageCall } from '../../../../benchmark/arms.js';
import { canonicalJson } from '../../../../benchmark/canonical.js';
import { SCORE_MAX } from '../../../../stage-agent.js';
import { type AgentId, type BenchFlow, type BenchStage, DEFAULT_AGENT, type LaunchOptions } from '../../../../types';
import { stageText } from '@/components/benchmark/arms/arm-rows';
import { ChipList } from '@/components/benchmark/arms/ChipList';
import { entriesText, exitsOf, verdictsText } from '@/components/benchmark/arms/stage-lines';
import { AgentField, type InheritRow, ModelMenu } from '@/components/LaunchMenus';
import { AgentsContext } from '@/components/NewRunButton';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { type MessageKey, t } from '@/i18n';

interface StageEditorProps {
  stage: BenchStage; // the shown setup's (the arm's merge, or the base)
  base: BenchStage; // the base's same stage: its model for the inherit row, its value for the struck line
  flow: BenchFlow; // the shown setup's: exits, entries, the commands it has lines for
  isArm: boolean; isLocked: boolean; options?: LaunchOptions;
  onChange(stage: BenchStage): void;
}

/** The row's hint: what the stage does. */
export function stageKind(stage: BenchStage): MessageKey {
  if (stage.action === 'skill') return 'benchmark.arms.settings.kind.skill';
  if (stage.action === 'commands') return 'benchmark.arms.settings.kind.commands';
  if (stage.action === 'evaluate') return 'benchmark.arms.settings.kind.evaluate';
  if (stage.action !== undefined) return `settings.stages.action.${stage.action}`;
  if (stage.prompt !== undefined) return 'benchmark.arms.settings.kind.prompt';
  return stage.approval === true ? 'settings.stages.action.gate' : 'settings.stages.meta.show';
}

/** The field a stage's draft holds blank (#536): the server refuses '' for a prompt or a skill, so the dialog's salvar waits for it to be filled. */
export function blankField(stage: BenchStage): 'prompt' | 'skill' | undefined {
  if (stage.action === 'skill') return stage.skill?.trim() === '' ? 'skill' : undefined;
  return stage.action === undefined && stage.prompt?.trim() === '' ? 'prompt' : undefined;
}

interface PickProps { id: string; stageName: string; agentLabel: MessageKey; modelLabel: MessageKey; agent: AgentId; model?: string; baseModel?: string; isArm: boolean; options?: LaunchOptions; onPick(agent: AgentId, model?: string): void }

// In an arm '' is the agent's own default (no model over a base model); the base's model, when it names one, is a row of its own
function PickFields({ id, stageName, agentLabel, modelLabel, agent, model, baseModel, isArm, options, onPick }: PickProps) {
  const agents = useContext(AgentsContext);
  const [isOpen, setOpen] = useState(false);
  const inherit: InheritRow | undefined = isArm && baseModel !== undefined
    ? { label: t('benchmark.arms.settings.baseModel', { model: baseModel }), isPicked: model === baseModel, onPick: () => onPick(agent, baseModel) }
    : undefined;
  return (
    <div className="grid grid-cols-2 gap-3">
      {/* another agent's model means nothing to it: the agent's own default */}
      <AgentField id={`${id}-agent`} label={t(agentLabel, { stage: stageName })} value={agent} agents={agents} onOpenChange={() => undefined} onChange={(next) => onPick(next)} />
      <ModelMenu
        id={`${id}-model`} label={t(modelLabel, { stage: stageName })} agent={agent} options={options?.[agent]} value={model ?? ''}
        defaultLabel={isArm ? t('benchmark.arms.settings.agentDefault') : undefined} inherit={inherit}
        open={isOpen} onOpenChange={setOpen} onPick={(picked) => onPick(agent, picked === '' ? undefined : picked)}
      />
    </div>
  );
}

const withPick = (stage: BenchStage, agent: AgentId, model?: string): BenchStage => {
  const { model: _model, ...rest } = stage;
  return { ...rest, agent, ...(model === undefined ? {} : { model }) };
};

function AgentStageFields({ stage, base, isArm, options, onChange }: Pick<StageEditorProps, 'stage' | 'base' | 'isArm' | 'options' | 'onChange'>) {
  const isSkill = stage.action === 'skill';
  const blank = blankField(stage);
  return (
    <>
      <PickFields
        id={`arm-stage-${stage.name}`} stageName={stage.name} agentLabel="benchmark.arms.settings.agentOf" modelLabel="benchmark.arms.settings.modelOf"
        agent={stage.agent ?? DEFAULT_AGENT} model={stage.model} baseModel={base.model} isArm={isArm} options={options} onPick={(agent, model) => onChange(withPick(stage, agent, model))}
      />
      {/* a prompt stage's skill is the command its prompt opens on, read only; a skill stage's is the field itself */}
      <Input
        aria-label={t('benchmark.arms.settings.skillOf', { stage: stage.name })} placeholder={t('benchmark.arms.settings.noSkill')} className="font-mono text-xs"
        readOnly={!isSkill} aria-invalid={blank === 'skill'} value={isSkill ? (stage.skill ?? '') : (stageCall(stage) ?? '')} onChange={(e) => onChange({ ...stage, skill: e.target.value })}
      />
      {!isSkill && <Textarea aria-label={t('benchmark.arms.settings.promptOf', { stage: stage.name })} aria-invalid={blank === 'prompt'} rows={2} value={stage.prompt ?? ''} className="text-xs" onChange={(e) => onChange({ ...stage, prompt: e.target.value })} />}
      {blank !== undefined && <p role="alert" className="m-0 text-destructive text-xs">{t(blank === 'skill' ? 'benchmark.arms.settings.blankSkill' : 'benchmark.arms.settings.blankPrompt')}</p>}
    </>
  );
}

function EvaluateFields({ stage, options, onChange }: Pick<StageEditorProps, 'stage' | 'options' | 'onChange'>) {
  const judge = stage.judge ?? { agent: DEFAULT_AGENT };
  const reviewers = (stage.reviewers ?? []).map((r) => r.specializedAgent ?? r.agent);
  const pickJudge = (agent: AgentId, model?: string): void => {
    const { model: _model, ...rest } = judge;
    onChange({ ...stage, judge: { ...rest, agent, ...(model === undefined ? {} : { model }) } });
  };
  const setThreshold = (value: number): void => { if (Number.isFinite(value)) onChange({ ...stage, threshold: value }); };
  return (
    <>
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-xs">{t('benchmark.arms.settings.reviewers')}</span>
        <ChipList id={`arm-stage-${stage.name}-reviewers`} addLabel={t('benchmark.arms.settings.reviewers')} placeholder="" value={reviewers} onChange={() => undefined} isReadOnly />
      </span>
      <PickFields
        id={`arm-stage-${stage.name}-judge`} stageName={stage.name} agentLabel="benchmark.arms.settings.judgeAgent" modelLabel="benchmark.arms.settings.judgeModel"
        agent={judge.agent} model={judge.model} isArm={false} options={options} onPick={pickJudge}
      />
      <span className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs">{t('benchmark.arms.settings.threshold')}</span>
        <Input
          type="number" min={0} max={SCORE_MAX} aria-label={t('benchmark.arms.settings.threshold')} className="w-14" value={stage.threshold ?? ''}
          onChange={(e) => setThreshold(e.target.valueAsNumber)}
        />
        <span className="text-muted-foreground text-xs">{t('benchmark.arms.settings.thresholdHint')}</span>
      </span>
    </>
  );
}

function CommandsField({ stage, flow, isLocked, onChange }: Pick<StageEditorProps, 'stage' | 'flow' | 'isLocked' | 'onChange'>) {
  const lines = new Map(flow.commands.map((c) => [c.name, c.line]));
  return (
    <ChipList
      id={`arm-stage-${stage.name}-commands`} addLabel={t('benchmark.arms.settings.addCommand')} placeholder={t('benchmark.arms.settings.commandPlaceholder')}
      value={stage.commands ?? []} options={[...lines.keys()]} titleOf={(name) => lines.get(name)} isReadOnly={isLocked} onChange={(commands) => onChange({ ...stage, commands })}
    />
  );
}

// The screen's .exits: verdicts, exits (-> or back <-, with the tries) and entries
function StageLines({ flow, stage }: { flow: BenchFlow; stage: BenchStage }) {
  return (
    <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      <dt className="text-muted-foreground">{t('benchmark.arms.settings.lines.verdicts')}</dt>
      <dd className="m-0 text-muted-foreground">{verdictsText(stage)}</dd>
      <dt className="text-muted-foreground">{t('benchmark.arms.settings.lines.exits')}</dt>
      <dd className="m-0 flex flex-col gap-0.5">
        {exitsOf(flow, stage.name).map((exit) => (
          <span key={`${exit.trigger}|${exit.to}`} className="flex items-baseline gap-1.5">
            <span>{exit.trigger}</span><span aria-hidden="true">{exit.isBack ? '↩' : '→'}</span><b className="font-medium">{exit.to}</b>
            {exit.tries !== undefined && <span className="text-muted-foreground">{t('benchmark.arms.settings.exits.tries', { n: exit.tries })}</span>}
          </span>
        ))}
      </dd>
      <dt className="text-muted-foreground">{t('benchmark.arms.settings.lines.entries')}</dt>
      <dd className="m-0 text-muted-foreground">{entriesText(flow, stage.name)}</dd>
    </dl>
  );
}

/** One stage of the copied flow, editable (#536): who runs it and what it runs, then the struck base value in an arm, then its verdicts, exits
 * and entries. Presentational: the shown stage comes in and the changed one goes out. */
export function StageEditor({ stage, base, flow, isArm, isLocked, options, onChange }: StageEditorProps) {
  // the base's value struck under a stage the arm overrides, as the card's row reads it
  const was = isArm && canonicalJson(stage) !== canonicalJson(base) ? stageText(base, stage) : undefined;
  const runsAgent = stage.action === 'skill' || (stage.action === undefined && stage.prompt !== undefined);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <fieldset disabled={isLocked} className="contents [&_:disabled]:border-transparent">
        {runsAgent && <AgentStageFields stage={stage} base={base} isArm={isArm} options={options} onChange={onChange} />}
        {stage.action === 'commands' && <CommandsField stage={stage} flow={flow} isLocked={isLocked} onChange={onChange} />}
        {stage.action === 'evaluate' && <EvaluateFields stage={stage} options={options} onChange={onChange} />}
      </fieldset>
      {was !== undefined && <span className="text-muted-foreground text-xs">{t('benchmark.arms.settings.wasBase')} <s className="font-mono">{was}</s></span>}
      <StageLines flow={flow} stage={stage} />
    </div>
  );
}
