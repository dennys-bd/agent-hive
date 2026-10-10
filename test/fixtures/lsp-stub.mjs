// A language server for the tests (#780): LSP framing on stdio; it counts initialize, echoes, asks the host every server request the Hive
// answers, logs, records the notifications it gets, and dies on hive/crash
let pending = Buffer.alloc(0);
let inits = 0;
let next = 0;
const waiting = new Map();
const notified = [];
const send = (message) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
};
const ask = (method, params) => new Promise((resolve) => { const id = `srv${next++}`; waiting.set(id, resolve); send({ id, method, params }); });
const ASKED = ['workspace/configuration', 'client/registerCapability', 'workspace/workspaceFolders', 'workspace/applyEdit', 'window/workDoneProgress/create', 'window/showMessageRequest', 'hive/unknown'];

async function handle(m) {
  if (m.method === undefined) { waiting.get(m.id)?.(m.error ?? m.result); waiting.delete(m.id); return; }
  if (m.id === undefined) notified.push({ method: m.method, params: m.params });
  if (m.method === 'hive/notified') { send({ id: m.id, result: notified }); return; }
  if (m.method === 'initialize') { inits += 1; send({ id: m.id, result: { capabilities: { hoverProvider: true }, rootUri: m.params.rootUri, folders: m.params.workspaceFolders } }); return; }
  if (m.method === 'hive/count') { send({ id: m.id, result: { inits } }); return; }
  if (m.method === 'hive/echo') { send({ id: m.id, result: { seen: m.id, params: m.params } }); return; }
  if (m.method === 'hive/ask') {
    const answers = {};
    for (const method of ASKED) answers[method] = await ask(method, method === 'workspace/configuration' ? { items: [{}, {}] } : {});
    send({ method: 'window/logMessage', params: { type: 3, message: 'hello log' } });
    send({ method: 'textDocument/publishDiagnostics', params: { uri: 'file:///x', diagnostics: [] } });
    send({ method: '$/progress', params: {} });
    send({ id: m.id, result: answers });
    return;
  }
  if (m.method === 'hive/argv') { send({ id: m.id, result: process.argv.slice(2) }); return; }
  if (m.method === 'hive/env') { send({ id: m.id, result: Object.keys(process.env).filter((k) => /^(HIVE_|NODE_PATH|CLAUDECODE|KEPT)/.test(k)) }); return; }
  if (m.method === 'hive/crash') { process.stderr.write('dying\n'); process.exit(3); }
  if (m.method === 'shutdown') { send({ id: m.id, result: null }); return; }
  if (m.method === 'exit') process.exit(0);
}

process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  for (;;) {
    const end = pending.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(pending.subarray(0, end).toString())[1]);
    if (pending.length < end + 4 + length) return;
    const body = pending.subarray(end + 4, end + 4 + length).toString();
    pending = pending.subarray(end + 4 + length);
    void handle(JSON.parse(body));
  }
});
