import { DialogBase } from '@/components/DialogBase';
import { formatCount, t, tPlural } from '@/i18n';
import { rich } from './SearchNotes';

interface ConfirmProps {
  open: boolean; files: number; occurrences: number; query: string; replacement: string; dirty: string[]; scope: string;
  onConfirm(): void; onOpenChange(open: boolean): void;
}

const Code = ({ children }: { children: string }) => <code className="font-mono">{children}</code>;

/** Replace-all's confirmation: how many files and occurrences, the unsaved files it leaves out, and the scope it runs in. */
export function ReplaceConfirm({ open, files, occurrences, query, replacement, dirty, scope, onConfirm, onOpenChange }: ConfirmProps) {
  const body = rich('search.confirm.body', { occurrences: tPlural('search.occurrences', occurrences, { n: formatCount(occurrences) }), query: <Code>{query}</Code>, replacement: <Code>{replacement}</Code> });
  const dirtyNote = dirty.length === 0 ? null : rich(dirty.length === 1 ? 'search.confirm.dirty.one' : 'search.confirm.dirty.other', { names: dirty.map((name, i) => <span key={name}>{i > 0 && ', '}<Code>{name.slice(name.lastIndexOf('/') + 1)}</Code></span>) });
  return (
    <DialogBase
      open={open} onOpenChange={onOpenChange} title={tPlural('search.confirm.title', files, { n: formatCount(files) })} context={<span className="font-mono">{scope}</span>}
      primary={{ label: t('search.confirm.submit'), onConfirm }} initialFocus="primary"
    >
      <p className="text-sm">{body}{dirtyNote === null ? null : <> {dirtyNote}</>}</p>
    </DialogBase>
  );
}
