import { type KeyboardEvent, useMemo, useState } from 'react';
import { deliveredName, parseTemplate, type TemplateVariable, type VariableValue } from '../../../template';
import { type EditResult, removeVariable, setVariableValue } from '../../../template-edit';
import { type LintAnnotation, variableUses } from '../../../template-lint';
import { Confirm } from '@/components/Confirm';
import { ChoiceSelect, rawOf, valueOfRaw } from '@/components/plugins/ChoiceSelect';
import { VariableForm } from '@/components/plugins/VariableForm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';
import type { Annotations } from '@/hooks/use-annotations';
import type { ItemEditor } from '@/hooks/use-item-editor';
import { type MessageKey, t } from '@/i18n';
import { isMarkdown } from '@/lib/template-view';

type Origin = 'hive' | 'yours';
interface PaneProps { editor: ItemEditor; annotations: Annotations; workspaces: readonly string[] }
interface BodyProps extends PaneProps { path: string }
interface Removal { name: string; lines: number[] }
interface ValueProps { variable: TemplateVariable; workspace: string; onWrite(value: VariableValue | undefined): void }
interface RowProps {
  variable: TemplateVariable; workspaces: readonly string[]; origin?: Origin; findings: readonly LintAnnotation[];
  onWrite(workspace: string, value: VariableValue | undefined): void; onEdit(): void; onRemove(): void; onFinding(finding: LintAnnotation): void;
}

const ORIGIN: Record<Origin, MessageKey> = { hive: 'plugins.variables.fromHive', yours: 'plugins.variables.yours' };
// #327: a row's lines are the editor's annotations on its variable, the pane's two checks only; a parse annotation never lands on a row
const ROW_CHECKS: readonly LintAnnotation['check'][] = ['required', 'unused'];
const findingsOf = (list: readonly LintAnnotation[], name: string): LintAnnotation[] =>
  list.filter((a) => ROW_CHECKS.includes(a.check) && a.variable === name);

const entryOf = (variable: TemplateVariable, workspace: string): VariableValue | undefined =>
  Object.hasOwn(variable.workspaces, workspace) ? variable.workspaces[workspace] : undefined;

// Decision 12: the workspace's entry, else the default muted; null grey; a required variable with no value is "missing" in red
function shownValue(variable: TemplateVariable, workspace: string): { text: string; tone: string } {
  const entry = entryOf(variable, workspace);
  const value = entry === undefined ? variable.default : entry;
  if (value === null) return variable.required ? { text: t('plugins.variables.missing'), tone: 'text-destructive' } : { text: 'null', tone: 'text-muted-foreground' };
  const text = typeof value === 'boolean' ? t(value ? 'plugins.variables.yes' : 'plugins.variables.no') : value;
  return { text, tone: entry === undefined ? 'text-muted-foreground' : 'text-foreground' };
}

