import { ChevronDownIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { liveDefaultAgent } from '../../agents';
import { type AgentId, DEFAULT_AGENT, type DisabledRuleStatus, type DisableUntil, type EffectiveLimits, type State, type UsageRule } from '../../types';
import { workerCount } from '../../worker-count';
import { act } from '@/components/actions';
import { Confirm } from '@/components/Confirm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { type MessageKey, t } from '@/i18n';
import { signalEffect } from '@/lib/signal-effect';
import { clock, countdown, describeRules, nextMorning, type PauseChoice, pauseUntil, ruleTarget, timeLeft, windowResetsAt } from '@/lib/usage';

interface FooterProps { state: State; effective: EffectiveLimits; locale: string; onEditRules?(): void; console?: ReactNode } // console: its chip (redesign 05)

// The footer's chips and buttons share the 1px 8px chip box of the handoff (02), on the ui Button so focus and hover come with it.
const CHIP = 'h-auto gap-1.5 rounded-sm px-2 py-px text-xs font-normal text-foreground';

// Two rules are the same one when they share a source, a floor, a stage and an agent (#929): the payload crosses JSON, so identity is lost.
/** The search's pausar regra › reads the rules through these three too (#584). */
export const ruleKey = (rule: UsageRule): string => `${rule.source}-${rule.percent}-${rule.stage ?? ''}-${rule.agent ?? ''}`;

/** The fired rules in force, each once: the signal's, the cap's, then every stage cap's. */
export function firedRules(effective: EffectiveLimits): UsageRule[] {
  const all = [...effective.signalRules, ...effective.capRules, ...Object.values(effective.stageCapRules).flat()];
  return all.filter((rule, i) => all.findIndex((other) => ruleKey(other) === ruleKey(rule)) === i);
}

/** `semana ≥ 90% · codex → máx 2 workers`: the rule, its agent when it is not the default one (#929), then what it does. */
export function ruleLabel(rule: UsageRule, defaultAgent: AgentId = DEFAULT_AGENT): string {
  const effects = [
    ...(rule.signal ? [rule.signal] : []),
    ...(rule.maxWorkers === undefined ? [] : [rule.stage ? t('footer.rule.stageCap', { stage: rule.stage, n: rule.maxWorkers }) : t('footer.rule.cap', { n: rule.maxWorkers })]),
  ];
  return `${describeRules([rule], defaultAgent)} → ${effects.join(' · ')}`;
}

function MenuItem({ onClick, hint, muted, children }: { onClick(): void; hint?: string; muted?: boolean; children: ReactNode }) {
  return (
    <Button
      type="button" variant="ghost" onClick={onClick}
      className={`h-auto w-full justify-between rounded-sm px-2 py-1.5 text-[13px] font-normal ${muted ? 'text-muted-foreground' : ''}`}
    >
      <span>{children}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </Button>
  );
}

// personalizado… (02): a native date and time field, posted only once it is in the future.
function CustomPause({ onPause }: { onPause(until: DisableUntil): void }) {
  const [value, setValue] = useState('');
  const at = Date.parse(value); // datetime-local has no offset, so it parses as local time
  const valid = Number.isFinite(at) && at > Date.now();
  const submit = (e: FormEvent) => { e.preventDefault(); if (valid) onPause({ kind: 'at', at: new Date(at).toISOString() }); };
  return (
    <form onSubmit={submit} className="flex items-center gap-1 px-1 py-1">
      <Input type="datetime-local" aria-label={t('pause.customLabel')} value={value} onChange={(e) => setValue(e.target.value)} className="h-7 text-xs" />
      <Button type="submit" size="xs" disabled={!valid}>{t('pause.customApply')}</Button>
    </form>
  );
}

const FIXED: { choice: Exclude<PauseChoice, 'reset' | 'tomorrow'>; key: MessageKey }[] = [
  { choice: 'quarter', key: 'pause.quarter' }, { choice: 'hour', key: 'pause.hour' }, { choice: 'fourHours', key: 'pause.fourHours' },
];

interface RuleChipProps { rule: UsageRule; paused: boolean; state: State; locale: string; onEditRules?(): void }

/** A rule's chip and its pausar regra popover (02): the horizons, personalizado…, retomar agora while paused, and a way to the rules. */
function RuleChip({ rule, paused, state, locale, onEditRules }: RuleChipProps) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const now = Date.now();
  const resetAt = windowResetsAt(state, rule); // #929: its own agent's window
  const close = () => { setOpen(false); setCustom(false); };
  const pause = (until: DisableUntil) => { close(); void act('/rules/disable', { ...ruleTarget(rule), until }); };
  const resume = () => { close(); void act('/rules/enable', ruleTarget(rule)); };
  return (
    <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className={`${CHIP} ${paused ? 'text-muted-foreground line-through' : ''}`}>
          {ruleLabel(rule, liveDefaultAgent(state))}
          <ChevronDownIcon className="size-3 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="flex w-[244px] flex-col p-1">
        <div className="px-2 pt-1.5 pb-1 text-xs text-muted-foreground">{t('pause.title')}</div>
        {paused && <MenuItem onClick={resume}>{t('pause.resume')}</MenuItem>}
        <MenuItem onClick={() => pause(pauseUntil('reset', now))} hint={resetAt && countdown(resetAt, now)}>{t('pause.reset')}</MenuItem>
        {FIXED.map(({ choice, key }) => <MenuItem key={choice} onClick={() => pause(pauseUntil(choice, now))}>{t(key)}</MenuItem>)}
        <MenuItem onClick={() => pause(pauseUntil('tomorrow', now))} hint={clock(nextMorning(now).toISOString(), locale)}>{t('pause.tomorrow')}</MenuItem>
        {custom ? <CustomPause onPause={pause} /> : <MenuItem onClick={() => setCustom(true)}>{t('pause.custom')}</MenuItem>}
        {onEditRules && (
          <>
            <div className="-mx-1 my-1 h-px bg-border" />
            <MenuItem muted onClick={() => { close(); onEditRules(); }}>{t('pause.edit')}</MenuItem>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

// A paused rule: its struck-through chip, then `pausada · 52 min`, `~` when the end is an estimate (reset on hour / day); a pause until
// religar has no end to show.
function PausedRule({ status, ...chip }: Omit<RuleChipProps, 'rule' | 'paused'> & { status: DisabledRuleStatus }) {
  const left = status.backAt === undefined ? '' : ` · ${status.estimate ? '~' : ''}${timeLeft(status.backAt, Date.now())}`;
  return (
    <>
      <RuleChip rule={status.rule} paused {...chip} />
      <span>{t('footer.paused')}{left}</span>
    </>
  );
}

// Shut down when done (#233): arming asks first, since an idle Hive shuts the Mac down at once; cancelling posts at once.
function Shutdown({ armed }: { armed: boolean }) {
  if (armed) {
    return (
      <>
        <span className="text-waiting">{t('footer.shuttingDown')}</span>
        <Button type="button" variant="outline" className={CHIP} onClick={() => { void act('/shutdown', { armed: false }); }}>{t('footer.cancelShutdown')}</Button>
      </>
    );
  }
  const trigger = <Button type="button" variant="outline" className={CHIP}>{t('shutdown.toggle')}</Button>;
  return <Confirm message={t('confirm.shutdown')} confirmLabel={t('shutdown.arm')} trigger={trigger} onConfirm={() => act('/shutdown', { armed: true })} />;
}

/** The window's footer (redesign 02), the same under fluxo and atividades: the effective signal and what it holds back, the workers, the
 * rules in force and the paused ones, each opening its pausar regra popover, then the console's chip (redesign 05) and shut down when done at
 * the right edge. */
export function Footer({ state, effective, locale, onEditRules, console: consoleChip }: FooterProps) {
  const fired = firedRules(effective);
  const chip = { state, locale, onEditRules };
  const effect = signalEffect(effective.signal, state.signals);
  return (
    <footer className="flex h-[30px] shrink-0 items-center gap-3 border-t px-3 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span role="status" data-signal={effective.signal} className="signal-pill rounded-sm px-2 py-px font-medium">{effective.signal}</span>
        {effect}
      </span>
      <span>{t('footer.workers', { active: workerCount(state.workers), max: effective.maxWorkers ?? state.maxConcurrent })}</span>
      {fired.length + effective.disabledRules.length > 0 && (
        <>
          <span aria-hidden="true" className="h-3.5 w-px bg-border" />
          <span>{t('footer.rules')}</span>
          {fired.map((rule) => <RuleChip key={ruleKey(rule)} rule={rule} paused={false} {...chip} />)}
          {effective.disabledRules.map((status) => <PausedRule key={`off-${ruleKey(status.rule)}`} status={status} {...chip} />)}
        </>
      )}
      <span className="flex-1" />
      {consoleChip}
      <Shutdown armed={state.shutdown !== undefined} />
    </footer>
  );
}
