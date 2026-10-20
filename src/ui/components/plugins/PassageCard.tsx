import { PencilIcon } from 'lucide-react';
import { type KeyboardEvent, useMemo } from 'react';
import { renderPassages } from '../../../protocol-inserts';
import { splitHeader, type TemplateError } from '../../../template';
import { Confirm } from '@/components/Confirm';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { newDraft, newKey, type Protocol, type ProtocolPassageView, type SaveError } from '@/hooks/use-protocol';
import { t } from '@/i18n';

export interface PassageCardProps { protocol: Protocol; after: string; saved?: ProtocolPassageView; workspaces: readonly string[] }
interface ActionsProps { protocol: Protocol; passageKey: string; isNew: boolean; isUnchanged: boolean; onSave(): void }

// The body is a suffix of the text (splitHeader), so swapping it keeps the header's bytes: `after:` cannot be broken from the card
const withBody = (text: string, body: string): string => `${text.slice(0, text.length - splitHeader(text).body.length)}${body}`;

// The render the runs use, once per workspace: in all, no label; in some, which; in none, say so. A workspace where it fails counts as not in
function conditionOf(text: string, workspaces: readonly string[]): string | undefined {
  const shownIn = workspaces.filter((workspace) => {
    const [rendered] = renderPassages([{ id: '', text }], workspace);
    return rendered.text !== undefined && rendered.text !== '';
  });
  if (shownIn.length === workspaces.length) return undefined;
  return shownIn.length === 0 ? t('plugins.protocol.inNone') : t('plugins.protocol.onlyIn', { list: shownIn.join(', ') });
}

// The user sees only the body: a file line inside it is counted from the body's first line; one in the header shows without a line
const errorText = ({ line, message }: TemplateError, bodyLine: number): string =>
  (line >= bodyLine ? t('plugins.protocol.lineError', { line: line - bodyLine + 1, message }) : message);

function saveErrorLines(error: SaveError | undefined, bodyLine: number): string[] {
  if (error === undefined) return [];
  return typeof error === 'string' ? [t(error)] : error.map((e) => errorText(e, bodyLine));
}

// #336's errors: the saved passage is absent from that workspace's files, one red line per workspace with its first error
function leftOutLines(saved: ProtocolPassageView | undefined): string[] {
  if (saved === undefined) return [];
  const { bodyLine } = splitHeader(saved.text);
  return Object.entries(saved.errors).flatMap(([workspace, errors]) =>
    errors.slice(0, 1).map((error) => t('plugins.protocol.leftOutOf', { workspace, error: errorText(error, bodyLine) })));
}

function CardActions({ protocol, passageKey, isNew, isUnchanged, onSave }: ActionsProps) {
  return (
    <div className="flex items-center gap-1.5">
      <Button type="button" size="xs" disabled={isUnchanged} onClick={onSave}>{t('plugins.protocol.save')}</Button>
      {isNew ? (
        <Button type="button" size="xs" variant="ghost" onClick={() => protocol.cancel(passageKey)}>{t('plugins.protocol.cancel')}</Button>
      ) : (
        <Confirm
          title={t('plugins.protocol.deleteTitle')} message={t('plugins.protocol.deleteMessage')} confirmLabel={t('plugins.protocol.deleteConfirm')}
          onConfirm={() => protocol.remove(passageKey)} trigger={<Button type="button" size="xs" variant="ghost">{t('plugins.protocol.delete')}</Button>}
        />
      )}
    </div>
  );
}

/** The user's passage (#337, handoff 11g): the blue left border of "customized", the body in a textarea that grows with it; the header is the
 * screen's, edited through the variables pane. Saved only by "save" or ⌘S: each save rewrites every workspace's protocol files. */
export function PassageCard({ protocol, after, saved, workspaces }: PassageCardProps) {
  const passageKey = saved?.id ?? newKey(after);
  const savedText = saved?.text ?? newDraft(after);
  const text = protocol.drafts[passageKey] ?? savedText;
  const { body, bodyLine } = useMemo(() => splitHeader(text), [text]);
  const condition = useMemo(() => conditionOf(text, workspaces), [text, workspaces]);
  const isUnchanged = text === savedText;
  const save = (): void => {
    if (!isUnchanged) void protocol.save(passageKey);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!(event.metaKey || event.ctrlKey) || event.key !== 's') return;
    event.preventDefault(); // ⌘S saves this passage, nothing else
    save();
  };
  const errors = [...saveErrorLines(protocol.saveErrors[passageKey], bodyLine), ...leftOutLines(saved)];
  return (
    <article
      aria-label={saved?.id ?? t('plugins.protocol.newPassage')} onFocus={() => protocol.select(passageKey)}
      className="flex flex-col gap-1.5 rounded-md border border-l-2 border-l-primary px-3 py-2 text-xs"
    >
      <div className="flex items-center gap-1.5">
        <PencilIcon aria-hidden className="size-3 text-muted-foreground" />
        <span className="flex-1 font-medium">{t('plugins.protocol.yourPassage')}</span>
        {condition && <span className="text-muted-foreground">{condition}</span>}
      </div>
      <Textarea
        aria-label={t('plugins.protocol.body')} value={body} onKeyDown={onKeyDown}
        onChange={(event) => protocol.edit(passageKey, withBody(text, event.currentTarget.value))} className="min-h-10 font-mono text-xs md:text-xs"
      />
      {errors.map((line) => <p key={line} className="text-destructive">{line}</p>)}
      {saved?.orphan && <p className="text-waiting">{t('plugins.protocol.orphan')}</p>}
      <CardActions protocol={protocol} passageKey={passageKey} isNew={saved === undefined} isUnchanged={isUnchanged} onSave={save} />
    </article>
  );
}
