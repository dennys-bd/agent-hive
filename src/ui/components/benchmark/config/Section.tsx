// The config tab's shared frame (#463, benchmark.hv.html's .sect / .rows / .note): each section draws its rows and its form through these.
import { InfoIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { Experiment } from '../../../../types.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { DurationFields, SectionId } from '@/components/benchmark/config/config-lib';
import { saveSection, toastRefusal } from '@/components/benchmark/config/save-section';
import { t } from '@/i18n';

/** The screen's .note: an info line in a sunken box. */
export function Note({ children }: { children: ReactNode }) {
  return (
    <p role="note" className="flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-muted-foreground text-xs leading-4">
      <InfoIcon aria-hidden="true" className="size-3.5 shrink-0" />{children}
    </p>
  );
}

/** What a section's rows and form read of the tab's edit state (spec, "Editing model"). */
export interface SectionEdit { isOpen: boolean; isLocked: boolean; open(): void; close(): void; markDirty(): void; saved(id: string): void }

export interface SectionProps { title: string; sub: string; side?: ReactNode; note?: ReactNode; foot?: ReactNode; isDimmed?: boolean; children: ReactNode }

export function Section({ title, sub, side, note, foot, isDimmed = false, children }: SectionProps) {
  return (
    <section aria-label={title} className="flex flex-col gap-2.5">
      <div className="flex items-baseline gap-2.5">
        <h2 className="m-0 font-semibold text-sm">{title}</h2>
        <span className="flex-1 text-muted-foreground text-xs">{sub}</span>
        {side}
      </div>
      {note}
      <div className={`flex flex-col rounded-lg border ${isDimmed ? 'opacity-55' : ''}`}>{children}</div>
      {foot}
    </section>
  );
}

export interface ConfigRowProps { label: string; hint?: string; side?: ReactNode; isIsolation?: boolean; children: ReactNode }

// The screen's .row: 170px key, the value, the side; isolation's side is a fixed 150px for its scope
export function Row({ label, hint, side, isIsolation = false, children }: ConfigRowProps) {
  const grid = isIsolation ? 'grid-cols-[170px_minmax(0,1fr)_150px] py-1.5' : 'grid-cols-[170px_minmax(0,1fr)_auto] py-[7px]';
  return (
    // The row draws its own divider: a border-0 here (or the card's zero-specificity divide-y) would hide it
    <fieldset aria-label={label} className={`m-0 grid ${grid} items-center gap-4 border-t first:border-t-0 px-3.5 text-[13px]`}>
      <span className="flex flex-col gap-px"><span>{label}</span>{hint !== undefined && <small className="text-muted-foreground text-xs">{hint}</small>}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">{children}</span>
      <span className="justify-self-end whitespace-nowrap text-muted-foreground text-xs">{side}</span>
    </fieldset>
  );
}

/** The screen's .pill; isRisk is the warning's yellow border (colour only for status); arm prefixes the arm's letter in bold. */
export function Pill({ children, isMono = false, isRisk = false, arm }: { children: ReactNode; isMono?: boolean; isRisk?: boolean; arm?: string }) {
  return (
    <Badge variant="outline" className={`rounded-[5px] font-normal ${isMono ? 'font-mono' : ''} ${isRisk ? 'border-waiting' : ''}`}>
      {arm !== undefined && <b className="font-semibold text-muted-foreground">{arm}</b>}{children}
    </Badge>
  );
}

export const None = () => <span className="text-muted-foreground text-xs">{t('benchmark.config.none')}</span>;

export function Values({ texts, isMono = false }: { texts: readonly string[]; isMono?: boolean }) {
  if (texts.length === 0) return <None />;
  // biome-ignore lint/suspicious/noArrayIndexKey: read-only pills can repeat (two collectors alike, a repeated rubric line), so the text alone is no key
  return <>{texts.map((text, i) => <Pill key={`${i}:${text}`} isMono={isMono}>{text}</Pill>)}</>;
}

export const FieldError = ({ children }: { children: ReactNode }) => <p role="alert" className="w-full text-destructive text-xs">{children}</p>;

interface FieldProps { label: string; value: string; onChange(value: string): void; error?: string; type?: 'text' | 'time'; className?: string }

export function Field({ label, value, onChange, error, type = 'text', className = 'w-20' }: FieldProps) {
  return (
    <span className="flex flex-col gap-1">
      <Input type={type} aria-label={label} aria-invalid={error === undefined ? undefined : true} value={value} onChange={(e) => onChange(e.target.value)} className={`h-7 text-xs ${className}`} />
      {error !== undefined && <FieldError>{error}</FieldError>}
    </span>
  );
}

export function DurationField({ label, value, onChange }: { label: string; value: DurationFields; onChange(next: DurationFields): void }) {
  const of = (field: 'hours' | 'minutes'): string => t('benchmark.config.fieldOf', { field: t(`benchmark.config.${field}`), row: label });
  return (
    <span className="flex items-center gap-1 text-muted-foreground text-xs">
      <Field label={of('hours')} value={value.hours} onChange={(hours) => onChange({ ...value, hours })} className="w-14" />{t('benchmark.config.unit.h')}
      <Field label={of('minutes')} value={value.minutes} onChange={(minutes) => onChange({ ...value, minutes })} className="w-14" />{t('benchmark.config.unit.min')}
    </span>
  );
}

/** A row's editar: hidden while the experiment is locked, and while its own section is the one in edit. */
export function EditButton({ edit, label }: { edit: SectionEdit; label?: string }) {
  if (edit.isLocked || edit.isOpen) return null;
  return <Button type="button" variant="link" size="xs" className="h-auto p-0" onClick={edit.open}>{label ?? t('benchmark.config.edit')}</Button>;
}

interface EditFootProps { edit: SectionEdit; isValid: boolean; isSaving: boolean; onSave(): void; notice?: string; saveLabel?: string }

export function EditFoot({ edit, isValid, isSaving, onSave, notice, saveLabel }: EditFootProps) {
  return (
    <div className="flex items-center justify-end gap-2">
      {notice !== undefined && <span className="mr-auto text-muted-foreground text-xs">{notice}</span>}
      <Button type="button" variant="ghost" size="sm" onClick={edit.close}>{t('benchmark.config.cancel')}</Button>
      <Button type="button" size="sm" disabled={!isValid || isSaving} onClick={onSave}>{saveLabel ?? t('benchmark.config.save')}</Button>
    </div>
  );
}

/** A form's draft: every change marks the section dirty, which is what makes opening another section ask first. */
export function useDraft<T>(initial: () => T, edit: SectionEdit): [T, (next: T) => void] {
  const [draft, setDraft] = useState(initial);
  return [draft, (next) => { setDraft(next); edit.markDirty(); }];
}

/** salvar: one PATCH; the answer closes the form (and selects a fork). A refusal the form shows inline returns true from onRefusal; any
 * other is the status's toast. */
export function useSave(experimentId: string, edit: SectionEdit) {
  const [isSaving, setSaving] = useState(false);
  const save = async <K extends SectionId>(section: K, value: Experiment[K], onRefusal?: (err: unknown) => boolean): Promise<void> => {
    setSaving(true);
    try {
      edit.saved(await saveSection(experimentId, section, value));
    } catch (err) {
      if (onRefusal?.(err) !== true) toastRefusal(err);
      setSaving(false);
    }
  };
  return { isSaving, save };
}
