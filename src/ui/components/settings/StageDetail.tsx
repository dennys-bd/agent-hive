import { ArrowLeftIcon, ArrowRightIcon, ChevronRightIcon } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { type AgentProps, StageEnter, StageRun } from '@/components/settings/StageBlocks';
import type { StageSource } from '@/components/settings/StageEditor';
import { SourceActions } from '@/components/settings/SourceActions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { t } from '@/i18n';
import { triggerLabel } from '@/lib/flow-labels';
import { contextEntries, named, type SettingEntry, settingAnchor } from '@/lib/settings-search';
import { isAgentDraft, isGateDraft, type StageDraft, withEntry } from '@/lib/settings-stages';
import type { TransitionDraft } from '@/lib/settings-transitions';
import { END, type Command } from '../../../types';

function BlockHeading({ n, title, hint }: { n: number; title: string; hint: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <h3 className="font-semibold text-muted-foreground text-xs uppercase tracking-widest">{`${n} · ${title}`}</h3>
      <span className="text-muted-foreground text-xs">{hint}</span>
    </div>
  );
}

const Block = ({ anchor, children }: { anchor: string; children: ReactNode }) => <div id={anchor} className="flex flex-col gap-3 border-t pt-4">{children}</div>;

const tagsOf = (d: TransitionDraft): string[] =>
  [...(d.maxTries.trim() === '' ? [] : [`${d.maxTries.trim()}x`]), ...(d.prompt.trim() === '' ? [] : [t('settings.transitions.tag.prompt')]), ...(d.session === 'new' ? [t('settings.transitions.tag.newSession')] : [])];

interface ExitsProps { stage: StageDraft; stages: StageDraft[]; transitions: TransitionDraft[]; sources: StageSource[]; onUpdate(patch: Partial<StageDraft>): void; onSelect(id: string): void; onAdd(): void }

// 3 · saídas (#134): a row per transition leaving the stage, + transição, and what each source does when a run starts here
function Exits({ stage, stages, transitions, sources, onUpdate, onSelect, onAdd }: ExitsProps) {
  const nameOf = (id: string): string => (id === END ? t('flow.end') : stages.find((s) => s.id === id)?.name.trim() || t('settings.stages.unnamed'));
  return (
    <>
      <ul aria-label={t('settings.stages.exits')} className="flex flex-col gap-1">
        {transitions.filter((d) => d.from === stage.id).map((d) => (
          <li key={d.id}>
            <button type="button" onClick={() => onSelect(d.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent">
              <span>{`${triggerLabel(d.when, d.verdict)} → ${nameOf(d.to)}`}</span>
              {tagsOf(d).map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}
              <ChevronRightIcon aria-hidden="true" className="ml-auto size-4 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
      <Button type="button" variant="ghost" size="sm" className="self-start" onClick={onAdd}>{t('settings.transitions.add')}</Button>
      {sources.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t('settings.stages.exits.onStart')}</span>
          {sources.map((b) => (
            <span key={b.id} className="flex items-center gap-1.5">
              <span>{b.name}</span>
              <SourceActions
                list={stage.onStart[b.id] ?? []} source={b} onStart when={t('settings.stages.exit.start')}
                onChange={(next) => onUpdate({ onStart: withEntry(stage.onStart, b.id, next.length > 0 ? next : undefined) })}
              />
            </span>
          ))}
          <span className="text-muted-foreground">{t('settings.stages.exits.onStartHint')}</span>
        </div>
      )}
    </>
  );
}

export interface StageDetailProps extends AgentProps {
  stage: StageDraft; index: number; total: number; stages: StageDraft[]; transitions: TransitionDraft[]; sources: StageSource[]; commands: Command[]; workspaces: string[];
  onUpdate(patch: Partial<StageDraft>): void; onMove(to: number): void; onRemove(): void; onSelectTransition(id: string): void; onAddTransition(): void;
}

/** One stage's name and place in the fill order, then its 1 · entra / 2 · executa / 3 · saídas blocks (#515, #134). */
export function StageDetail(props: StageDetailProps) {
  const { stage, index, total, stages, transitions, sources, commands, workspaces, agents, defaultAgent, launchOptions, onUpdate, onMove, onRemove, onSelectTransition, onAddTransition } = props;
  const id = useId();
  return (
    <div className="flex flex-col gap-4 rounded-xl border bg-card p-5">
      <div className="flex items-end gap-2">
        <div id={settingAnchor('settings.stages.name', stage.id)} className="flex min-w-0 flex-1 flex-col gap-1 md:max-w-80">
          <Label htmlFor={`${id}-name`}>{t('settings.stages.name')}</Label>
          <Input id={`${id}-name`} defaultValue={stage.name} onChange={(e) => onUpdate({ name: e.target.value })} />
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon-xs" aria-label={t('settings.stages.moveEarlier')} disabled={index === 0} onClick={() => onMove(index - 1)}><ArrowLeftIcon /></Button>
          <Button type="button" variant="ghost" size="icon-xs" aria-label={t('settings.stages.moveLater')} disabled={index === total - 1} onClick={() => onMove(index + 1)}><ArrowRightIcon /></Button>
          <Button type="button" variant="ghost" size="sm" onClick={onRemove}>{t('settings.stages.remove')}</Button>
        </div>
      </div>
      <Block anchor={settingAnchor('settings.stages.enter', stage.id)}><BlockHeading n={1} title={t('settings.stages.enter')} hint={t('settings.stages.enter.hint')} /><StageEnter id={id} stage={stage} sources={sources} onUpdate={onUpdate} /></Block>
      <Block anchor={settingAnchor('settings.stages.run', stage.id)}>
        <BlockHeading n={2} title={t('settings.stages.run')} hint={t('settings.stages.run.hint')} />
        <StageRun id={id} stage={stage} agents={agents} defaultAgent={defaultAgent} launchOptions={launchOptions} commands={commands} workspaces={workspaces} onUpdate={onUpdate} />
      </Block>
      <Block anchor={settingAnchor('settings.stages.exits', stage.id)}>
        <BlockHeading n={3} title={t('settings.stages.exits')} hint={t('settings.stages.exits.hint')} />
        <Exits stage={stage} stages={stages} transitions={transitions} sources={sources} onUpdate={onUpdate} onSelect={onSelectTransition} onAdd={onAddTransition} />
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
  const agentFields = ['settings.stages.agent', 'settings.stages.model', 'settings.stages.session', 'settings.stages.specializedAgent', stage.action === 'skill' ? 'settings.stages.skill' : 'settings.stages.prompt', 'settings.stages.approval', 'settings.stages.handoff'] as const;
  const itself = { label: path[2], path: path.slice(0, 2), view, anchor: settingAnchor('settings.stages.name', stage.id) };
  return [
    itself,
    ...contextEntries([
      'settings.stages.name', 'settings.stages.enter', 'settings.stages.from', 'settings.stages.after', 'settings.stages.maxWorkers', 'settings.stages.run', 'settings.stages.action',
      ...(isAgentDraft(stage) ? agentFields : []),
      ...(gate ? (['settings.stages.approval'] as const) : []),
      'settings.stages.exits',
    ], view, path, stage.id),
  ];
}
