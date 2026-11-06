import { useState } from 'react';
import type { Language } from '../../types';
import { pageTheme } from '@/components/design-frame';
import { DiskStrip, EditorBar } from '@/components/EditorPane';
import { useDiagramBridge } from '@/hooks/use-diagram-bridge';
import { currentLanguage } from '@/i18n';
import type { Activity } from '@/lib/activities';
import type { DesignTheme } from '@/lib/design-comments';
import { baseName } from '../../base-name';

// The diagram pane (#956): one .drawio of an activity in the draw.io webapp the Hive serves (#955), in a sandboxed frame, under the editor's
// bar and strip. draw.io draws everything else, pan and zoom included. Lives in the design layer (#533), so a tab switch never reloads it.

const DRAWIO_PAGE = '/drawio/index.html'; // src/secret.ts's DRAWIO_PREFIX, a server module the page cannot import
// offline: no app.diagrams.net; stealth: no outside request at all; lockdown: no plugin or remote resource (#955); spin: a spinner while it loads
const EMBED = { embed: '1', proto: 'json', offline: '1', stealth: '1', lockdown: '1', spin: '1' } as const;
const DRAWIO_LANG: Record<Language, string> = { en: 'en', pt: 'pt-br' }; // the Hive's Portuguese is Brazil's; draw.io's `pt` is Portugal's

/** The frame's URL (#956): the embed's safety parameters, then the Hive's theme and language. */
export function drawioFrameUrl(theme: DesignTheme, language: Language): string {
  return `${DRAWIO_PAGE}?${new URLSearchParams({ ...EMBED, dark: theme === 'dark' ? '1' : '0', lang: DRAWIO_LANG[language] })}`;
}

/** label: `{task label} · Diagram {file name}`, the section's name. */
export interface DiagramPaneProps { activity: Activity; path: string; label: string; active: boolean }

/** The diagram pane (#956). No PaneHeader above it: the bar names the path. */
export function DiagramPane({ activity, path, label, active }: DiagramPaneProps) {
  const activityId = activity.activity.id;
  const bridge = useDiagramBridge(activityId, path, active);
  const [url] = useState(() => drawioFrameUrl(pageTheme(), currentLanguage())); // read once: a theme change applies on the next open, never mid-edit
  return (
    <section aria-label={label} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <EditorBar file={{ activityId, path }} error={bridge.error} />
      {bridge.strip && <DiskStrip strip={bridge.strip} onReload={bridge.reload} onKeep={bridge.keep} />}
      <iframe ref={bridge.frame} src={url} title={baseName(path)} sandbox="allow-scripts" referrerPolicy="no-referrer" className="min-h-0 w-full flex-1 border-0 bg-background" />
    </section>
  );
}
