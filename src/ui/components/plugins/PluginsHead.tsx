import type { ReactNode } from 'react';
import type { CatalogueItem, UpdatePreview } from '../../../types';
import { STATE_LOOK } from '@/components/plugins/marks';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Plugins } from '@/hooks/use-plugins';
import { type MessageKey, t } from '@/i18n';
import { HIVE_ORIGIN, type ListSection, sectionOf } from '@/lib/plugins';

// The header drags the window: its controls opt out to keep their clicks, as Header's own do
const NO_DRAG = '[-webkit-app-region:no-drag]';
const CHIP = 'rounded-full border px-1.5 font-normal text-[11px]';
const ALL = '*'; // the filter's "all workspaces": no workspace may be named `*` (WORKSPACE_NAME)
const META: Record<ListSection, MessageKey> = { skills: 'plugins.list.meta.skills', specialists: 'plugins.list.meta.specialists' };
const NEW: Record<ListSection, MessageKey> = { skills: 'plugins.list.newSkill', specialists: 'plugins.list.newSpecialist' };

interface HeadProps { title: string; isMono?: boolean; chip?: ReactNode; meta?: string; children?: ReactNode }

function Head({ title, isMono = false, chip, meta, children }: HeadProps) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-xs">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2 font-semibold text-[13px]"><span className={isMono ? 'truncate font-mono' : 'truncate'}>{title}</span>{chip}</span>
        {meta && <span className="truncate text-muted-foreground">{meta}</span>}
      </div>
      {children}
    </div>
  );
}

function ListHead({ plugins, section, workspaces }: { plugins: Plugins; section: ListSection; workspaces: readonly string[] }) {
  return (
    <Head title={t(`plugins.section.${section}`)} meta={t(META[section])}>
      <Select value={plugins.filter ?? ALL} onValueChange={(value) => plugins.setFilter(value === ALL ? undefined : value)}>
        <SelectTrigger size="sm" aria-label={t('plugins.list.filter')} className={NO_DRAG}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t('plugins.list.allWorkspaces')}</SelectItem>
          {workspaces.filter((w) => w !== HIVE_ORIGIN).map((w) => <SelectItem key={w} value={w}>{w}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button type="button" size="sm" className={NO_DRAG} onClick={() => plugins.setCreating(true)}>{t(NEW[section])}</Button>
    </Head>
  );
}

function ItemHead({ item }: { item: CatalogueItem }) {
  const look = STATE_LOOK[item.state];
  const chip = <span className={`${CHIP} ${look.chip}`}>{t(look.label)}</span>;
  return <Head title={item.name} isMono chip={chip} meta={t(`plugins.section.${sectionOf(item.kind)}`)} />;
}

const metaOf = ({ from, to }: UpdatePreview): string => (from !== undefined && to !== undefined ? t('plugins.update.meta', { from, to }) : t('plugins.update.metaBare'));

/** The update screen's head (#325, decision 5): the item's mono name, the yellow chip, and `hive <from> → <to>` once the preview answers.
 * The update screen portals it, since only it holds the preview. */
export function UpdateHead({ item, preview }: { item: CatalogueItem; preview?: UpdatePreview }) {
  const look = STATE_LOOK['update available'];
  return <Head title={item.name} isMono chip={<span className={`${CHIP} ${look.chip}`}>{t(look.label)}</span>} meta={preview && metaOf(preview)} />;
}

/** The header's centre in the plugins view (#313, decision 17). The slots 3.5 and later fill (the version selector, the reviewer, revert) are
 * not drawn. An item the catalogue no longer has heads nothing. */
export function PluginsHead({ plugins, workspaces }: { plugins: Plugins; workspaces: readonly string[] }) {
  const { screen } = plugins;
  if (screen.kind === 'list') return <ListHead plugins={plugins} section={screen.section} workspaces={workspaces} />;
  if (screen.kind === 'update') return null; // the update screen portals its own head: its meta needs the preview (#325)
  if (screen.kind !== 'item') return <Head title={t(`plugins.section.${screen.kind}`)} />;
  const item = plugins.items?.find((i) => i.id === screen.id);
  return item === undefined ? null : <ItemHead item={item} />;
}
