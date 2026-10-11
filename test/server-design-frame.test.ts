import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeScript } from '../src/design-bridge.js';
import { createDesignFrameTokens, framePolicy, withBridge } from '../src/server-design-frame.js';

test('the token store answers one 64-hex token per folder for the whole boot, and nothing for a token it never minted (#108)', () => {
  const tokens = createDesignFrameTokens();
  const one = tokens.mint('/work/design');
  assert.match(one, /^[0-9a-f]{64}$/);
  assert.equal(tokens.mint('/work/design'), one, 'minting the folder again');
  const other = tokens.mint('/work/other');
  assert.notEqual(other, one);
  assert.deepEqual([tokens.folderOf(one), tokens.folderOf(other), tokens.folderOf('0'.repeat(64))], ['/work/design', '/work/other', undefined]);
  assert.notEqual(createDesignFrameTokens().mint('/work/design'), one, 'another boot, another token');
});

test('framePolicy sandboxes the frame to scripts, names the route in every source it allows, and closes connections, frames, forms and base (#108)', () => {
  const route = 'http://127.0.0.1:4242/design-frame/abc/';
  assert.equal(framePolicy('127.0.0.1:4242', 'abc'), [
    'sandbox allow-scripts', "default-src 'none'", `script-src ${route} 'unsafe-inline' data: blob:`, `style-src ${route} 'unsafe-inline' data: blob:`,
    `img-src ${route} data: blob:`, `font-src ${route} data: blob:`, `media-src ${route} data: blob:`, "connect-src 'none'", "frame-src 'none'",
    "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'",
  ].join('; '));
});

test('withBridge puts the bridge right after <head>, any case or attributes, else before the first element, never before the doctype nor after <header> (#108)', () => {
  const b = bridgeScript();
  assert.equal(withBridge('<!doctype html><html><HEAD lang="en"><title>x</title></HEAD></html>'), `<!doctype html><html><HEAD lang="en">${b}<title>x</title></HEAD></html>`);
  assert.equal(withBridge('<!doctype html><header>top</header><p>x</p>'), `<!doctype html>${b}<header>top</header><p>x</p>`);
  assert.equal(withBridge('just text'), `${b}just text`);
});
