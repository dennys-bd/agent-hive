import { ArrowLeftIcon, ArrowRightIcon, ChevronRightIcon } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { type AgentProps, StageEnter, StageRun } from '@/components/settings/StageBlocks';
import { REFUSAL } from '@/components/settings/FlowRow';
import type { StageSource } from '@/components/settings/StageEditor';
import { SourceActions } from '@/components/settings/SourceActions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { t } from '@/i18n';
import { triggerLabel } from '@/lib/flow-labels';
import { enteringStage, type FlowsDraft } from '@/lib/settings-flows';
import { contextEntries, named, type SettingEntry, settingAnchor } from '@/lib/settings-search';
import { canContinueSession, isAgentDraft, isGateDraft, type StageDraft, withEntry } from '@/lib/settings-stages';
import { exitLabel, flowOfStage, isCrossFlow, routeName, stageNameIn, type TransitionDraft } from '@/lib/settings-transitions';
import type { Command } from '../../../types';

function BlockHeading({ n, title, hint }: { n: number; title: string; hint: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <h3 className="font-semibold text-muted-foreground text-xs uppercase tracking-widest">{`${n} · ${title}`}</h3>
      <span className="text-muted-foreground text-xs">{hint}</span>
    </div>
  );
}

const Block = ({ anchor, children }: { anchor: string; children: ReactNode }) => <div id={anchor} className="flex flex-col gap-3 border-t pt-4">{children}</div>;

const tagsOf = (d: TransitionDraft, isCross: boolean): string[] => [
  ...(isCross ? [t('settings.transitions.otherFlow')] : []), // #691: the crossing is never said by the arrow alone
  ...(d.maxTries.trim() === '' ? [] : [`${d.maxTries.trim()}x`]), ...(d.prompt.trim() === '' ? [] : [t('settings.transitions.tag.prompt')]), ...(d.session === 'new' ? [t('settings.transitions.tag.newSession')] : []),
];

interface ExitsProps { stage: StageDraft; comb: FlowsDraft; transitions: TransitionDraft[]; onSelect(id: string): void; onAdd(): void }

