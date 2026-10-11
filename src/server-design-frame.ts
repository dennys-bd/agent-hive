// The design pane's frame (#108): an authenticated call mints a URL for one Hive design of an activity, and a read-only route serves that
// design's folder under the URL's token, outside the secret gate. A sandboxed frame has an opaque origin and no usable credential, so the
// token is the capability and the route never reads the port's cookie. Every answer carries its own sandboxing policy.
import { bridgeScript } from './design-bridge.js';
import { DESIGN_FRAME_PREFIX, newSecret } from './secret.js';

const HEAD_TAG = /<head\b[^>]*>/i; // \b: <header> is not <head>
const FIRST_ELEMENT = /<[a-z]/i; // a doctype or a comment is not an element: the bridge never lands before it

/** This boot's design frame tokens (#108). Minting a folder again answers its token, so the map stays bounded by the folders the user
 *  opened. Memory only: a restart voids every URL. */
export interface DesignFrameTokens { mint(folder: string): string; folderOf(token: string): string | undefined }

export function createDesignFrameTokens(): DesignFrameTokens {
  const folderByToken = new Map<string, string>();
  const tokenByFolder = new Map<string, string>();
  return {
    mint(folder) {
      const held = tokenByFolder.get(folder);
      if (held !== undefined) return held;
      const token = newSecret(); // 32 random bytes in hex, as the boot's own secret
      folderByToken.set(token, folder);
      tokenByFolder.set(folder, token);
      return token;
    },
    folderOf: (token) => folderByToken.get(token),
  };
}

/** The route's policy (#108). `sandbox` in the header holds even when the URL is opened outside the iframe. 'self' is unreliable in an
 *  opaque origin, so the route is named. Designs are inline-heavy, hence 'unsafe-inline'. frame-ancestors stops another local port from
 *  framing it. */
export function framePolicy(host: string, token: string): string {
  const route = `http://${host}${DESIGN_FRAME_PREFIX}${token}/`;
  return [
    'sandbox allow-scripts', "default-src 'none'", `script-src ${route} 'unsafe-inline' data: blob:`, `style-src ${route} 'unsafe-inline' data: blob:`,
    `img-src ${route} data: blob:`, `font-src ${route} data: blob:`, `media-src ${route} data: blob:`, "connect-src 'none'", "frame-src 'none'",
    "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'",
  ].join('; ');
}

/** The page with the bridge first in its <head>, else before its first element (#108): it runs before the design's own scripts. */
export function withBridge(html: string): string {
  const head = HEAD_TAG.exec(html);
  const at = head ? head.index + head[0].length : Math.max(html.search(FIRST_ELEMENT), 0);
  return `${html.slice(0, at)}${bridgeScript()}${html.slice(at)}`;
}
