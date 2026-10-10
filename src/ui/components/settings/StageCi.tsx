import { XIcon } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { type MessageKey, t } from '@/i18n';
import type { StageDraft } from '@/lib/settings-stages';
import { CI_CHECKS, type CiChecks } from '../../../types';

// A wait-for-CI stage's executa block (#834, handoff 6b): where the checks come from (the task's PRs, the one source today), which ones count,
// the chips under só estes; on the right how long it waits, the re-run switch and the verdict note.

interface StageCiProps { id: string; stage: StageDraft; onUpdate(patch: Partial<StageDraft>): void }

const WHICH: Record<CiChecks, MessageKey> = {
  required: 'settings.stages.ci.which.required', all: 'settings.stages.ci.which.all', list: 'settings.stages.ci.which.list',
};
const FROM_PR = 'pr'; // the one source: no config key until a second one exists

const Hint = ({ text }: { text: string }) => <p className="text-muted-foreground text-xs">{text}</p>;

// de onde, with its one option, and quais checks side by side
function CheckSource({ id, stage, onUpdate }: StageCiProps) {
  return (
    <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={`${id}-ciFrom`}>{t('settings.stages.ci.from')}</Label>
        <Select value={FROM_PR}>
          <SelectTrigger id={`${id}-ciFrom`} className="w-full"><SelectValue>{t('settings.stages.ci.from.prChecks')}</SelectValue></SelectTrigger>
          <SelectContent><SelectItem value={FROM_PR}>{t('settings.stages.ci.from.prChecks')}</SelectItem></SelectContent>
        </Select>
        <Hint text={t('settings.stages.ci.from.hint')} />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={`${id}-ciChecks`}>{t('settings.stages.ci.which')}</Label>
        <Select value={stage.ciChecks} onValueChange={(picked) => onUpdate({ ciChecks: CI_CHECKS.find((c) => c === picked) ?? 'required' })}>
          <SelectTrigger id={`${id}-ciChecks`} className="w-full"><SelectValue>{t(WHICH[stage.ciChecks])}</SelectValue></SelectTrigger>
          <SelectContent>{CI_CHECKS.map((c) => <SelectItem key={c} value={c}>{t(WHICH[c])}</SelectItem>)}</SelectContent>
        </Select>
        <Hint text={t('settings.stages.ci.which.hint')} />
      </div>
    </div>
  );
}

// The chips under só estes: Enter or a comma adds what was typed, trimmed; a name already there is ignored; x removes one
function CheckChips({ id, checks, onChange }: { id: string; checks: string[]; onChange(checks: string[]): void }) {
  const [typed, setTyped] = useState('');
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' && event.key !== ',') return;
    event.preventDefault();
    const name = typed.trim();
    if (name !== '' && !checks.includes(name)) onChange([...checks, name]);
    setTyped('');
  };
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={`${id}-checks`}>{t('settings.stages.ci.checks')}</Label>
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border p-1.5">
        {checks.map((name) => (
          <span key={name} className="flex items-center gap-1 rounded-sm border py-0.5 pr-0.5 pl-2 font-mono text-xs">
            {name}
            <Button type="button" variant="ghost" size="icon-xs" aria-label={t('settings.stages.ci.checks.remove', { name })} onClick={() => onChange(checks.filter((c) => c !== name))}><XIcon /></Button>
          </span>
        ))}
        <Input
          id={`${id}-checks`} value={typed} placeholder={t('settings.stages.ci.checks.placeholder')} onChange={(e) => setTyped(e.target.value)} onKeyDown={onKeyDown}
          className="h-7 min-w-32 flex-1 border-0 font-mono shadow-none focus-visible:ring-0"
        />
      </div>
      <Hint text={t('settings.stages.ci.checks.hint')} />
    </div>
  );
}

// espera até (mono, 7rem; empty = no limit), the re-run switch and the verdict note
function WaitSide({ id, stage, onUpdate }: StageCiProps) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`${id}-ciTimeout`}>{t('settings.stages.ci.timeout')}</Label>
      <Input id={`${id}-ciTimeout`} className="w-28 font-mono" placeholder={t('settings.stages.ci.timeout.placeholder')} defaultValue={stage.timeout} onChange={(e) => onUpdate({ timeout: e.target.value })} />
      <Hint text={t('settings.stages.ci.timeout.hint')} />
      <div className="mt-2 flex items-center gap-2">
        <Switch id={`${id}-rerunOnce`} checked={stage.rerunOnce} onCheckedChange={(rerunOnce) => onUpdate({ rerunOnce })} />
        <Label htmlFor={`${id}-rerunOnce`}>{t('settings.stages.ci.rerunOnce')}</Label>
      </div>
      <Hint text={t('settings.stages.ci.rerunOnce.hint')} />
      <p className="mt-2 text-muted-foreground text-xs">{t('settings.stages.ci.note')}</p>
    </div>
  );
}

/** The aguardar CI block (#834): grid 2fr / 1fr, gap 12, aligned to the top. */
export function StageCi({ id, stage, onUpdate }: StageCiProps) {
  return (
    <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-3">
        <CheckSource id={id} stage={stage} onUpdate={onUpdate} />
        {stage.ciChecks === 'list' && <CheckChips id={id} checks={stage.checks} onChange={(checks) => onUpdate({ checks })} />}
      </div>
      <WaitSide id={id} stage={stage} onUpdate={onUpdate} />
    </div>
  );
}