// 4 · saídas (#134): a row per transition leaving the stage, and + transição
function Exits({ stage, comb, transitions, onSelect, onAdd }: ExitsProps) {
  return (
    <>
      <ul aria-label={t('settings.stages.exits')} className="flex flex-col gap-1">
        {transitions.filter((d) => d.from === stage.id).map((d) => (
          <li key={d.id}>
            <button type="button" onClick={() => onSelect(d.id)} className="flex w-full flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent">
              <span>{`${triggerLabel(d.when, d.verdict, stage.action)} → ${stageNameIn(comb.stages, comb.flows, d.to, stage.flow)}`}</span>
              {tagsOf(d, isCrossFlow(d, comb.stages)).map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}
              <ChevronRightIcon aria-hidden="true" className="ml-auto size-4 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
      <Button type="button" variant="ghost" size="sm" className="self-start" onClick={onAdd}>{t('settings.transitions.add')}</Button>
    </>
  );
}

// chega de (#691): each arrow into the stage, its own flow's first, then another flow's as <flow> · <stage>, by its pill's words without the
// tries; a loop to itself is no arrival
function arrivalsOf(stage: StageDraft, comb: FlowsDraft): string | undefined {
  const into = comb.transitions.filter((d) => d.to === stage.id && d.from !== stage.id);
  const isOwn = (d: TransitionDraft): boolean => flowOfStage(comb.stages, d.from) === stage.flow;
  const list = [...into.filter(isOwn), ...into.filter((d) => !isOwn(d))].map((d) => `${stageNameIn(comb.stages, comb.flows, d.from, stage.flow)} (${exitLabel(d, comb.stages)})`);
  return list.length === 0 ? undefined : t('settings.stages.from.arrivals', { list: list.join(', ') });
}

// 2 · ao começar (#266): what each source does as a run of the stage starts, laid out as the transition editor's sources
function OnStart({ stage, sources, onUpdate }: { stage: StageDraft; sources: StageSource[]; onUpdate(patch: Partial<StageDraft>): void }) {
  if (sources.length === 0) return <p className="text-muted-foreground text-sm">{t('settings.sources.none')}</p>;
  const isEmpty = sources.every((b) => (stage.onStart[b.id] ?? []).length === 0);
  return (
    <>
      <table aria-label={t('settings.stages.onStart')} className="w-full rounded-md border text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground text-xs">
            <th className="px-3 py-2 font-medium">{t('settings.stages.exit.source')}</th>
            <th className="px-3 py-2 font-medium">{t('settings.stages.exit.start')}</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((b) => (
            <tr key={b.id} className="border-b last:border-b-0">
              <td className="w-40 px-3 py-2">{b.name}</td>
              <td className="px-3 py-2">
                <SourceActions
                  list={stage.onStart[b.id] ?? []} source={b} onStart when={t('settings.stages.exit.start')}
                  onChange={(next) => onUpdate({ onStart: withEntry(stage.onStart, b.id, next.length > 0 ? next : undefined) })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {isEmpty && <p className="text-muted-foreground text-xs">{t('settings.stages.onStart.empty')}</p>}
    </>
  );
}

export interface StageDetailProps extends AgentProps {
  comb: FlowsDraft; // #691: another flow's names, the arrivals and the arrows that refuse remover etapa
  stage: StageDraft; index: number; total: number; stages: StageDraft[]; transitions: TransitionDraft[]; sources: StageSource[]; commands: Command[]; workspaces: string[];
  clash?: string; // #565: the flow that already has a stage of this name
  onUpdate(patch: Partial<StageDraft>): void; onMove(to: number): void; onRemove(): void; onSelectTransition(id: string): void; onAddTransition(): void;
}

/** One stage's name and place in the fill order, then its 1 · entra / 2 · ao começar / 3 · executa / 4 · saídas blocks, in the order a run goes through them (#515, #134, #266). */
export function StageDetail(props: StageDetailProps) {
  const { comb, stage, clash, index, total, stages, transitions, sources, commands, workspaces, agents, defaultAgent, launchOptions, onUpdate, onMove, onRemove, onSelectTransition, onAddTransition } = props;
  const id = useId();
  const [isRefused, setRefused] = useState(false);
  const blocker = enteringStage(comb, stage.id)[0]; // #691: refused at the click, the draft unchanged, as excluir fluxo's holdsTasks
  const remove = (): void => {
    if (blocker === undefined) onRemove();
    else setRefused(true);
  };
  return (
    <div className="flex flex-col gap-4 rounded-xl border bg-card p-5">
      <div className="flex items-end gap-2">
        <div id={settingAnchor('settings.stages.name', stage.id)} className="flex min-w-0 flex-1 flex-col gap-1 md:max-w-80">
          <Label htmlFor={`${id}-name`}>{t('settings.stages.name')}</Label>
          <Input id={`${id}-name`} defaultValue={stage.name} onChange={(e) => onUpdate({ name: e.target.value })} />
          {clash !== undefined && <p className="text-destructive text-xs">{t('settings.stages.error.otherFlow', { flow: clash })}</p>}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon-xs" aria-label={t('settings.stages.moveEarlier')} disabled={index === 0} onClick={() => onMove(index - 1)}><ArrowLeftIcon /></Button>
          <Button type="button" variant="ghost" size="icon-xs" aria-label={t('settings.stages.moveLater')} disabled={index === total - 1} onClick={() => onMove(index + 1)}><ArrowRightIcon /></Button>
          <Button type="button" variant="ghost" size="sm" onClick={remove}>{t('settings.stages.remove')}</Button>
        </div>
      </div>
      {isRefused && blocker && <p role="alert" className={`-mt-2 ${REFUSAL}`}>{t('settings.stages.entered', { transition: routeName(blocker, comb.stages, comb.flows, stage.flow) })}</p>}
      <Block anchor={settingAnchor('settings.stages.enter', stage.id)}><BlockHeading n={1} title={t('settings.stages.enter')} hint={t('settings.stages.enter.hint')} /><StageEnter id={id} stage={stage} sources={sources} first={index === 0} arrivals={arrivalsOf(stage, comb)} onUpdate={onUpdate} /></Block>
      <Block anchor={settingAnchor('settings.stages.onStart', stage.id)}>
        <BlockHeading n={2} title={t('settings.stages.onStart')} hint={t('settings.stages.onStart.hint')} />
        <OnStart stage={stage} sources={sources} onUpdate={onUpdate} />
      </Block>
      <Block anchor={settingAnchor('settings.stages.run', stage.id)}>
        <BlockHeading n={3} title={t('settings.stages.run')} hint={t('settings.stages.run.hint')} />
        <StageRun id={id} stage={stage} agents={agents} defaultAgent={defaultAgent} launchOptions={launchOptions} canContinue={canContinueSession(stages, index, defaultAgent)} commands={commands} workspaces={workspaces} onUpdate={onUpdate} />
      </Block>
      <Block anchor={settingAnchor('settings.stages.exits', stage.id)}>
        <BlockHeading n={4} title={t('settings.stages.exits')} hint={t('settings.stages.exits.hint')} />
        <Exits stage={stage} comb={comb} transitions={transitions} onSelect={onSelectTransition} onAdd={onAddTransition} />
      </Block>
    </div>
  );
}

/** A stage's entries of the Settings search (#689): itself, then each block and field under the same conditions the detail renders them. */
export function stageEntries(stage: StageDraft): SettingEntry[] {
  const view = { section: 'flow', stage: stage.id } as const;
  const path = ['settings.section.flow', 'settings.stages', named(stage.name, 'settings.stages.unnamed')] as const;
  const gate = isGateDraft(stage);
  // #710: a prompt or skill stage's run fields, then its prompt or its skill
  const agentFields = ['settings.stages.agent', 'settings.stages.model', 'settings.stages.session', 'settings.stages.specializedAgent', stage.action === 'skill' ? 'settings.stages.skill' : 'settings.stages.prompt', 'settings.stages.approval', 'settings.stages.handoff', 'settings.stages.clearSession'] as const;
  const itself = { label: path[2], path: path.slice(0, 2), view, anchor: settingAnchor('settings.stages.name', stage.id) };
  return [
    itself,
    ...contextEntries([
      'settings.stages.name', 'settings.stages.enter', 'settings.stages.from', 'settings.stages.after', 'settings.stages.maxWorkers', 'settings.stages.onStart', 'settings.stages.run', 'settings.stages.action',
      ...(isAgentDraft(stage) ? agentFields : []),
      ...(stage.action === 'evaluate' ? (['settings.stages.evaluate.reviewers', 'settings.stages.evaluate.judge', 'settings.stages.evaluate.threshold', 'settings.stages.evaluate.rubric'] as const) : []),
      ...(gate ? (['settings.stages.approval'] as const) : []),
      'settings.stages.exits',
    ], view, path, stage.id),
  ];
}
