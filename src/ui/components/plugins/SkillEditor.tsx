import { useEffect, useMemo, useRef, useState } from 'react';
import { type ParsedTemplate, parseTemplate } from '../../../template';
import type { ChainSpec } from '../../../template-condition';
import type { EditResult } from '../../../template-edit';
import { buildMap, type TemplateMap } from '../../../template-map';
import { chainsOf, previewTemplate } from '../../../template-preview';
import type { CatalogueItem, ItemRead } from '../../../types';
import { BlockMap, type MapGap } from '@/components/plugins/BlockMap';
import { ChainCard } from '@/components/plugins/ChainCard';
import { ConditionPopover } from '@/components/plugins/ConditionPopover';
import { FileTabs } from '@/components/plugins/FileTabs';
import { type ChipPopover, type Reveal, TemplateText } from '@/components/plugins/TemplateText';
import type { Annotations } from '@/hooks/use-annotations';
import type { ItemEditor } from '@/hooks/use-item-editor';
import { t } from '@/i18n';
import { dotsOf, underlinesOf } from '@/lib/annotation-layout';
import { appendLine, formVariables } from '@/lib/chain-draft';
import { catalogueOf, HIVE_ORIGIN } from '@/lib/plugins';
import { isMarkdown, plainLook, previewLook, type TextLook, templateLook } from '@/lib/template-view';

interface SkillEditorProps { editor: ItemEditor; annotations: Annotations; items: readonly CatalogueItem[]; workspaces: readonly string[]; fontFamily: string }
interface BodyProps extends SkillEditorProps { item: CatalogueItem; read: ItemRead; path: string }
const NOTE = 'border-b px-3 py-1 text-xs';

// The open file's look (decisions 14, 15, 23): the preview's for a "view as" workspace, the template's for a markdown file, plain otherwise.
// A preview that fails keeps the template's look, read-only, under its error (decision 25)
function useFileLook({ editor, items, item, path }: BodyProps) {
  const text = editor.textOf(path);
  const isMd = isMarkdown(path);
  const catalogue = useMemo(() => catalogueOf(items), [items]);
  const parsed = useMemo(() => parseTemplate(text), [text]);
  const map = useMemo(() => buildMap(parsed, catalogue), [parsed, catalogue]);
  const workspace = item.origin === HIVE_ORIGIN ? editor.viewAs : undefined; // a workspace item has no variables (decision 27)
  // Only a markdown file is rendered (decision 14): a script under "view as" stays its own text, read-only
  const preview = useMemo(() => (workspace === undefined || !isMd ? undefined : previewTemplate(parsed, map, workspace)), [parsed, map, workspace, isMd]);
  const look = useMemo(() => {
    if (preview?.ok) return previewLook(preview);
    return isMd ? templateLook({ text, parsed, map, catalogue, mode: editor.mode, isHeaderShown: item.kind === 'specialist' }) : plainLook(text);
  }, [preview, isMd, text, parsed, map, catalogue, editor.mode, item.kind]);
  return { isMd, parsed, map, workspace, preview, look };
}

// #327: an annotation's reveal (the counter, a note, a pane's line) lands as a map click does; a reveal from before this file opened is not
// replayed
function useAnnotationReveal(revealed: Annotations['revealed'], reveal: (line: number) => void): void {
  const latest = useRef(reveal);
  useEffect(() => { latest.current = reveal; });
  const seen = useRef(revealed?.n);
  useEffect(() => {
    if (revealed === undefined || revealed.n === seen.current) return;
    seen.current = revealed.n;
    latest.current(revealed.line);
  }, [revealed]);
}

type OpenForm = { kind: 'card'; line: number } | { kind: 'popover'; chip: number }; // the one card or popover open (decision 11)
interface FormsArgs { editor: ItemEditor; parsed: ParsedTemplate; map: TemplateMap; workspaces: readonly string[]; isReadOnly: boolean; reveal(line: number): void }
interface ChainForms { onPlus?(line: number): void; gap?: MapGap; onChip(line: number): void; popover?: ChipPopover }

// The "+"'s card and the chip's popover (#322, decisions 10-13): one open at a time, its draft gone when it closes; neither in the preview nor on a read-only original (#320)
function useChainForms({ editor, parsed, map, workspaces, isReadOnly, reveal }: FormsArgs): ChainForms {
  const [open, setOpen] = useState<OpenForm>();
  const variables = useMemo(() => formVariables(parsed.variables, workspaces), [parsed, workspaces]);
  const close = (): void => setOpen(undefined);
  const forms: ChainForms = { onPlus: isReadOnly ? undefined : (line) => setOpen({ kind: 'card', line }), onChip: (chip) => setOpen({ kind: 'popover', chip }) };
  if (isReadOnly || open === undefined) return forms;
  if (open.kind === 'card') {
    const insert = (spec: ChainSpec): EditResult => {
      const result = editor.insertChain(open.line, spec);
      if (result.ok) reveal(open.line); // decision 12: the editor goes to the inserted chain
      return result;
    };
    return { ...forms, gap: { line: open.line, card: <ChainCard key={open.line} variables={variables} onInsert={insert} onClose={close} /> } };
  }
  // the chip of any conditional block, the else's too, opens its whole chain; a chain gone from the text closes the popover
  const chain = chainsOf(map.blocks).find((c) => c.branches.some((b) => b.line === open.chip));
  if (chain === undefined) return forms;
  const content = (
    <ConditionPopover
      key={chain.line} chain={chain} parsed={parsed} variables={variables} workspaces={workspaces}
      onOk={(spec) => editor.replaceChain(chain.line, spec)} onRemove={() => editor.removeChain(chain.line)} onClose={close}
    />
  );
  return { ...forms, popover: { line: open.chip, content, onClose: close } };
}

