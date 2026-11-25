import { PencilIcon, Trash2Icon } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { parseTemplate, type RenderWorkspace, type TemplateVariable, type ValueSource, valueFor, valueSource, type VariableValue, workspaceValueProblem } from '../../../template';
import { type EditResult, removeVariable } from '../../../template-edit';
import { type LintAnnotation, variableUses } from '../../../template-lint';
import { Confirm } from '@/components/Confirm';
import { VariableForm } from '@/components/plugins/VariableForm';
import { Button } from '@/components/ui/button';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';
import type { WriteResult } from '@/hooks/use-item-editor';
import { type MessageKey, t } from '@/i18n';
import { renderFor, type WorkspaceRenders } from '@/lib/workspace-values';

export type Origin = 'hive' | 'yours';
export interface VariableListProps {
  text: string; workspaces: readonly string[];
  onApply(result: WriteResult): MessageKey | undefined; // the item editor's applyEdit, or a protocol passage's draft (#337)
  originOf?(name: string): Origin | undefined; // omitted: no origin line
  findings?(name: string): readonly LintAnnotation[]; onFinding?(finding: LintAnnotation): void; // omitted: no lint lines
  viewAs?: string; // a workspace's preview: the other workspaces' values are dimmed
  values?: WorkspaceRenders; // #621, #742: each workspace's values and built-ins; omitted (a passage), a line reads only the text's own entries
  footer?: ReactNode; // #742: last in the scroll column, the pane's built-ins; a protocol passage passes none
  onWorkspaceValue?(workspace: string, name: string, value: VariableValue | undefined): Promise<MessageKey | undefined>; // #621: omitted, every write is the text's own entry
}
interface Removal { name: string; lines: number[] }
interface Shown { text: string; tone: string; isWrong: boolean }
interface RowProps {
  variable: TemplateVariable; workspaces: readonly string[]; values: WorkspaceRenders; hasSource: boolean; origin?: Origin; findings: readonly LintAnnotation[]; viewAs?: string;
  onEdit(): void; onRemove(): void; onFinding(finding: LintAnnotation): void;
}

const ORIGIN: Record<Origin, MessageKey> = { hive: 'plugins.variables.fromHive', yours: 'plugins.variables.yours' };
// #621, decision 1: where a workspace's value comes from
const SOURCE: Record<ValueSource, MessageKey> = { override: 'plugins.variables.source.override', workspace: 'plugins.variables.source.workspace', default: 'plugins.variables.default' };
const NO_FINDINGS: readonly LintAnnotation[] = [];
const NO_VALUES: WorkspaceRenders = { variables: {}, builtIns: {} };
const ICON_BUTTON = 'size-5 text-faint hover:text-foreground';
const MISSING = '—';
const MUTED = 'text-muted-foreground';
const WRONG = 'text-destructive';

const textOf = (value: Exclude<VariableValue, null>): string => (typeof value === 'boolean' ? t(value ? 'plugins.variables.yes' : 'plugins.variables.no') : value);

// Decision 12, #621 decision 1: the value the template renders for the workspace. The default and null are muted; a required variable with no
// value is a red dash, and a workspace value this template cannot take is red too (decision 3)
function shownValue(variable: TemplateVariable, target: RenderWorkspace): Shown {
  const value = valueFor(variable, target);
  if (workspaceValueProblem(variable, target) !== undefined) return { text: value === null ? 'null' : textOf(value), tone: WRONG, isWrong: true };
  if (value === null) return variable.required ? { text: MISSING, tone: WRONG, isWrong: true } : { text: 'null', tone: MUTED, isWrong: false };
  return { text: textOf(value), tone: valueSource(variable, target) === 'default' ? MUTED : 'text-foreground', isWrong: false };
}

// What a declaration accepts, for the lint line of a workspace value it cannot take (decision 3)
function acceptedOf(variable: TemplateVariable): string {
  if (variable.kind === 'boolean') return [t('plugins.variables.yes'), t('plugins.variables.no')].join(', ');
  return variable.kind === 'list' ? (variable.values ?? []).join(', ') : t('plugins.variables.form.text');
}

// Decision 6 (#321), #327, #621: the annotation's line on the declaration, red naming the workspaces with no value or with one this template
// cannot take, yellow for a variable the body never uses; a click opens its card in the text
function FindingLine({ variable, finding, onOpen }: { variable: TemplateVariable; finding: LintAnnotation; onOpen(): void }) {
  const workspaces = (finding.workspaces ?? []).join(', ');
  const isUnused = finding.check === 'unused';
  const text = isUnused ? t('plugins.variables.lint.unused')
    : finding.check === 'value' ? t('plugins.variables.lint.value', { values: acceptedOf(variable), workspaces }) : t('plugins.variables.lint.required', { workspaces });
  return <button type="button" onClick={onOpen} className={`text-left hover:underline ${isUnused ? 'text-waiting' : WRONG}`}>{text}</button>;
}

// #492: one dot on the name line for the row's worst finding, red over yellow; an empty cell keeps the grid's column
function FindingDot({ findings }: { findings: readonly LintAnnotation[] }) {
  if (findings.length === 0) return <span />;
  const tone = findings.some((f) => f.check !== 'unused') ? 'bg-destructive' : 'bg-waiting';
  return <span aria-hidden="true" className={`size-1.5 rounded-full ${tone}`} />;
}

