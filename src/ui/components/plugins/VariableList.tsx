import { PencilIcon, Trash2Icon } from 'lucide-react';
import { type KeyboardEvent, useMemo, useState } from 'react';
import { parseTemplate, type RenderWorkspace, type TemplateVariable, type ValueSource, valueFor, valueSource, type VariableValue } from '../../../template';
import { type EditResult, removeVariable, setVariableValue } from '../../../template-edit';
import { type LintAnnotation, variableUses } from '../../../template-lint';
import type { WorkspaceVariables } from '../../../types';
import { Confirm } from '@/components/Confirm';
import { ChoiceSelect, rawOf, valueOfRaw } from '@/components/plugins/ChoiceSelect';
import { VariableForm } from '@/components/plugins/VariableForm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';
import type { WriteResult } from '@/hooks/use-item-editor';
import { type MessageKey, t } from '@/i18n';
import { renderFor } from '@/lib/workspace-values';

export type Origin = 'hive' | 'yours';
export interface VariableListProps {
  text: string; workspaces: readonly string[];
  onApply(result: WriteResult): MessageKey | undefined; // the item editor's applyEdit, or a protocol passage's draft (#337)
  originOf?(name: string): Origin | undefined; // omitted: no origin line
  findings?(name: string): readonly LintAnnotation[]; onFinding?(finding: LintAnnotation): void; // omitted: no lint lines
  viewAs?: string; // a workspace's preview: the other workspaces' values are dimmed
  values?: WorkspaceVariables; // #621: each workspace's values; omitted (a passage), a line reads only the text's own entries
  onWorkspaceValue?(workspace: string, name: string, value: VariableValue | undefined): Promise<MessageKey | undefined>; // #621: omitted, every write is the text's own entry
}
interface Removal { name: string; lines: number[] }
interface ValueProps { variable: TemplateVariable; target: RenderWorkspace; own: VariableValue | undefined; onWrite(value: VariableValue | undefined): void }
interface RowProps {
  variable: TemplateVariable; workspaces: readonly string[]; values: WorkspaceVariables; canShare: boolean; origin?: Origin; findings: readonly LintAnnotation[]; viewAs?: string;
  onWrite(workspace: string, value: VariableValue | undefined): void; onShare(workspace: string, value: VariableValue | undefined): void;
  onEdit(): void; onRemove(): void; onFinding(finding: LintAnnotation): void;
}
interface WorkspaceRowProps {
  variable: TemplateVariable; target: RenderWorkspace; isDimmed: boolean; canShare: boolean;
  onOverride(value: VariableValue | undefined): void; onShare(value: VariableValue | undefined): void;
}

const ORIGIN: Record<Origin, MessageKey> = { hive: 'plugins.variables.fromHive', yours: 'plugins.variables.yours' };
// #621: where a workspace's value comes from; a task's variable has its own line (fromTask)
const SOURCE: Record<Exclude<ValueSource, 'task'>, MessageKey> = { override: 'plugins.variables.source.override', workspace: 'plugins.variables.source.workspace', default: 'plugins.variables.default' };
const NO_FINDINGS: readonly LintAnnotation[] = [];
const NO_VALUES: WorkspaceVariables = {};
const ICON_BUTTON = 'size-5 text-faint hover:text-foreground';
const MISSING = '—';

const entryOf = (variable: TemplateVariable, workspace: string): VariableValue | undefined =>
  Object.hasOwn(variable.workspaces, workspace) ? variable.workspaces[workspace] : undefined;
const sharedOf = (target: RenderWorkspace, name: string): VariableValue | undefined =>
  Object.hasOwn(target.variables, name) ? target.variables[name] : undefined;

