import { ChevronDownIcon } from 'lucide-react';
import { useContext, useState } from 'react';
import { agentName } from '../../../agents';
import { REVIEW_WHEN, type ReviewWhen } from '../../../types';
import { AgentField, ModelMenu } from '@/components/LaunchMenus';
import { AgentsContext, DefaultAgentContext } from '@/components/NewRunButton';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { Annotations } from '@/hooks/use-annotations';
import { useLaunchOptions } from '@/hooks/use-launch-options';
import type { Review } from '@/hooks/use-reviewer';
import { type MessageKey, t, tPlural } from '@/i18n';

const WHEN: Record<ReviewWhen, MessageKey> = { type: 'plugins.reviewer.when.type', save: 'plugins.reviewer.when.save', demand: 'plugins.reviewer.when.demand' };
const ROW = 'flex flex-col gap-1.5 border-t px-3 py-2.5';
const CAPTION = 'font-normal text-[11px] text-muted-foreground';
const isWhen = (value: string): value is ReviewWhen => (REVIEW_WHEN as readonly string[]).includes(value);

// #327's counter with the reviewer's states: a run wins, off reads as off (decisions "While running", "Off state")
function counterOf({ config, running }: Review, count: number): string {
  if (running) return t('plugins.head.reviewer.running');
  if (!config.on) return count === 0 ? t('plugins.head.reviewerOff.none') : tPlural('plugins.head.reviewerOff', count, { count });
  return count === 0 ? t('plugins.head.reviewer.none') : tPlural('plugins.head.reviewer', count, { count });
}

// "agent": the Start dialog's two fields. Default agent and model are null; another agent resets the model, whose list is the first
// workspace's, since a model list does not depend on the workspace (none: only the default). Read once per open of the menu
function AgentRow({ review, workspace }: { review: Review; workspace?: string }) {
  const agents = useContext(AgentsContext);
  const defaultAgent = useContext(DefaultAgentContext);
  const options = useLaunchOptions(workspace);
  const [isModelOpen, setModelOpen] = useState(false);
  const { agent, model } = review.config;
  const runs = agent ?? defaultAgent;
  return (
    <div className={ROW}>
      <Label htmlFor="reviewer-agent" className={CAPTION}>{t('plugins.reviewer.agent')}</Label>
      <AgentField
        id="reviewer-agent" value={agent} agents={agents} defaultLabel={t('plugins.reviewer.agentDefault', { agent: agentName(defaultAgent) })}
        onChange={(picked) => void review.set({ agent: picked, model: null })} onDefault={() => void review.set({ agent: null, model: null })} onOpenChange={() => undefined}
      />
      <ModelMenu agent={runs} options={options?.[runs]} value={model ?? ''} open={isModelOpen} onOpenChange={setModelOpen} onPick={(picked) => void review.set({ model: picked === '' ? null : picked })} />
      <p className="text-[11px] text-muted-foreground leading-[15px]">{t('plugins.reviewer.plan')}</p>
    </div>
  );
}

// Screen 11p, top to bottom: the switch, "reviews", the agent, review now, the failure's line; red is only the line's (design-system.md)
function MenuBody({ review, workspace }: { review: Review; workspace?: string }) {
  const { config, running, canReview, error } = review;
  return (
    <div className="flex flex-col text-[13px]">
      <div className="flex items-center gap-2 px-3 py-2.5">
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

/** The head's reviewer (#329, screen 11p): #327's counter, which jumps to the next annotation and is disabled at zero, beside a ⌄ that opens
 * the 300 px menu under it. Radix closes the menu on Esc and stops that Esc there, so an open card stays. A failure puts a red dot on the ⌄. */
export function ReviewerMenu({ annotations, workspaces, className = '' }: { annotations: Annotations; workspaces: readonly string[]; className?: string }) {
  const { review, list } = annotations;
  const count = list.length;
  const hasError = review.error !== undefined;
  return (
    <span className={`flex ${className}`}>
      <Button type="button" size="sm" variant="outline" disabled={count === 0} onClick={() => annotations.next()} className={`rounded-r-none ${review.config.on ? '' : 'text-muted-foreground'}`}>
        {counterOf(review, count)}
      </Button>
      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" size="sm" variant="outline" aria-label={t('plugins.reviewer.menu')} data-error={hasError} className="relative -ml-px rounded-l-none px-1.5">
            <ChevronDownIcon />
            {hasError && <span aria-hidden="true" className="absolute top-1 right-1 size-1.5 rounded-full bg-destructive" />}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[300px] p-0"><MenuBody review={review} workspace={workspaces[0]} /></PopoverContent>
      </Popover>
    </span>
  );
}