function EditorBody(props: BodyProps) {
  const { editor, annotations, item, read, path, fontFamily, workspaces } = props;
  const { isMd, parsed, map, workspace, preview, look } = useFileLook(props);
  // The source line of the last reveal: the look maps it at render, so a chain just inserted lands under the look that holds it
  const [reveal, setReveal] = useState<Reveal>();
  const revealLine = (line: number): void => setReveal((last) => ({ line, n: (last?.n ?? 0) + 1 }));
  useAnnotationReveal(annotations.revealed, revealLine);
  const decorations = useMemo(() => [...look.decorations, ...underlinesOf(annotations.list, look.text)], [look, annotations.list]);
  const dots = useMemo(() => dotsOf(map, parsed.bodyLine, annotations.list), [map, parsed.bodyLine, annotations.list]);
  const isPreview = workspace !== undefined;
  const canEdit = !isPreview && !editor.isReadOnly; // #320, decision 8: the original once the item has a version reads as the preview does
  const forms = useChainForms({ editor, parsed, map, workspaces, isReadOnly: !canEdit, reveal: revealLine });
  const failed = preview?.ok === false ? preview.errors[0] : undefined;
  return (
    <section aria-label={item.name} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <FileTabs
        files={read.files.map((file) => file.path)} open={path} isDirty={editor.isDirty} onOpen={editor.openFile} previewOf={workspace}
        onAdd={item.kind === 'skill' && canEdit ? editor.newFile : undefined} mode={isMd && !isPreview ? editor.mode : undefined} onMode={editor.setMode}
      />
      {editor.error && <p role="alert" className={`${NOTE} text-destructive`}>{t(editor.error, editor.errorVars)}</p>}
      {annotations.error && <p role="alert" className={`${NOTE} text-destructive`}>{t(annotations.error)}</p>}
      {editor.renamedTo && <p role="status" className={`${NOTE} text-muted-foreground`}>{t('plugins.editor.renamed', { name: editor.renamedTo })}</p>}
      {failed && workspace && <p role="alert" className={`${NOTE} text-destructive`}>{t('plugins.viewAs.failed', { workspace, line: failed.line })}</p>}
      <div className="flex min-h-0 flex-1">
        {isMd ? (
          <BlockMap
            map={map} collapsed={editor.collapsed} dimmed={look.dimmed} canDrag={canEdit} onToggle={editor.toggle} onMove={editor.move} appendLine={appendLine(parsed)}
            onReveal={revealLine} onPlus={forms.onPlus} gap={forms.gap}
            dots={isPreview ? undefined : dots} onDot={annotations.openAt}
          />
        ) : <p className="w-[236px] shrink-0 border-r p-3 text-muted-foreground text-xs">{t('plugins.map.none')}</p>}
        <TemplateText
          modelKey={[item.id, editor.version ?? '', path, preview?.ok ? workspace : ''].join('\0')} path={path} text={look.text} isReadOnly={!canEdit} fontFamily={fontFamily}
          hidden={look.hidden} decorations={decorations} chips={look.chips} reveal={reveal && { line: look.lineOf(reveal.line), n: reveal.n }} onChip={forms.onChip} popover={forms.popover} onChange={editor.edit} onSave={() => void editor.save()}
          annotations={isPreview ? undefined : annotations} anchorOf={look.lineOf}
        />
      </div>
    </section>
  );
}

/** A skill's or a specialist's item screen (#319, #323, handoff 11b, 11c, 11e, 11m): its files, the map and the text, or the preview of one
 * workspace; #327: the open file's annotations in the text. A specialist is one file: no "+", and its header stays in the text. The body is keyed by item and file, so a switch starts with
 * no pending reveal. */
export function SkillEditor(props: SkillEditorProps) {
  const { item, read, path, hasFailed } = props.editor;
  if (hasFailed) return <p role="alert" className="p-4 text-destructive text-xs">{t('plugins.editor.loadFailed')}</p>;
  if (item === undefined || read === undefined || path === undefined) return <p className="p-4 text-muted-foreground text-xs">{t('files.loading')}</p>;
  return <EditorBody key={`${item.id}\0${props.editor.version ?? ''}\0${path}`} {...props} item={item} read={read} path={path} />;
}
