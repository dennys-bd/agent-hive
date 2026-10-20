import { useMemo } from 'react';
import { deliveredName, parseTemplate } from '../../../template';
import type { LintAnnotation } from '../../../template-lint';
import { type Origin, VariableList } from '@/components/plugins/VariableList';
import { type Annotations, type EditorAnnotation, isAgent } from '@/hooks/use-annotations';
import type { ItemEditor } from '@/hooks/use-item-editor';
import { t } from '@/i18n';
import { isMarkdown } from '@/lib/template-view';

interface PaneProps { editor: ItemEditor; annotations: Annotations; workspaces: readonly string[] }
interface BodyProps extends PaneProps { path: string }

// #327: a row's lines are the editor's annotations on its variable, the pane's two checks only; a parse annotation never lands on a row,
// nor an agent's (#329), which names no variable
const ROW_CHECKS: readonly LintAnnotation['check'][] = ['required', 'unused'];
const findingsOf = (list: readonly EditorAnnotation[], name: string): LintAnnotation[] =>
  list.filter((a): a is LintAnnotation => !isAgent(a) && ROW_CHECKS.includes(a.check) && a.variable === name);

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

// The open file's buffer and the item editor's write (decision 5): a value lands in the buffer, saved at once when it was clean
function PaneBody({ editor, annotations, workspaces, path }: BodyProps) {
  const originOf = useOriginOf(editor, path);
  return (
    <VariableList
      text={editor.textOf(path)} workspaces={workspaces} onApply={editor.applyEdit} originOf={originOf}
      findings={(name) => findingsOf(annotations.list, name)} onFinding={annotations.openAt}
    />
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
