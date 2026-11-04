// A detached window's layout (#553): the center's own store (useCenterLayouts) started empty and with no main-run fallback, so the window
// shows only the tabs main sent it. Tabs arrive through window:open, go back through dock, and every change of the refs is reported to main,
// whose focusTab and detachedTabs answer from it (#552).
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { type MovedTab, parseMovedTab } from '../../tab-carry';
import { dropBuffer } from '@/components/CenterGroup';
import type { TabRequest } from '@/hooks/use-activity';
import { type CenterLayouts, type CenterLayoutsOptions, useCenterLayouts } from '@/hooks/use-center-layouts';
import { t } from '@/i18n';
import { type Activity, activityKey } from '@/lib/activities';
import { type CenterLayout, type CenterTabRef, groupsOf, refKey, sharesBuffer } from '@/lib/center-layout';
import { applyCarry, takeCarry } from '@/lib/tab-carry';

export interface DetachedLayout extends CenterLayouts {
  request(tab?: CenterTabRef): void; // the window's openers: a run tab waits for its run to be live, no tab means the task's stage run
  receive(tab: MovedTab): Promise<void>; // applyCarry, then open the answered ref
  dock(ref: CenterTabRef): Promise<boolean>; // takeCarry, bridge dock, then close; false on a rejection (toast shown)
  dockAll(): Promise<boolean>; // every tab in the layout's order; stops at the first rejection
  isEmpty: boolean; // the layout held a tab and now holds none
}

const WINDOW_LAYOUTS: CenterLayoutsOptions = { seed: {}, fallback: false }; // read once, by the store's initializer

/** Every tab of the layout in reading order: the groups', each group's in its strip's order. */
const tabsOf = (layout?: CenterLayout): CenterTabRef[] => (layout === undefined ? [] : groupsOf(layout.root).flatMap((group) => group.tabs));

// Main lists what the page last reported (#552). Nothing before the first tab: a [] from the mount could reach main after it listed that tab
function useTabsReport(layout: CenterLayout | undefined, hasHeld: boolean): void {
  const refs = JSON.stringify(tabsOf(layout));
  useEffect(() => {
    if (hasHeld) window.hive?.tabsChanged(JSON.parse(refs) as CenterTabRef[]);
  }, [refs, hasHeld]);
}

// Subscribed once the activity is listed; the preload holds every window:open until then, in order. Untrusted IPC that main already
// parsed, so a bad one is a bug: logged, no toast
function useArrivals(key: string | undefined, receive: (tab: MovedTab) => Promise<void>): void {
  const latest = useRef(receive);
  useEffect(() => { latest.current = receive; });
  useEffect(() => {
    if (key === undefined) return;
    window.hive?.onOpen((value) => {
      const tab = parseMovedTab(value);
      if (tab === undefined || tab.activity !== key) {
        console.error('detached window: window:open dropped', value);
        return;
      }
      latest.current(tab).catch((err: unknown) => console.error('detached window: a moved tab did not open', err));
    });
  }, [key]);
}

export function useDetachedLayout(activities: Activity[], activity: Activity | undefined): DetachedLayout {
  const [request, setRequest] = useState<TabRequest>();
  const layouts = useCenterLayouts(activities, activity, request, WINDOW_LAYOUTS);
  const [hasHeld, setHasHeld] = useState(false);
  const isHolding = layouts.layout !== undefined;
  useEffect(() => { if (isHolding) setHasHeld(true); }, [isHolding]);
  useTabsReport(layouts.layout, hasHeld);
  // The last render's layouts and activity, so an await never acts on a stale closure
  const latest = useRef({ layouts, activity });
  useEffect(() => { latest.current = { layouts, activity }; });
  const receive = async (tab: MovedTab): Promise<void> => {
    const shown = latest.current.activity;
    if (shown === undefined) return;
    const ref = await applyCarry(shown.activity.id, tab.ref, tab.carry); // an untitled number taken here comes back renumbered (#551)
    latest.current.layouts.open(ref); // into the focused group, picked
  };
  useArrivals(activity && activityKey(activity), receive);
  // The tab and its unsaved edits leave only once main took them
  const dock = async (ref: CenterTabRef): Promise<boolean> => {
    const shown = latest.current.activity;
    if (shown === undefined) return false;
    const carry = takeCarry(shown.activity.id, ref);
    try {
      await window.hive?.dock({ activity: activityKey(shown), ref, ...(carry === undefined ? {} : { carry }) });
    } catch (err) {
      console.error('detached window: dock refused', err);
      toast.error(t('window.dockFailed'));
      return false;
    }
    const now = latest.current.layouts;
    const isShared = sharesBuffer(now.layout, ref);
    now.close(refKey(ref)); // no closeRun: the run goes on in the main window
    dropBuffer(ref, shown.activity.id, isShared);
    return true;
  };
  // One after another in the layout's order; a refused one stops it, and the tabs left stay
  const dockAll = async (): Promise<boolean> => {
    for (const ref of tabsOf(latest.current.layouts.layout)) {
      if (!(await dock(ref))) return false;
    }
    return true;
  };
  const requestTab = useCallback((tab?: CenterTabRef) => setRequest(tab === undefined ? {} : { tab }), []);
  return { ...layouts, request: requestTab, receive, dock, dockAll, isEmpty: hasHeld && !isHolding };
}