// Decision 12, #621: the value the template renders for the workspace, muted when it is the default; null grey; a required variable with no
// value is a red dash (#492)
function shownValue(variable: TemplateVariable, target: RenderWorkspace): { text: string; tone: string } {
  const value = valueFor(variable, target);
  if (value === null) return variable.required ? { text: MISSING, tone: 'text-destructive' } : { text: 'null', tone: 'text-muted-foreground' };
  const text = typeof value === 'boolean' ? t(value ? 'plugins.variables.yes' : 'plugins.variables.no') : value;
  return { text, tone: valueSource(variable, target) === 'default' ? 'text-muted-foreground' : 'text-foreground' };
}

// Decision 13: a list or yes/no is a select whose "default" removes the entry; a text is a button that turns into an input (Enter writes,
// Esc cancels, empty removes the entry)
function ValueControl({ variable, target, own, onWrite }: ValueProps) {
  const [isEditing, setEditing] = useState(false);
  // #492: the task's value exists only when the skill runs, so there is nothing to write here
  if (variable.from === 'task') return <span className="truncate font-mono text-muted-foreground">{t('plugins.variables.fromTask')}</span>;
  const shown = shownValue(variable, target);
  const label = `${variable.name} · ${target.name}`;
  const raw = rawOf(own);
  if (variable.kind !== 'text') {
    return (
      <ChoiceSelect
        kind={variable.kind} values={variable.values ?? []} raw={raw} label={label} emptyLabel={t('plugins.variables.default')}
        shown={shown.text} className={shown.tone} onChange={(next) => onWrite(valueOfRaw(variable.kind, next))}
      />
    );
  }
  if (!isEditing) {
    return <button type="button" aria-label={label} onClick={() => setEditing(true)} className={`min-w-0 truncate text-left font-mono hover:underline ${shown.tone}`}>{shown.text}</button>;
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    const { value } = event.currentTarget;
    event.currentTarget.blur(); // the blur closes the input; unmounting it while focused leaves the focus nowhere
    if (event.key === 'Enter') onWrite(valueOfRaw('text', value));
  };
  return <Input ref={(input) => input?.focus()} aria-label={label} defaultValue={raw} onKeyDown={onKeyDown} onBlur={() => setEditing(false)} className="h-6 px-1.5 font-mono text-xs" />;
}

// Decision 6 (#321), #327, #621: the annotation's line on the declaration, red naming the workspaces with no value or with one this template
// cannot take, yellow for a variable the body never uses; a click opens its card in the text
function FindingLine({ finding, onOpen }: { finding: LintAnnotation; onOpen(): void }) {
  const workspaces = (finding.workspaces ?? []).join(', ');
  const isUnused = finding.check === 'unused';
  const text = isUnused ? t('plugins.variables.lint.unused') : t(finding.check === 'value' ? 'plugins.variables.lint.value' : 'plugins.variables.lint.required', { workspaces });
  return <button type="button" onClick={onOpen} className={`text-left hover:underline ${isUnused ? 'text-waiting' : 'text-destructive'}`}>{text}</button>;
}

// #492: one dot on the name line for the row's worst finding, red over yellow; an empty cell keeps the grid's column
function FindingDot({ findings }: { findings: readonly LintAnnotation[] }) {
  if (findings.length === 0) return <span />;
  const tone = findings.some((f) => f.check !== 'unused') ? 'bg-destructive' : 'bg-waiting';
  return <span aria-hidden="true" className={`size-1.5 rounded-full ${tone}`} />;
}

