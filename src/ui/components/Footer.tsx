import { ChevronDownIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { liveDefaultAgent } from '../../agents';
import type { DisabledRuleStatus, DisableUntil, EffectiveLimits, State, UsageRule } from '../../types';
import { workerCount } from '../../worker-count';
import { act } from '@/components/actions';
import { AgentUsage } from '@/components/footer/AgentUsage';
import { PowerButtons } from '@/components/footer/PowerButtons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { type MessageKey, t } from '@/i18n';
import { firedRules, ruleKey, ruleLabel } from '@/lib/rule-effects';
import { signalEffect } from '@/lib/signal-effect';
import { clock, countdown, nextMorning, type PauseChoice, pauseUntil, ruleTarget, timeLeft, windowResetsAt } from '@/lib/usage';

interface FooterProps { state: State; effective: EffectiveLimits; locale: string; onEditRules?(): void; console?: ReactNode } // console: its chip (redesign 05)

// The footer's chips and buttons share the 1px 8px chip box of the handoff (02), on the ui Button so focus and hover come with it.
const CHIP = 'h-auto gap-1.5 rounded-sm px-2 py-px text-xs font-normal text-foreground';

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

/** The window's footer (redesign 02, #223), the same under fluxo and atividades: the agents' plan usage and its panel, the effective signal and what it holds back, the workers, the
 * rules in force and the paused ones, each opening its pausar regra popover, then the console's chip (redesign 05) and the power buttons
 * (#226) at the right edge. */
export function Footer({ state, effective, locale, onEditRules, console: consoleChip }: FooterProps) {
  const fired = firedRules(effective);
  const chip = { state, locale, onEditRules };
  const effect = signalEffect(effective.signal, state.signals);
  return (
    <footer className="relative flex h-[30px] shrink-0 items-center gap-3 border-t px-3 text-xs text-muted-foreground">
      <AgentUsage state={state} form="full" />{/* #223: 2.5 picks the form from the width */}
      <span aria-hidden="true" className="h-3.5 w-px bg-border" />
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
      <span aria-hidden="true" className="h-3.5 w-px bg-border" />
      <PowerButtons keepAwake={state.keepAwake === true} armed={state.shutdown !== undefined} />
    </footer>
  );
}
