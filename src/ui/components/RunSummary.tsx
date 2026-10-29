import { Fragment, type ReactNode, type RefObject, useContext, useEffect, useRef } from 'react';
import { agentName } from '../../agents';
import { sessionText } from '@/components/RunFields';
import { AGENT_COLOR, AgentIcon } from '@/components/SessionLabel';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { RunPicks } from '@/hooks/use-run-pick';
import { t } from '@/i18n';
import { AgentModelsContext } from '@/lib/agent-settings';

// The model the run passes, as runModel resolves it: an explicit pick, else the stage's, else the agent's default model (#482), else its own
const modelText = (picks: RunPicks, stageModel?: string, agentDefault?: string | null): string =>
  picks.model || stageModel || (agentDefault ? `${t('newSession.model.agentDefault')} · ${agentDefault}` : t('newSession.model.default', { agent: agentName(picks.agent) }));

// The hover's lines: every pick in full, the specialized agent and the args in mono and never cut
function RunDetails({ picks, stageModel, agentDefault }: { picks: RunPicks; stageModel?: string; agentDefault?: string | null }) {
  const args = picks.args.trim();
  const rows: [string, string, boolean][] = [
    [t('newSession.agent'), agentName(picks.agent), false],
    [t('newSession.model'), modelText(picks, stageModel, agentDefault), false],
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

/** personalizar's focus (#893): the toggle's button unmounts with its row, so the focus would drop to the body. Each direction hands it to the
 * button that appears: personalizar ‹ when the block opens, personalizar › when it closes. Not on first mount: nothing was toggled yet. */
export function useCustomizeFocus(isOpen: boolean): { openRef: RefObject<HTMLButtonElement | null>; closeRef: RefObject<HTMLButtonElement | null> } {
  const openRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const was = useRef(isOpen);
  useEffect(() => {
    if (was.current !== isOpen) (isOpen ? closeRef : openRef).current?.focus();
    was.current = isOpen;
  }, [isOpen]);
  return { openRef, closeRef };
}

interface RunSummaryProps { picks: RunPicks; stageModel?: string; isCustomizable: boolean; isOpen: boolean; onToggle(isOpen: boolean): void; buttonRef?: RefObject<HTMLButtonElement | null> }

/** executar etapas' first summary row (#290, handoff "Modo executar etapas"): what the run launches with, cut with an ellipsis and listed in full
 * on hover, and personalizar › on the right when the run is a start. Two cells of StagesBox's grid. */
export function RunSummary({ picks, stageModel, isCustomizable, isOpen, onToggle, buttonRef }: RunSummaryProps) {
  const agentDefault = useContext(AgentModelsContext)[picks.agent];
  const line = `${agentName(picks.agent)} · ${modelText(picks, stageModel, agentDefault)} · ${t('run.sessionIs', { session: sessionText(picks.session) })}`;
  return (
    <>
      <span className="text-muted-foreground">{t('run.label')}</span>
      <span className="flex min-w-0 items-center gap-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex min-w-0 flex-1 items-center gap-1.5"><AgentIcon agent={picks.agent} className={`size-3.5 shrink-0 ${AGENT_COLOR[picks.agent] ?? ''}`} /><span className="truncate">{line}</span></span>
            </TooltipTrigger>
            <TooltipContent className="w-[260px]"><RunDetails picks={picks} stageModel={stageModel} agentDefault={agentDefault} /></TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {isCustomizable && (
          <button ref={buttonRef} type="button" aria-expanded={isOpen} onClick={() => onToggle(!isOpen)} className="shrink-0 text-muted-foreground hover:text-foreground">{t('run.customize')} ›</button>
        )}
      </span>
    </>
  );
}

interface RunCustomizeProps { stage: string; closeRef?: RefObject<HTMLButtonElement | null>; isChanged: boolean; onRestore(): void; onClose(): void; children: ReactNode }

/** personalizar's open block (#290, #893): above the stages box with no border, since the box drops its run row meanwhile and two boxes showed
 * the run twice. execução de {stage}, then personalizar ‹, which closes it (the row that held the toggle is hidden), and padrão da etapa, or
 * restaurar padrão once a field changed; the fields; the note that the pick is for this run only. */
export function RunCustomize({ stage, isChanged, onRestore, onClose, closeRef, children }: RunCustomizeProps) {
  return (
    <section aria-label={t('run.title', { stage })} className="flex flex-col gap-2.5">
      <div className="flex items-baseline gap-2">
        <h3 className="font-medium text-sm">{t('run.title', { stage })}</h3>
        <span className="flex-1" />
        <button ref={closeRef} type="button" aria-expanded onClick={onClose} className="text-muted-foreground text-xs hover:text-foreground">{t('run.customize')} ‹</button>
        {isChanged
          ? <button type="button" onClick={onRestore} className="text-xs underline">{t('run.restore')}</button>
          : <span className="text-muted-foreground text-xs">{t('run.stageDefault')}</span>}
      </div>
      {children}
      <p className="text-muted-foreground text-xs">{t('run.note')}</p>
    </section>
  );
}
