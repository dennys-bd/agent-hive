import { secretCookie } from '../../src/secret.js';
import { VIEWPORT } from '../../src/benchmark/browser.js';

const DASHBOARD_SETTLE_MS = 2000; // the dashboard's first /events frame

export interface Cookie { name: string; value: string; domain: string; path: string; httpOnly: boolean; secure: boolean; sameSite: 'Strict' }
export interface PageLike { goto(url: string, options?: { waitUntil?: 'load' }): Promise<{ ok(): boolean } | null>; waitForTimeout(ms: number): Promise<void>; screenshot(options: { path: string }): Promise<unknown> }
export interface ContextLike { addCookies(cookies: Cookie[]): Promise<void>; newPage(): Promise<PageLike> }
export interface BrowserLike { newContext(options: { viewport: typeof VIEWPORT }): Promise<ContextLike>; close(): Promise<void> }
export type Launch = () => Promise<BrowserLike>;

export const launchChromium: Launch = async () => {
  const { chromium } = await import('playwright');
  return chromium.launch({ headless: true });
};

/** The viewer's own cookie for a daemon on `port`. */
export const dashboardCookie = (port: number, secret: string): Cookie =>
  ({ name: secretCookie(port), value: secret, domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Strict' });

/** Opens the dashboard once and keeps a screenshot: a page that does not answer ok means the run did not boot. */
export async function smokeDashboard(launch: Launch, url: string, cookie: Cookie, shot: string): Promise<void> {
  const browser = await launch();
  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    const res = await page.goto(url, { waitUntil: 'load' });
    if (!res?.ok()) throw new Error(`the page answered no ok status: ${url}`);
    await page.waitForTimeout(DASHBOARD_SETTLE_MS);
    await page.screenshot({ path: shot });
  } finally {
    await browser.close();
  }
}

export const storageState = (cookie: Cookie): { cookies: (Cookie & { expires: number })[]; origins: never[] } => ({ cookies: [{ ...cookie, expires: -1 }], origins: [] });
