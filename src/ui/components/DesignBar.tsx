import { MessageCircleIcon } from 'lucide-react';
import { TOGGLE_ITEM, TOGGLE_TRACK } from '@/components/DesignComments';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { type DesignZoom, isViewport, type Viewport, VIEWPORTS } from '@/hooks/use-design-zoom';
import { t } from '@/i18n';
import { clockOf, type DesignTheme } from '@/lib/design-comments';
import { STATUS_DOT } from '@/lib/status';

// The design pane's preview bar (#109, #113, #114), apart from DesignPane.tsx

const THEMES: readonly DesignTheme[] = ['dark', 'light'];

// The handoff's §2.2: after the first reload, ● in --working and the time; it stays until the tab unmounts, updated on each reload
function ReloadedMark({ name, at }: { name: string; at: Date }) {
  const time = clockOf(at);
  return (
    <span title={t('design.reloaded', { file: name, time })} className="flex shrink-0 items-center gap-1 tabular-nums">
      <span aria-hidden="true" className={`size-1.5 rounded-full ${STATUS_DOT.working}`} />{time}
    </span>
  );
}

function ZoomControl({ zoom }: { zoom: DesignZoom }) {
  return (
    <span className="flex shrink-0 items-center">
      <Button type="button" size="icon-xs" variant="ghost" aria-label={t('design.zoomOut')} onClick={() => zoom.zoomBy(-1)}>−</Button>
      <span title={t('design.fit')} className="w-10 text-center tabular-nums">{`${zoom.zoom}%`}</span>
      <Button type="button" size="icon-xs" variant="ghost" aria-label={t('design.zoomIn')} onClick={() => zoom.zoomBy(1)}>+</Button>
    </span>
  );
}

export interface CommentsToggle { count: number; isShown: boolean; onToggle(): void; isCommenting: boolean; onComment(): void }
interface BarProps { path: string; name: string; reloadedAt?: Date; viewport: Viewport; theme: DesignTheme; zoom: DesignZoom; comments?: CommentsToggle; onViewport(next: Viewport): void; onTheme(next: DesignTheme): void }

// The bar's item 7 (#114): on, an --empty border on --accent; off, the border alone
function CommentModeButton({ isOn, onToggle }: { isOn: boolean; onToggle(): void }) {
  return (
    <Button type="button" size="xs" variant="ghost" aria-pressed={isOn} title={t('design.comment.toggle')} onClick={onToggle} className={`shrink-0 border ${isOn ? 'border-empty bg-accent text-foreground' : 'text-muted-foreground'}`}>
      {t('design.comment')}
    </Button>
  );
}

// The bar's item 8 (#113): message-circle and the open count; --accent with --foreground while the panel shows, muted while hidden
function CommentsButton({ count, isShown, onToggle }: CommentsToggle) {
  return (
    <Button type="button" size="xs" variant="ghost" aria-label={t('design.comments')} aria-pressed={isShown} title={t('design.comments.toggle')} onClick={onToggle} className={`shrink-0 tabular-nums ${isShown ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}>
      <MessageCircleIcon className="size-3" />{count}
    </Button>
  );
}

// The handoff's preview bar (#109), items 1–5 and, on a task's pane, 7 (#114) and 8 (#113): 26 px, one line that hides what does not fit
export function DesignBar({ path, name, reloadedAt, viewport, theme, zoom, comments, onViewport, onTheme }: BarProps) {
  return (
    <div className="flex h-[26px] shrink-0 items-center gap-3 overflow-hidden border-b px-2.5 text-muted-foreground text-xs">
      <span title={path} className="min-w-0 flex-1 truncate font-mono">{path}</span>
      {reloadedAt && <ReloadedMark name={name} at={reloadedAt} />}
      <ToggleGroup type="single" size="xs" aria-label={t('design.viewport')} value={viewport} onValueChange={(next) => { if (isViewport(next)) onViewport(next); }} className={TOGGLE_TRACK}>
        {VIEWPORTS.map((item) => <ToggleGroupItem key={item} value={item} className={TOGGLE_ITEM}>{t(`design.viewport.${item}`)}</ToggleGroupItem>)}
      </ToggleGroup>
      <ZoomControl zoom={zoom} />
      <ToggleGroup type="single" size="xs" aria-label={t('design.theme')} value={theme} onValueChange={(next) => { if (next === 'dark' || next === 'light') onTheme(next); }} className={TOGGLE_TRACK}>
        {THEMES.map((item) => <ToggleGroupItem key={item} value={item} className={TOGGLE_ITEM}>{t(`design.theme.${item}`)}</ToggleGroupItem>)}
      </ToggleGroup>
      {comments && (
        <>
          <span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-border" />
          <CommentModeButton isOn={comments.isCommenting} onToggle={comments.onComment} />
          <CommentsButton {...comments} />
        </>
      )}
    </div>
  );
}
