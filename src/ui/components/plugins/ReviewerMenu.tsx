import { ChevronDownIcon } from 'lucide-react';
import { useContext } from 'react';
import { agentName } from '../../../agents';
import { REVIEW_WHEN, type ReviewWhen } from '../../../types';
import { DefaultAgentContext } from '@/components/NewRunButton';
import { AgentModelChip } from '@/components/plugins/AgentModelChip';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { Annotations } from '@/hooks/use-annotations';
import type { Review } from '@/hooks/use-reviewer';
import { type MessageKey, t, tPlural } from '@/i18n';

const WHEN: Record<ReviewWhen, MessageKey> = { type: 'plugins.reviewer.when.type', save: 'plugins.reviewer.when.save', demand: 'plugins.reviewer.when.demand' };
const ROW = 'flex flex-col gap-1.5 border-t px-3 py-2.5';
const CAPTION = 'font-normal text-muted-foreground text-xs';
const isWhen = (value: string): value is ReviewWhen => (REVIEW_WHEN as readonly string[]).includes(value);

// #327's counter with the reviewer's states: a run wins, off reads as off (decisions "While running", "Off state")
function counterOf({ config, running }: Review, count: number): string {
  if (running) return t('plugins.head.reviewer.running');
  if (!config.on) return count === 0 ? t('plugins.head.reviewerOff.none') : tPlural('plugins.head.reviewerOff', count, { count });
  return count === 0 ? t('plugins.head.reviewer.none') : tPlural('plugins.head.reviewer', count, { count });
}

// #492: the trigger leads with the worst annotation's status colour; a run shows its spinner instead, off and zero show nothing
function Lead({ annotations }: { annotations: Annotations }) {
  const { review, list } = annotations;
  if (review.running) return <Spinner />;
  if (!review.config.on || list.length === 0) return null;
  const isRed = list.some((annotation) => annotation.severity === 'red');
  return <span aria-hidden="true" data-severity={isRed ? 'red' : 'yellow'} className={`size-1.5 shrink-0 rounded-full ${isRed ? 'bg-destructive' : 'bg-waiting'}`} />;
}

// "agent": the shared agent and model chip (#492), with the default entry that puts both back to null. Another agent resets the model,
// whose list is the first workspace's, since a model list does not depend on the workspace
function AgentRow({ review, workspace }: { review: Review; workspace?: string }) {
  const defaultAgent = useContext(DefaultAgentContext);
  const { agent, model } = review.config;
  return (
    <div className={ROW}>
      <span className={CAPTION}>{t('plugins.reviewer.agent')}</span>
      <AgentModelChip
        label={t('plugins.reviewer.agent')} workspace={workspace} pick={{ agent: agent ?? defaultAgent, model: model ?? '' }}
        onPick={(picked) => void review.set({ agent: picked.agent, model: picked.model === '' ? null : picked.model })}
        defaultLabel={t('plugins.reviewer.agentDefault', { agent: agentName(defaultAgent) })} onDefault={() => void review.set({ agent: null, model: null })}
      />
      <p className="text-muted-foreground text-xs">{t('plugins.reviewer.plan')}</p>
    </div>
  );
}

// Screen 11p, top to bottom (#492): the jump to the next annotation, the switch, "reviews", the agent, review now, the failure's line; red is
// only the line's (design-system.md)
function MenuBody({ annotations, workspace }: { annotations: Annotations; workspace?: string }) {
  const { review, list } = annotations;
  const { config, running, canReview, error } = review;
  return (
    <div className="flex flex-col text-sm">
      <div className="p-1.5">
        <Button type="button" size="sm" variant="ghost" className="w-full justify-start" disabled={list.length === 0} onClick={() => annotations.next()}>{t('plugins.reviewer.next')}</Button>
      </div>
      <div className="flex items-center gap-2 border-t px-3 py-2.5">
        <Label htmlFor="reviewer-on" className="flex-1 font-medium">{t('plugins.reviewer.on')}</Label>
        <Switch id="reviewer-on" checked={config.on} onCheckedChange={(on) => void review.set({ on })} />
      </div>
      <div className={ROW}>
        <span id="reviewer-when" className={CAPTION}>{t('plugins.reviewer.when')}</span>
        <ToggleGroup type="single" size="xs" aria-labelledby="reviewer-when" value={config.when} onValueChange={(when) => { if (isWhen(when)) void review.set({ when }); }} className="w-full rounded-md border bg-background p-0.5">
          {REVIEW_WHEN.map((when) => <ToggleGroupItem key={when} value={when} className="flex-1">{t(WHEN[when])}</ToggleGroupItem>)}
        </ToggleGroup>
      </div>
      <AgentRow review={review} workspace={workspace} />
      <div className="border-t p-1.5">
        <Button type="button" size="sm" variant="ghost" className="w-full justify-start" disabled={running || !config.on || !canReview} onClick={() => review.now()}>{t('plugins.reviewer.now')}</Button>
      </div>
      {error && <p role="alert" className="border-t px-3 py-2 text-destructive text-xs">{t(error)}</p>}
    </div>
  );
}

/** The head's reviewer (#329, screen 11p; #492): one trigger named by #327's counter, led by the worst annotation's dot, that opens the 300 px
 * menu under it; the jump to the next annotation is the menu's first row. Radix closes the menu on Esc and stops that Esc there, so an open
 * card stays. A failure puts a red dot in the trigger's corner. */
export function ReviewerMenu({ annotations, workspaces, className = '' }: { annotations: Annotations; workspaces: readonly string[]; className?: string }) {
  const { review, list } = annotations;
  const hasError = review.error !== undefined;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" size="xs" variant="outline" data-error={hasError} className={`relative ${review.config.on ? '' : 'text-muted-foreground'} ${className}`}>
          <Lead annotations={annotations} />
          {counterOf(review, list.length)}
          <ChevronDownIcon aria-hidden="true" />
          {hasError && <span aria-hidden="true" className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-destructive" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[300px] p-0"><MenuBody annotations={annotations} workspace={workspaces[0]} /></PopoverContent>
    </Popover>
  );
}