// #621, decision 4: one workspace's line. A write lands on the workspace's value, unless the template has its own entry for it or "only this
// template" is chosen: then it is the template's override, a version as before. An override can be removed, falling back to the workspace's value
function WorkspaceRow({ variable, target, isDimmed, canShare, onOverride, onShare }: WorkspaceRowProps) {
  const [isOnlyHere, setOnlyHere] = useState(false);
  const source = valueSource(variable, target);
  const isOverride = !canShare || source === 'override' || isOnlyHere;
  const own = isOverride ? entryOf(variable, target.name) : sharedOf(target, variable.name);
  return (
    <div className={`flex min-w-0 items-center gap-1.5 ${isDimmed ? 'opacity-40' : ''}`}>
      <WorkspaceSquare name={target.name} title={target.name} />
      <ValueControl variable={variable} target={target} own={own} onWrite={isOverride ? onOverride : onShare} />
      {canShare && source !== 'task' && <span className="shrink-0 text-muted-foreground">{t(SOURCE[source])}</span>}
      {canShare && source === 'override' && (
        <Button type="button" size="xs" variant="ghost" aria-label={`${t('plugins.variables.removeOverride')} · ${target.name}`} onClick={() => onOverride(undefined)}>{t('plugins.variables.removeOverride')}</Button>
      )}
      {canShare && source !== 'override' && source !== 'task' && (
        <label className="flex shrink-0 items-center gap-1 text-muted-foreground">
          <input type="checkbox" checked={isOnlyHere} aria-label={`${t('plugins.variables.onlyThisTemplate')} · ${target.name}`} onChange={(event) => setOnlyHere(event.currentTarget.checked)} />
          {t('plugins.variables.onlyThisTemplate')}
        </label>
      )}
    </div>
  );
}

// The name line (#492's grid): name, origin, the finding's dot, then the icon actions. Every declaration can be edited; only a "yours"
// variable can go (decisions 7, 8)
function RowHead({ variable, origin, findings, onEdit, onRemove }: Pick<RowProps, 'variable' | 'origin' | 'findings' | 'onEdit' | 'onRemove'>) {
  const { name } = variable;
  const originText = variable.from === 'task' ? t('plugins.variables.fromTask') : origin && t(ORIGIN[origin]);
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-1.5">
      <span className="truncate font-mono font-semibold">{name}</span>
      <span className="min-w-0 text-muted-foreground">{originText}</span>
      <FindingDot findings={findings} />
      <span className="flex">
        <Button type="button" size="icon-xs" variant="ghost" aria-label={t('plugins.variables.form.editTitle', { name })} title={t('plugins.variables.edit')} onClick={onEdit} className={ICON_BUTTON}><PencilIcon /></Button>
        {origin === 'yours' && (
          <Button type="button" size="icon-xs" variant="ghost" aria-label={t('plugins.variables.removeNamed', { name })} title={t('plugins.variables.remove')} onClick={onRemove} className={ICON_BUTTON}><Trash2Icon /></Button>
        )}
      </span>
    </div>
  );
}

// One variable (handoff 11b): its name line, a line per configured workspace in config order, the entries of names no workspace has dimmed
// and read-only (decision 11), the lint's line. A required one with no value somewhere tints the row's border (#492)
function VariableRow({ variable, workspaces, values, canShare, origin, findings, viewAs, onWrite, onShare, onEdit, onRemove, onFinding }: RowProps) {
  const targets = workspaces.map((w) => renderFor(values, w));
  const unknown = Object.keys(variable.workspaces).filter((w) => !workspaces.includes(w));
  const isMissing = variable.required && targets.some((target) => shownValue(variable, target).text === MISSING);
  return (
    <li aria-label={variable.name} className={`flex flex-col gap-1 rounded-md border px-2 py-1.5 ${isMissing ? 'border-destructive/30' : ''}`}>
      <RowHead variable={variable} origin={origin} findings={findings} onEdit={onEdit} onRemove={onRemove} />
      {targets.map((target) => (
        <WorkspaceRow
          key={target.name} variable={variable} target={target} isDimmed={viewAs !== undefined && viewAs !== target.name} canShare={canShare}
          onOverride={(value) => onWrite(target.name, value)} onShare={(value) => onShare(target.name, value)}
        />
      ))}
      {unknown.map((w) => (
        <div key={w} title={t('plugins.variables.unknownWorkspace')} className="flex min-w-0 items-center gap-1.5 opacity-50">
          <WorkspaceSquare name={w} /><span className="truncate font-mono">{`${w} · ${String(variable.workspaces[w])}`}</span>
        </div>
      ))}
      {findings.map((finding) => <FindingLine key={finding.check} finding={finding} onOpen={() => onFinding(finding)} />)}
    </li>
  );
}

