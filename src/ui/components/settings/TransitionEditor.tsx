import { ArrowLeftIcon } from 'lucide-react';
import { useId } from 'react';
import { isAutomatic } from '../../../transitions';
import { END, type Trigger } from '../../../types';
import { SourceActions } from '@/components/settings/SourceActions';
import { Field } from '@/components/settings/StageBlocks';
import type { StageSource } from '@/components/settings/StageEditor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/i18n';
import { triggerLabel, verdictLabel } from '@/lib/flow-labels';
import { isGateDraft, type StageDraft, withEntry } from '@/lib/settings-stages';
import { draftVerdicts, type TransitionDraft, triggersOf } from '@/lib/settings-transitions';

interface TransitionEditorProps { transition: TransitionDraft; stages: StageDraft[]; sources: StageSource[]; backTo?: string; onUpdate(patch: Partial<TransitionDraft>): void; onRemove(): void; onBack?(): void }

const nameOf = (stages: readonly StageDraft[], id: string): string => (id === END ? t('flow.end') : stages.find((s) => s.id === id)?.name.trim() || t('settings.stages.unnamed'));
const SESSION_DEFAULT = 'default'; // the select's value for '': Radix refuses an empty value
const sessionValue = (s: TransitionDraft['session']): string => (s === '' ? SESSION_DEFAULT : typeof s === 'string' ? s : `of:${s.continueOf}`);
const sessionOf = (value: string): TransitionDraft['session'] =>
  (value === SESSION_DEFAULT ? '' : value === 'previous' || value === 'new' ? value : { continueOf: value.slice('of:'.length) });

