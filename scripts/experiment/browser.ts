import { join } from 'node:path';
import { secretCookie } from '../../src/secret.js';

export const VIEWPORT = { width: 1440, height: 900 }; // the handoff's reference size (00-LEIA-ANTES.md)
export const MCP_BIN = join('node_modules', '.bin', 'playwright-mcp'); // @playwright/mcp's bin, under the repo root
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

export function mcpConfig(bin: string, storage: string, outputDir: string, origin: string, chromiumPath: string, socketsDir: string): Record<string, unknown> {
  const args = [
    '--executable-path', chromiumPath, // the Chromium the root playwright installed: --browser chromium would look for chrome-for-testing, which that install lacks
    '--browser', 'chromium', '--headless', '--isolated', '--storage-state', storage, '--output-dir', outputDir, '--viewport-size', `${VIEWPORT.width},${VIEWPORT.height}`,
    '--allowed-origins', origin, // the dashboard only: no file:// or other page the tester could learn the run from
  ];
  // A socket path caps at 104 bytes on macOS: under the long per-user TMPDIR the MCP's own socket folder overflows, so it gets a short one
  return { mcpServers: { playwright: { command: bin, args, env: { PWTEST_SOCKETS_DIR: socketsDir } } } };
}