// #621, decision 1: one workspace's read-only line, square · value · where it comes from; the pencil is the only way to change it. A missing
// value names no source, having no default to name
function WorkspaceLine({ variable, target, isDimmed, hasSource }: { variable: TemplateVariable; target: RenderWorkspace; isDimmed: boolean; hasSource: boolean }) {
  const shown = shownValue(variable, target);
  const isMissing = shown.text === MISSING;
  return (
    <div className={`grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-1.5 text-xs ${isDimmed ? 'opacity-40' : ''}`}>
      <WorkspaceSquare name={target.name} title={target.name} />
      <span title={`${variable.name} · ${target.name}`} className={`truncate font-mono ${shown.tone}`}>{shown.text}</span>
      {hasSource && !isMissing && <span className={MUTED}>{t(SOURCE[valueSource(variable, target)])}</span>}
    </div>
  );
}

// The name line (#492's grid): name, origin, the finding's dot, then the icon actions. Every declaration can be edited; only a "yours"
// variable can go (decisions 7, 8)
function RowHead({ variable, origin, findings, onEdit, onRemove }: Pick<RowProps, 'variable' | 'origin' | 'findings' | 'onEdit' | 'onRemove'>) {
  const { name } = variable;
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-1.5">
      <span className="truncate font-mono font-semibold">{name}</span>
      <span className={`min-w-0 ${MUTED}`}>{origin && t(ORIGIN[origin])}</span>
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
// (decision 11), the lint's line. A missing required value or a workspace value it cannot take tints the row's border (#492, #621)
function VariableRow({ variable, workspaces, values, hasSource, origin, findings, viewAs, onEdit, onRemove, onFinding }: RowProps) {
  const targets = workspaces.map((w) => renderFor(values, w));
  const unknown = Object.keys(variable.workspaces).filter((w) => !workspaces.includes(w));
  const isWrong = targets.some((target) => shownValue(variable, target).isWrong);
  return (
    <li aria-label={variable.name} className={`flex flex-col gap-1 rounded-md border px-2 py-1.5 ${isWrong ? 'border-destructive/30' : ''}`}>
      <RowHead variable={variable} origin={origin} findings={findings} onEdit={onEdit} onRemove={onRemove} />
      {targets.map((target) => (
        <WorkspaceLine key={target.name} variable={variable} target={target} isDimmed={viewAs !== undefined && viewAs !== target.name} hasSource={hasSource} />
      ))}
      {unknown.map((w) => (
        <div key={w} title={t('plugins.variables.unknownWorkspace')} className="flex min-w-0 items-center gap-1.5 opacity-50">
          <WorkspaceSquare name={w} /><span className="truncate font-mono">{`${w} · ${String(variable.workspaces[w])}`}</span>
        </div>
      ))}
      {findings.map((finding) => <FindingLine key={finding.check} variable={variable} finding={finding} onOpen={() => onFinding(finding)} />)}
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
    <div className={`flex items-center justify-between ${MUTED}`}>
      <span>{t('files.tab.variables')}</span>
      <Button type="button" size="xs" variant="ghost" disabled={isDisabled} onClick={onAdd}>{t('plugins.variables.add')}</Button>
    </div>
  );
}

/** A text's declared variables (#321), a read-only line per workspace each; the form writes, through onApply (#337: the item editor's buffer,
 * or a protocol passage's draft) and the workspace route (#621). The parse is memoised on the text: the list re-renders on every keystroke
 * (decision 23). A header that does not parse replaces the list with its line and hides the form (decision 22). "+ variable" opens the form
 * at the top; the pencil opens it in its card's place, so a card and its form never show together. */
export function VariableList({ text, workspaces, onApply, originOf, findings, onFinding, viewAs, values = NO_VALUES, onWorkspaceValue, footer }: VariableListProps) {
  const parsed = useMemo(() => parseTemplate(text), [text]);
  const [error, setError] = useState<MessageKey>();
  const [removal, setRemoval] = useState<Removal>();
  const [form, setForm] = useState<{ name?: string }>(); // {} declares a variable, { name } edits that one
  const [headerError] = parsed.errors;
  const write = (result: EditResult): void => setError(onApply(result));
  const remove = (name: string): void => {
    const lines = variableUses(parsed, name);
    if (lines.length === 0) write(removeVariable(text, name));
    else setRemoval({ name, lines });
  };
  const formOf = (variable?: TemplateVariable) => (
    <VariableForm
      key={variable?.name ?? ''} text={text} workspaces={workspaces} variable={variable} values={values.variables}
      onApply={onApply} onWorkspaceValue={onWorkspaceValue} onClose={() => setForm(undefined)}
    />
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3 text-xs">
      <PaneHead isDisabled={headerError !== undefined} onAdd={() => setForm({})} />
      {headerError && <p className="text-destructive">{t('plugins.variables.headerError', { line: headerError.line })}</p>}
      {error && <p role="alert" className="text-destructive">{t(error)}</p>}
      {!headerError && form !== undefined && form.name === undefined && formOf()}
      {!headerError && (
        <ul aria-label={t('files.tab.variables')} className="flex flex-col gap-1">
          {parsed.variables.map((variable) => (variable.name === form?.name ? <li key={variable.name}>{formOf(variable)}</li> : (
            <VariableRow
              key={variable.name} variable={variable} workspaces={workspaces} values={values} hasSource={onWorkspaceValue !== undefined}
              origin={originOf?.(variable.name)} viewAs={viewAs}
              findings={findings?.(variable.name) ?? NO_FINDINGS} onFinding={(finding) => onFinding?.(finding)}
              onEdit={() => setForm({ name: variable.name })} onRemove={() => remove(variable.name)}
            />
          )))}
        </ul>
      )}
      {footer}
      {removal && <RemoveDialog removal={removal} onConfirm={() => write(removeVariable(text, removal.name))} onClose={() => setRemoval(undefined)} />}
    </div>
  );
}
