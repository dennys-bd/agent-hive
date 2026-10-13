import { Fragment, type ReactNode } from 'react';
import { agentName } from '../../agents';
import { sessionText } from '@/components/RunFields';
import { AGENT_COLOR, AgentIcon } from '@/components/SessionLabel';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { RunPicks } from '@/hooks/use-run-pick';
import { t } from '@/i18n';

// The model the run passes, as runModel resolves it: an explicit pick, else the stage's, else the agent's own default
const modelText = (picks: RunPicks, stageModel?: string): string => picks.model || stageModel || t('newSession.model.default', { agent: agentName(picks.agent) });

// The hover's lines: every pick in full, the specialized agent and the args in mono and never cut
function RunDetails({ picks, stageModel }: { picks: RunPicks; stageModel?: string }) {
  const args = picks.args.trim();
  const rows: [string, string, boolean][] = [
    [t('newSession.agent'), agentName(picks.agent), false],
    [t('newSession.model'), modelText(picks, stageModel), false],
    [t('session.pick'), sessionText(picks.session), false],
    [t('newSession.specializedAgent'), picks.specializedAgent || t('newSession.agents.none'), picks.specializedAgent !== ''],
    [t('newSession.args'), args || '—', args !== ''],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
      {rows.map(([label, value, isMono]) => (
        <Fragment key={label}><dt className="text-muted-foreground">{label}</dt><dd className={isMono ? 'break-all font-mono' : ''}>{value}</dd></Fragment>
      ))}
    </dl>
  );
}

interface RunSummaryProps { picks: RunPicks; stageModel?: string; isCustomizable: boolean; isOpen: boolean; onToggle(isOpen: boolean): void }

/** executar etapas' first summary row (#290, handoff "Modo executar etapas"): what the run launches with, cut with an ellipsis and listed in full
 * on hover, and personalizar › on the right when the run is a start. Two cells of StagesBox's grid. */
export function RunSummary({ picks, stageModel, isCustomizable, isOpen, onToggle }: RunSummaryProps) {
  const line = `${agentName(picks.agent)} · ${modelText(picks, stageModel)} · ${t('run.sessionIs', { session: sessionText(picks.session) })}`;
  return (
    <>
      <span className="text-muted-foreground">{t('run.label')}</span>
      <span className="flex min-w-0 items-center gap-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex min-w-0 flex-1 items-center gap-1.5"><AgentIcon agent={picks.agent} className={`size-3.5 shrink-0 ${AGENT_COLOR[picks.agent] ?? ''}`} /><span className="truncate">{line}</span></span>
            </TooltipTrigger>
            <TooltipContent className="w-[260px]"><RunDetails picks={picks} stageModel={stageModel} /></TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {isCustomizable && (
          <button type="button" aria-expanded={isOpen} onClick={() => onToggle(!isOpen)} className="shrink-0 text-muted-foreground hover:text-foreground">{t('run.customize')} ›</button>
        )}
      </span>
    </>
  );
}

interface RunCustomizeProps { stage: string; isChanged: boolean; onRestore(): void; children: ReactNode }

/** personalizar's block (#290): execução de {stage} with padrão da etapa, or restaurar padrão once a field changed; the fields; the note that the
 * pick is for this run only. */
export function RunCustomize({ stage, isChanged, onRestore, children }: RunCustomizeProps) {
  return (
    <section aria-label={t('run.title', { stage })} className="flex flex-col gap-2.5 rounded-md border p-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-medium text-sm">{t('run.title', { stage })}</h3>
        {isChanged
          ? <button type="button" onClick={onRestore} className="text-xs underline">{t('run.restore')}</button>
          : <span className="text-muted-foreground text-xs">{t('run.stageDefault')}</span>}
      </div>
      {children}
      <p className="text-muted-foreground text-xs">{t('run.note')}</p>
    </section>
  );
}