// para and quando: the destination (the stages and fim) and the triggers the origin may fire, each with its own hint
function Route({ id, transition, stages, onUpdate }: Omit<TransitionEditorProps, 'sources' | 'onRemove'> & { id: string }) {
  const origin = stages.find((s) => s.id === transition.from);
  const triggers: Trigger[] = origin === undefined ? [transition.when] : triggersOf(origin);
  const verdicts = origin === undefined ? [] : draftVerdicts(origin);
  return (
    <>
      <Field id={`${id}-from`} label={t('settings.transitions.from')}><Input id={`${id}-from`} value={nameOf(stages, transition.from)} disabled readOnly /></Field>
      <Field id={`${id}-to`} label={t('settings.transitions.to')} hint={t('settings.transitions.to.hint')}>
        <Select value={transition.to} onValueChange={(to) => onUpdate({ to })}>
          <SelectTrigger id={`${id}-to`} aria-label={t('settings.transitions.to')} className="w-full"><SelectValue>{nameOf(stages, transition.to)}</SelectValue></SelectTrigger>
          <SelectContent>
            {stages.map((s) => <SelectItem key={s.id} value={s.id}>{nameOf(stages, s.id)}</SelectItem>)}
            <SelectItem value={END}>{t('flow.end')}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field id={`${id}-when`} label={t('settings.transitions.when')} hint={t(`settings.transitions.when.${transition.when}.hint`)}>
        <Select value={transition.when} onValueChange={(when) => onUpdate({ when: when as Trigger, verdict: when === 'verdict' ? verdicts[0] ?? '' : '' })}>
          <SelectTrigger id={`${id}-when`} aria-label={t('settings.transitions.when')} className="w-full"><SelectValue>{t(`settings.transitions.when.${transition.when}`)}</SelectValue></SelectTrigger>
          <SelectContent>{triggers.map((w) => <SelectItem key={w} value={w}>{t(`settings.transitions.when.${w}`)}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      {transition.when === 'verdict' && (
        <Field id={`${id}-verdict`} label={t('settings.transitions.verdict')}>
          <Select value={transition.verdict} onValueChange={(verdict) => onUpdate({ verdict })}>
            <SelectTrigger id={`${id}-verdict`} aria-label={t('settings.transitions.verdict')} className="w-full"><SelectValue>{verdictLabel(transition.verdict)}</SelectValue></SelectTrigger>
            <SelectContent>{verdicts.map((v) => <SelectItem key={v} value={v}>{verdictLabel(v)}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
      )}
    </>
  );
}

// tentativas and the fixed ao esgotar on an automatic transition; the note that the user's have no limit on any other
function Tries({ id, transition, onUpdate }: { id: string; transition: TransitionDraft; onUpdate(patch: Partial<TransitionDraft>): void }) {
  if (!isAutomatic(transition.when)) return <p className="text-muted-foreground text-xs md:col-span-2">{t('settings.transitions.userNote')}</p>;
  return (
    <>
      <Field id={`${id}-tries`} label={t('settings.transitions.tries')} hint={t('settings.transitions.tries.hint')}>
        <Input id={`${id}-tries`} type="number" min={1} step={1} defaultValue={transition.maxTries} onChange={(e) => onUpdate({ maxTries: e.target.value })} />
      </Field>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-medium text-sm">{t('settings.transitions.exhausted')}</span>
        <p className="py-1.5 text-sm">{t('settings.transitions.exhausted.value')}</p>
        <p className="text-muted-foreground text-xs">{t('settings.transitions.exhausted.hint')}</p>
      </div>
    </>
  );
}

// prompt da transição and sessão: the session it resumes, continuing any stage that runs a prompt
function Handover({ id, transition, stages, onUpdate }: Omit<TransitionEditorProps, 'sources' | 'onRemove'> & { id: string }) {
  const runners = stages.filter((s) => s.action === '' && !isGateDraft(s));
  const label = (value: string): string => (value === SESSION_DEFAULT ? t('settings.transitions.session.default') : value === 'previous' || value === 'new'
    ? t(`settings.transitions.session.${value}`) : t('settings.transitions.session.continueOf', { stage: nameOf(stages, value.slice('of:'.length)) }));
  return (
    <>
      <Field id={`${id}-prompt`} label={t('settings.transitions.prompt')} hint={t('settings.transitions.prompt.hint')}>
        <Textarea
          id={`${id}-prompt`} rows={3} spellCheck={false} defaultValue={transition.prompt} onChange={(e) => onUpdate({ prompt: e.target.value })}
          placeholder={t(transition.when === 'feedback' ? 'settings.transitions.prompt.feedbackPlaceholder' : 'settings.transitions.prompt.placeholder')}
        />
      </Field>
      <Field id={`${id}-session`} label={t('settings.transitions.session')} hint={t('settings.transitions.session.hint')}>
        <Select value={sessionValue(transition.session)} onValueChange={(v) => onUpdate({ session: sessionOf(v) })}>
          <SelectTrigger id={`${id}-session`} aria-label={t('settings.transitions.session')} className="w-full"><SelectValue>{label(sessionValue(transition.session))}</SelectValue></SelectTrigger>
          <SelectContent>
            {[SESSION_DEFAULT, 'previous', ...runners.map((s) => `of:${s.id}`), 'new'].map((v) => <SelectItem key={v} value={v}>{label(v)}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
    </>
  );
}

/** A transition's editor (#134, 6b): its title and mode, de / para / quando / veredito, the tries or the user's note, the prompt and the session,
 * and what each source does as the task passes. Opened from a stage's saídas (#887), it leads with a way back to that stage. Inputs are uncontrolled where they type; the editor is keyed by the transition. */
export function TransitionEditor({ transition, stages, sources, backTo, onUpdate, onRemove, onBack }: TransitionEditorProps) {
  const id = useId();
  const title = `${nameOf(stages, transition.from)} → ${nameOf(stages, transition.to)} · ${triggerLabel(transition.when, transition.verdict)}`;
  return (
    <section aria-label={title} className="flex flex-col gap-4 rounded-xl border bg-card p-5">
      {backTo !== undefined && onBack !== undefined && (
        <Button type="button" variant="ghost" size="sm" className="self-start" onClick={onBack}><ArrowLeftIcon />{t('settings.transitions.back', { stage: backTo })}</Button>
      )}
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs">{t('settings.transitions.title')}</span>
        <h3 className="font-medium text-sm">{title}</h3>
        <Badge variant="outline">{t(isAutomatic(transition.when) ? 'settings.transitions.auto' : 'settings.transitions.user')}</Badge>
        <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={onRemove}>{t('settings.transitions.remove')}</Button>
      </div>
      <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-4">
        <Route id={id} transition={transition} stages={stages} onUpdate={onUpdate} />
      </div>
      <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2"><Tries id={id} transition={transition} onUpdate={onUpdate} /></div>
      <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"><Handover id={id} transition={transition} stages={stages} onUpdate={onUpdate} /></div>
      {sources.length > 0 && (
        <table aria-label={t('settings.transitions.sources')} className="w-full rounded-md border text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground text-xs">
              <th className="px-3 py-2 font-medium">{t('settings.stages.exit.source')}</th>
              <th className="px-3 py-2 font-medium">{t('settings.transitions.sources.pass')}</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((b) => (
              <tr key={b.id} className="border-b last:border-b-0">
                <td className="w-40 px-3 py-2">{b.name}</td>
                <td className="px-3 py-2">
                  <SourceActions
                    list={transition.sources[b.id] ?? []} source={b} onStart={false} when={t('settings.transitions.sources.pass')}
                    onChange={(next) => onUpdate({ sources: withEntry(transition.sources, b.id, next.length > 0 ? next : undefined) })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