// Decision 13: a list or yes/no is a select whose "default" removes the entry; a text is a button that turns into an input (Enter writes,
// Esc cancels, empty removes the entry)
function ValueControl({ variable, workspace, onWrite }: ValueProps) {
  const [isEditing, setEditing] = useState(false);
  const shown = shownValue(variable, workspace);
  const label = `${variable.name} · ${workspace}`;
  const raw = rawOf(entryOf(variable, workspace));
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

// Decision 6 (#321), #327: the annotation's line on the declaration, red naming the workspaces with no value, yellow for a variable the body
// never uses; a click opens its card in the text
function FindingLine({ finding, onOpen }: { finding: LintAnnotation; onOpen(): void }) {
  const isRequired = finding.check === 'required';
  const text = isRequired ? t('plugins.variables.lint.required', { workspaces: (finding.workspaces ?? []).join(', ') }) : t('plugins.variables.lint.unused');
  return <button type="button" onClick={onOpen} className={`text-left hover:underline ${isRequired ? 'text-destructive' : 'text-waiting'}`}>{text}</button>;
}

// One variable (handoff 11b): its name and origin, a value per configured workspace in config order, the entries of names no workspace has
// dimmed and read-only (decision 11), the lint's line. Every declaration can be edited; only a "yours" variable can go (decisions 7, 8)
function VariableRow({ variable, workspaces, origin, findings, onWrite, onEdit, onRemove, onFinding }: RowProps) {
  const unknown = Object.keys(variable.workspaces).filter((w) => !workspaces.includes(w));
  return (
    <li aria-label={variable.name} className="flex flex-col gap-1 rounded-md border px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-mono font-semibold">{variable.name}</span>
        {origin && <span className="text-[10px] text-muted-foreground">{t(ORIGIN[origin])}</span>}
        <Button type="button" size="xs" variant="ghost" onClick={onEdit}>{t('plugins.variables.edit')}</Button>
        {origin === 'yours' && <Button type="button" size="xs" variant="ghost" onClick={onRemove}>{t('plugins.variables.remove')}</Button>}
      </div>
      {workspaces.map((w) => (
        <div key={w} className="flex min-w-0 items-center gap-1.5">
          <WorkspaceSquare name={w} title={w} />
          <ValueControl variable={variable} workspace={w} onWrite={(value) => onWrite(w, value)} />
        </div>
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

// Decision 10: "from hive" when the Hive's original of this file declares the name; every variable of a user-created item is "yours", every
// one of the open original "from hive"; undefined while the original is read (or failed to be)
function useOriginOf(editor: ItemEditor, path: string): (name: string) => Origin | undefined {
  const { item, read, original } = editor;
  const shipped = useMemo(() => {
    const file = original?.files.find((f) => deliveredName(f.path) === deliveredName(path));
    return new Set(file === undefined ? [] : parseTemplate(file.text).variables.map((v) => v.name));
  }, [original, path]);
  return (name) => {
    if (item?.userCreated === true) return 'yours';
    if (read?.version === null) return 'hive';
    if (original === undefined) return undefined;
    return shipped.has(name) ? 'hive' : 'yours';
  };
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

// The buffer's parse is memoised on its text: the pane re-renders on every keystroke of the open file (decision 23). A header that
// does not parse replaces the list with its line and hides the form (decision 22); the form opens at the top of the list (decision 14)
function PaneBody({ editor, annotations, workspaces, path }: BodyProps) {
  const text = editor.textOf(path);
  const parsed = useMemo(() => parseTemplate(text), [text]);
  const originOf = useOriginOf(editor, path);
  const [error, setError] = useState<MessageKey>();
  const [removal, setRemoval] = useState<Removal>();
  const [form, setForm] = useState<{ name?: string }>(); // {} declares a variable, { name } edits that one
  const [headerError] = parsed.errors;
  const editing = parsed.variables.find((v) => v.name === form?.name);
  const isFormShown = form !== undefined && headerError === undefined && (form.name === undefined || editing !== undefined);
  const write = (result: EditResult): void => setError(editor.applyEdit(result));
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
        <VariableForm key={form.name ?? ''} text={text} workspaces={workspaces} variable={editing} onApply={editor.applyEdit} onClose={() => setForm(undefined)} />
      )}
      {!headerError && (
        <ul aria-label={t('files.tab.variables')} className="flex flex-col gap-1">
          {parsed.variables.map((variable) => (
            <VariableRow
              key={variable.name} variable={variable} workspaces={workspaces} origin={originOf(variable.name)}
              findings={findingsOf(annotations.list, variable.name)} onFinding={annotations.openAt}
              onEdit={() => setForm({ name: variable.name })} onRemove={() => remove(variable.name)}
              onWrite={(workspace, value) => write(setVariableValue(text, variable.name, workspace, value))}
            />
          ))}
        </ul>
      )}
      {removal && <RemoveDialog removal={removal} onConfirm={() => write(removeVariable(text, removal.name))} onClose={() => setRemoval(undefined)} />}
    </div>
  );
}

/** The right pane's variables under "view as" (#321, handoff 11b): the open markdown file's declared variables, a value per workspace each,
 * editable in place. Keyed by item and file, so a switch starts with no open control or dialog. */
export function VariablesPane({ editor, annotations, workspaces }: PaneProps) {
  const { item, path } = editor;
  if (item === undefined || editor.read === undefined || path === undefined) return null;
  if (!isMarkdown(path)) return <p className="p-3 text-muted-foreground text-xs">{t('plugins.variables.none')}</p>;
  return <PaneBody key={`${item.id}\0${path}`} editor={editor} annotations={annotations} workspaces={workspaces} path={path} />;
}