// Decision 9: names the lines that still use the variable; the render fails until they go
function RemoveDialog({ removal, onConfirm, onClose }: { removal: Removal; onConfirm(): void; onClose(): void }) {
  const { name, lines } = removal;
  return (
    <Confirm
      open title={t('plugins.variables.removeTitle', { name })} message={t('plugins.variables.removeMessage', { name, lines: lines.join(', ') })}
      confirmLabel={t('plugins.variables.removeConfirm')} onConfirm={onConfirm} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}
    />
  );
}

// "+ variable" heads the list; a header that does not parse disables it (decision 22)
function PaneHead({ isDisabled, onAdd }: { isDisabled: boolean; onAdd(): void }) {
  return (
    <div className="flex items-center justify-between text-muted-foreground">
      <span>{t('files.tab.variables')}</span>
      <Button type="button" size="xs" variant="ghost" disabled={isDisabled} onClick={onAdd}>{t('plugins.variables.add')}</Button>
    </div>
  );
}

/** A text's declared variables (#321), a value per workspace each, editable in place; every write goes through onApply (#337: the item
 * editor's buffer, or a protocol passage's draft). The parse is memoised on the text: the list re-renders on every keystroke (decision 23).
 * A header that does not parse replaces the list with its line and hides the form (decision 22); the form opens at the top (decision 14). */
export function VariableList({ text, workspaces, onApply, originOf, findings, onFinding, viewAs, values = NO_VALUES, onWorkspaceValue }: VariableListProps) {
  const parsed = useMemo(() => parseTemplate(text), [text]);
  const [error, setError] = useState<MessageKey>();
  const [removal, setRemoval] = useState<Removal>();
  const [form, setForm] = useState<{ name?: string }>(); // {} declares a variable, { name } edits that one
  const [headerError] = parsed.errors;
  const editing = parsed.variables.find((v) => v.name === form?.name);
  const isFormShown = form !== undefined && headerError === undefined && (form.name === undefined || editing !== undefined);
  const write = (result: EditResult): void => setError(onApply(result));
  // #621: a workspace's value goes to the server, never into the text; its refusal is the pane's error
  const share = (workspace: string, name: string, value: VariableValue | undefined): void => {
    if (onWorkspaceValue === undefined) return;
    void onWorkspaceValue(workspace, name, value).then(setError);
  };
  const remove = (name: string): void => {
    const lines = variableUses(parsed, name);
    if (lines.length === 0) write(removeVariable(text, name));
    else setRemoval({ name, lines });
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3 text-xs">
      <PaneHead isDisabled={headerError !== undefined} onAdd={() => setForm({})} />
      {headerError && <p className="text-destructive">{t('plugins.variables.headerError', { line: headerError.line })}</p>}
      {error && <p role="alert" className="text-destructive">{t(error)}</p>}
      {isFormShown && form && (
        <VariableForm key={form.name ?? ''} text={text} workspaces={workspaces} variable={editing} onApply={onApply} onClose={() => setForm(undefined)} />
      )}
      {!headerError && (
        <ul aria-label={t('files.tab.variables')} className="flex flex-col gap-1">
          {parsed.variables.map((variable) => (
            <VariableRow
              key={variable.name} variable={variable} workspaces={workspaces} values={values} canShare={onWorkspaceValue !== undefined}
              origin={originOf?.(variable.name)} viewAs={viewAs}
              findings={findings?.(variable.name) ?? NO_FINDINGS} onFinding={(finding) => onFinding?.(finding)}
              onEdit={() => setForm({ name: variable.name })} onRemove={() => remove(variable.name)}
              onWrite={(workspace, value) => write(setVariableValue(text, variable.name, workspace, value))}
              onShare={(workspace, value) => share(workspace, variable.name, value)}
            />
          ))}
        </ul>
      )}
      {removal && <RemoveDialog removal={removal} onConfirm={() => write(removeVariable(text, removal.name))} onClose={() => setRemoval(undefined)} />}
    </div>
  );
}
