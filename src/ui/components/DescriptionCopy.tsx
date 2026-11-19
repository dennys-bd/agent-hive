import { type ReactNode, useRef } from 'react';
import { Copy, FileCode } from 'lucide-react';
import { toast } from 'sonner';
import { IssueMarkdown } from '@/components/IssueMarkdown';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { type MessageKey, t } from '@/i18n';

// A clipboard refusal's raw DOMException text is not copy for a person, so the toast says it in our own words
function copied(write: Promise<void>): void {
  write.then(() => toast.success(t('detail.copied')), () => toast.error(t('detail.copyFailed')));
}

// The rendered description as rich text, its text as the fallback, so it pastes formatted wherever rich text is taken. Async so a
// synchronous throw (no ClipboardItem) still lands in copied's error toast
async function copyRendered(el: HTMLElement): Promise<void> {
  const blob = (text: string, type: string): Blob => new Blob([text], { type });
  return navigator.clipboard.write([new ClipboardItem({ 'text/html': blob(el.innerHTML, 'text/html'), 'text/plain': blob(el.innerText, 'text/plain') })]);
}

function CopyButton({ label, icon, onClick }: { label: MessageKey; icon: ReactNode; onClick(): void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label={t(label)} onClick={onClick}>{icon}</Button>
      </TooltipTrigger>
      <TooltipContent>{t(label)}</TooltipContent>
    </Tooltip>
  );
}

/** The task's description in the Detalhes panel (#283, #958): a heading row, descrição then copiar (the rendered text) and copiar markdown
 * (the issue's own source) on its right; with no description there is nothing to copy, so no buttons. */
export function TaskDescription({ body }: { body: string }) {
  const rendered = useRef<HTMLDivElement>(null);
  const isEmpty = body.trim() === '';
  const copyRich = (): void => { if (rendered.current) copied(copyRendered(rendered.current)); };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-0.5">
        <h3 className="flex-1 font-medium text-xs">{t('detail.description')}</h3>
        {/* Radix keeps a tooltip open while the pointer crosses toward it; with two adjacent buttons that path runs over the neighbour, so
            moving from one to the other could leave the first's label showing */}
        {!isEmpty && (
          <TooltipProvider disableHoverableContent>
            <CopyButton label="detail.copy" icon={<Copy />} onClick={copyRich} />
            <CopyButton label="detail.copyRaw" icon={<FileCode />} onClick={() => copied(navigator.clipboard.writeText(body))} />
          </TooltipProvider>
        )}
      </div>
      {isEmpty ? <p className="text-muted-foreground">{t('detail.noBody')}</p> : <div ref={rendered}><IssueMarkdown text={body} /></div>}
    </div>
  );
}
