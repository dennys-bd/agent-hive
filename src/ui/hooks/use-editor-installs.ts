import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { getJson, postJson } from '@/lib/api';
import { onEditorInstall } from '@/lib/editor-install-events';
import { withInstallEvent } from '@/lib/settings-languages';
import type { EditorInstalls, InstallAction, InstallTarget } from '../../types';

/** Settings › editor's installs (#780): read once, then kept by the state stream's editorInstall events; an action posts and the event answers. */
export function useEditorInstalls(): { installs?: EditorInstalls; act(target: InstallTarget, action: InstallAction): void } {
  const [installs, setInstalls] = useState<EditorInstalls>();
  useEffect(() => {
    let live = true;
    getJson<EditorInstalls>('/settings/editor/installs').then((value) => { if (live) setInstalls(value); }, (err: Error) => toast.error(err.message));
    const stop = onEditorInstall((event) => setInstalls((current) => current && withInstallEvent(current, event)));
    return () => { live = false; stop(); };
  }, []);
  const act = (target: InstallTarget, action: InstallAction): void => {
    void postJson(`/settings/editor/installs/${target.kind}/${encodeURIComponent(target.id)}`, { action }).catch((err: Error) => toast.error(err.message));
  };
  return { installs, act };
}
