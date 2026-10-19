import { Fragment, type MouseEvent, useEffect, useRef, useState } from 'react';
import type { BasedOn } from '../../../template';
import { LinkConfirm } from '@/components/LinkConfirm';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { type MessageKey, t } from '@/i18n';
import { openLink, webHost } from '@/lib/trusted-links';

export interface OriginCardProps { basedOn: BasedOn; description: string; className?: string }

// ponytail: a fixed beat lets the pointer cross from the link to the card; a setting if it reads wrong
const CLOSE_DELAY_MS = 120;

// The url is the item author's header text: only an http(s) one becomes a link the window hands to the browser
const linkOf = (url: string): string | undefined => (webHost(url) === undefined ? undefined : url);

// Decision 17: Popover opened on pointer enter or focus, closed a beat after leaving both, since no hover-card component ships here
function useHover() {
  const [isOpen, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = (): void => { clearTimeout(timer.current); setOpen(true); };
  const hide = (): void => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS); };
  return { isOpen, setOpen, show, hide };
}

function Rows({ basedOn }: { basedOn: BasedOn }) {
  const rows: readonly (readonly [MessageKey, string, boolean])[] = [
    ['plugins.origin.repository', basedOn.repo, true],
    ['plugins.origin.version', basedOn.ref, false],
    ['plugins.origin.license', basedOn.license, false],
    ['plugins.origin.bond', t('plugins.origin.creditOnly'), false],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      {rows.map(([key, value, isMono]) => (
        <Fragment key={key}><dt className="text-muted-foreground">{t(key)}</dt><dd className={isMono ? 'font-mono' : ''}>{value}</dd></Fragment>
      ))}
    </dl>
  );
}

/** The meta line's "based on <name> ↗" and its 340px card (#320, handoff 11i): the external item, its description (the item's own: BasedOn
 * has none), its repository, version, license and the credit-only link. A click opens the url in the browser. */
export function OriginCard({ basedOn, description, className = '' }: OriginCardProps) {
  const hover = useHover();
  const href = linkOf(basedOn.url);
  const label = t('plugins.origin.link', { name: basedOn.name });
  const look = `underline-offset-2 hover:underline ${className}`;
  const [pending, setPending] = useState<string>();
  // The header's url is any author's text: an untrusted host asks first, as a terminal's link does (#404)
  const open = (e: MouseEvent): void => { e.preventDefault(); if (href !== undefined) openLink(href, setPending); };
  const handlers = { onPointerEnter: hover.show, onPointerLeave: hover.hide, onFocus: hover.show, onBlur: hover.hide };
  return (
    <>
      <Popover open={hover.isOpen} onOpenChange={hover.setOpen}>
        <PopoverAnchor asChild>
          {href === undefined
            ? <button type="button" {...handlers} className={look}>{label}</button>
            : <a href={href} target="_blank" rel="noreferrer" onClick={open} {...handlers} className={look}>{label}</a>}
        </PopoverAnchor>
        <PopoverContent
          align="start" onOpenAutoFocus={(e) => e.preventDefault()} onCloseAutoFocus={(e) => e.preventDefault()}
          onPointerEnter={hover.show} onPointerLeave={hover.hide} className="flex w-[340px] flex-col gap-2 p-3 text-xs"
        >
          <div className="flex items-center justify-between text-muted-foreground">
            <span>{t('plugins.origin.title')}</span>
            {href !== undefined && <a href={href} target="_blank" rel="noreferrer" onClick={open} className="hover:underline">{t('plugins.origin.open')}</a>}
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="font-mono font-semibold">{basedOn.name}</span>
            {description !== '' && <span className="text-muted-foreground">{description}</span>}
          </div>
          <Rows basedOn={basedOn} />
        </PopoverContent>
      </Popover>
      <LinkConfirm url={pending} onClose={() => setPending(undefined)} />
    </>
  );
}
