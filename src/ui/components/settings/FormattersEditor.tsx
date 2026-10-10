import { XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { WorkspaceScopePicker } from '@/components/settings/WorkspaceScopePicker';
import { t } from '@/i18n';
import { type CustomFormatterDraft, DEFAULT_FORMATTER_DRAFT, emptyCustomFormatter, type FormatterDraft, type LanguageDraft } from '@/lib/settings-format';
import { type Detection, detectionOf, listOf } from '@/lib/settings-languages';
import { formattersOf } from '../../../formatters';
import type { LanguageDef } from '../../../languages';
import type { FormatterId, FormatterState } from '../../../types';

interface FormattersEditorProps { language: LanguageDef; draft: LanguageDraft; names: readonly string[]; states?: FormatterState[]; onChange(draft: LanguageDraft): void }
interface SupportedRowProps { n: number; id: FormatterId; setting: FormatterDraft; state?: FormatterState; names: readonly string[]; onChange(setting: FormatterDraft): void }
interface CustomRowProps { n: number; row: CustomFormatterDraft; names: readonly string[]; onChange(patch: Partial<CustomFormatterDraft>): void; onRemove(): void }
const ROW = 'grid grid-cols-[1.25rem_9rem_minmax(0,1fr)_auto_13rem_2rem] items-center gap-2';
const SUB = 'grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2';

// encontrado em … in working, the rest muted (#780); a dash while GET /settings/formatters has not answered
function DetectionText({ detection }: { detection: Detection }) {
  if (detection.kind === 'unknown') return <span aria-hidden className="text-muted-foreground text-xs">—</span>;
  if (detection.kind === 'found') return <span className="text-working text-xs">{t('settings.formatters.found', { workspaces: listOf(detection.workspaces, t('settings.formatters.and')) })}</span>;
  return <span className="text-muted-foreground text-xs">{t(detection.kind === 'off' ? 'settings.install.off' : 'settings.formatters.notFound')}</span>;
}

function SupportedRow({ n, id, setting, state, names, onChange }: SupportedRowProps) {
  return (
    <fieldset aria-label={id} className="flex min-w-0 flex-col gap-2 border-b px-3 py-2.5">
      <div className={ROW}>
        <span className="text-muted-foreground text-xs">{n}</span>
        <span className="font-mono text-sm">{id}</span>
        <DetectionText detection={state === undefined ? { kind: 'unknown' } : detectionOf(state, setting.workspaces)} />
        <Switch aria-label={t('settings.format.enabled', { id })} checked={setting.enabled} onCheckedChange={(enabled) => onChange({ ...setting, enabled })} />
        <WorkspaceScopePicker label={t('settings.scope.of', { item: id })} scope={setting.workspaces} names={names} onChange={(workspaces) => onChange({ ...setting, workspaces })} />
        <span />
      </div>
      <div className={SUB}>
        <span />
        <Textarea aria-label={t('settings.format.argsOf', { id })} rows={1} spellCheck={false} className="min-h-8 font-mono text-xs" placeholder={t('settings.format.args')} value={setting.args} onChange={(e) => onChange({ ...setting, args: e.target.value })} />
      </div>
    </fieldset>
  );
}

function CustomRow({ n, row, names, onChange, onRemove }: CustomRowProps) {
  const remove = t('settings.format.custom.remove', { n });
  return (
    <fieldset aria-label={t('settings.format.custom.row', { n })} className="flex min-w-0 flex-col gap-2 border-b px-3 py-2.5">
      <div className={ROW}>
        <span className="text-muted-foreground text-xs">{n}</span>
        <Input aria-label={t('settings.format.custom.name', { n })} value={row.name} placeholder="sqlfluff" onChange={(e) => onChange({ name: e.target.value })} />
        <span className="text-muted-foreground text-xs">{t('settings.formatters.own')}</span>
        <span />
        <WorkspaceScopePicker label={t('settings.scope.of', { item: row.name.trim() || t('settings.format.custom.row', { n }) })} scope={row.workspaces} names={names} onChange={(workspaces) => onChange({ workspaces })} />
        <Button type="button" variant="ghost" size="icon-sm" aria-label={remove} title={remove} onClick={onRemove}><XIcon /></Button>
      </div>
      <div className={SUB}>
        <span />
        <div className="flex flex-col gap-1">
          <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-2">
            <Input aria-label={t('settings.format.custom.extensions', { n })} className="font-mono" value={row.extensions} placeholder=".sql, .psql" onChange={(e) => onChange({ extensions: e.target.value })} />
            <Input aria-label={t('settings.format.custom.command', { n })} className="font-mono" value={row.command} placeholder={'sqlfluff format --stdin-filename "$FILE" -'} onChange={(e) => onChange({ command: e.target.value })} />
          </div>
          <span className="text-muted-foreground text-xs">{t('settings.formatters.customHint')}</span>
        </div>
      </div>
    </fieldset>
  );
}

/** A language's formatters (#780), in the order a save tries them: its custom ones, then the supported ones that serve it in FORMATTERS order. */
export function FormattersEditor({ language, draft, names, states, onChange }: FormattersEditorProps) {
  const supported = formattersOf(language.id);
  const { custom } = draft;
  const updateCustom = (id: string, patch: Partial<CustomFormatterDraft>): void => onChange({ ...draft, custom: custom.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  const setSupported = (id: FormatterId) => (setting: FormatterDraft): void => onChange({ ...draft, formatters: { ...draft.formatters, [id]: setting } });
  return (
    <div className="flex flex-col rounded-md border">
      {custom.map((row, i) => (
        <CustomRow key={row.id} n={i + 1} row={row} names={names} onChange={(patch) => updateCustom(row.id, patch)} onRemove={() => onChange({ ...draft, custom: custom.filter((c) => c.id !== row.id) })} />
      ))}
      {supported.map((id, i) => (
        <SupportedRow key={id} n={custom.length + i + 1} id={id} setting={draft.formatters[id] ?? DEFAULT_FORMATTER_DRAFT} state={states?.find((s) => s.id === id)} names={names} onChange={setSupported(id)} />
      ))}
      {supported.length === 0 && <p className="border-b px-3 py-2.5 text-muted-foreground text-xs">{t('settings.formatters.none')}</p>}
      <div className="px-3 py-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ ...draft, custom: [...custom, emptyCustomFormatter(language.extensions)] })}>{t('settings.formatters.add')}</Button>
      </div>
    </div>
  );
}
