import { type ReactNode, useEffect, useRef } from 'react';
import type { VariableKind } from '../../../template';
import { InfoTip } from '@/components/InfoTip';
import { ChoiceSelect } from '@/components/plugins/ChoiceSelect';
import { type Draft, defaultShown, effectiveShown, type Raws, valuesOf } from '@/components/plugins/variable-draft';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';
import { t } from '@/i18n';

interface DraftValueProps { kind: VariableKind; values: readonly string[]; raw: string; label: string; emptyLabel: string; isDisabled?: boolean; onChange(raw: string): void }
interface LinesProps { draft: Draft; workspaces: readonly string[]; raws: Raws; suffix?: string; emptyOf(workspace: string): string; onChange(workspace: string, raw: string): void }
interface SectionProps { draft: Draft; workspaces: readonly string[]; update(patch: Partial<Draft>): void }
interface OverrideProps extends SectionProps { canRemove: boolean; shouldFocus: boolean }

const MONO_INPUT = 'h-7 px-2 font-mono text-xs placeholder:italic';
const LINK = 'h-auto p-0 text-muted-foreground';

export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-1"><span className="text-muted-foreground">{label}</span>{children}</div>;
}

/** A text is an input whose empty shows the empty label as its placeholder; a list or yes/no is the shared select. */
export function DraftValue({ kind, values, raw, label, emptyLabel, isDisabled = false, onChange }: DraftValueProps) {
  if (kind !== 'text') return <ChoiceSelect kind={kind} values={values} raw={raw} label={label} emptyLabel={emptyLabel} isDisabled={isDisabled} className="h-7 w-full" onChange={onChange} />;
  return <Input aria-label={label} value={raw} placeholder={emptyLabel} disabled={isDisabled} onChange={(event) => onChange(event.target.value)} className={MONO_INPUT} />;
}

// The section's title with its explanation as the info icon's tooltip (#958's icon), never a hint line under it
const TitleWithTip = ({ title, note }: { title: string; note: string }) => (
  <span className="flex items-center gap-1"><span>{title}</span><InfoTip note={note} /></span>
);

// One line per configured workspace, in config order: square and name in an 88px column, then its control
function WorkspaceLines({ draft, workspaces, raws, suffix, emptyOf, onChange }: LinesProps) {
  const values = valuesOf(draft);
  return workspaces.map((w) => (
    <div key={w} className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-1.5">
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground"><WorkspaceSquare name={w} /><span className="truncate">{w}</span></span>
      <DraftValue
        kind={draft.kind} values={values} raw={raws[w] ?? ''} label={suffix === undefined ? w : `${w} · ${suffix}`} emptyLabel={emptyOf(w)}
        onChange={(raw) => onChange(w, raw)}
      />
    </div>
  ));
}

/** #621, decision 2: each workspace's own value, which every skill declaring the name reads; empty falls back to the default. */
export function SharedSection({ draft, workspaces, update }: SectionProps) {
  const title = t('plugins.variables.form.perWorkspace');
  return (
    <fieldset aria-label={title} className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
      <span className="text-muted-foreground"><TitleWithTip title={title} note={t('plugins.variables.form.workspaceHint', { name: draft.name.trim() })} /></span>
      <WorkspaceLines
        draft={draft} workspaces={workspaces} raws={draft.shared} emptyOf={() => defaultShown(draft)}
        onChange={(w, raw) => update({ shared: { ...draft.shared, [w]: raw } })}
      />
    </fieldset>
  );
}

/** "+ only in this template": shown while the template has no override; it opens the section below in its place. */
export function AddOverride({ onAdd }: { onAdd(): void }) {
  return <Button type="button" variant="link" size="xs" className={`self-start ${LINK}`} onClick={onAdd}>{t('plugins.variables.form.addOverride')}</Button>;
}

/** #621, decision 2: the template's own workspaces: entries, which fork a version; empty falls back to the workspace value, else the default.
 * "remover" empties every entry and closes the section; nothing is written until save. Opened by the link, the focus moves into it. */
export function OverrideSection({ draft, workspaces, update, canRemove, shouldFocus }: OverrideProps) {
  const lines = useRef<HTMLDivElement>(null);
  // Mount only: the link that opened the section is gone, so the focus would otherwise fall to the body
  // biome-ignore lint/correctness/useExhaustiveDependencies: shouldFocus is read once, when the section opens
  useEffect(() => {
    if (shouldFocus) lines.current?.querySelector<HTMLElement>('input, button')?.focus();
  }, []);
  const title = t('plugins.variables.form.overrides');
  return (
    <fieldset aria-label={title} className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
      <span className="flex items-center justify-between text-muted-foreground">
        <TitleWithTip title={title} note={t('plugins.variables.form.overrideHint')} />
        {canRemove && <Button type="button" variant="link" size="xs" className={LINK} onClick={() => update({ overrides: {}, hasOverrides: false })}>{t('plugins.variables.form.removeOverrides')}</Button>}
      </span>
      <div ref={lines} className="flex min-w-0 flex-col gap-1">
        <WorkspaceLines
          draft={draft} workspaces={workspaces} raws={draft.overrides} suffix={title} emptyOf={(w) => effectiveShown(draft, w)}
          onChange={(w, raw) => update({ overrides: { ...draft.overrides, [w]: raw }, hasOverrides: true })}
        />
      </div>
    </fieldset>
  );
}
