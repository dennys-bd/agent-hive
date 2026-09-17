# Agent Hive — logs persistentes e modo debug

Extensão da v1 (`docs/superpowers/specs/2026-09-15-agent-hive-design.md`), dos boards plugáveis (`2026-09-16-pluggable-boards-design.md`) e do polling (`2026-09-16-board-polling-design.md`). Issue: <https://github.com/dennys-bd/agent-hive/issues/30>.

Hoje o servidor escreve meia dúzia de `console.error` e nada fica gravado; no app Electron nem isso aparece. Hooks recebidos, decisões do orchestrator, chamadas ao `gh` e seus resultados não deixam rastro, então um worker dado como terminado enquanto ainda roda, ou um erro de rate limit, só é visto se alguém estiver olhando o dashboard na hora. O Hive passa a gravar um arquivo de log por repo, com um modo debug que sobe a verbosidade quando for preciso. Só o delta está descrito aqui.

## Decisões fechadas

| Decisão | Escolha | Motivo |
|---|---|---|
| Onde | `<repo>/.hive/hive.log`, um por repo | `.hive/` já é o diretório de runtime (state, prompts, hooks.json) e já sai do git via `.git/info/exclude`. O log fica ao lado do estado que ele explica. Em modo setup (sem `hive.config.json`) o arquivo também existe: o logger cria `.hive/` se faltar |
| Retenção | Por tamanho: ao passar de 5 MB o arquivo vira `hive.log.1` (sobrescrevendo o anterior) e um novo começa | Sem cron, sem datas, no máximo ~10 MB por repo. Uma rotação basta pra ver "o que aconteceu ontem"; quem precisar de mais copia o arquivo |
| Formato | Uma linha por entrada: `<ISO> <NÍVEL> <mensagem>` (`2026-09-17T12:00:00.000Z INFO  poll queue=3`). Texto, não JSON | Legível com `tail -f`, filtrável com `grep`. Mensagens em inglês, com `chave=valor`, espelhando os nomes do código (eventos, effects, status); mensagens de erro vindas do código entram como estão |
| Níveis | `error` < `info` < `debug`. `info` = o que o Hive **fez** (boot, poll, transições de slot, sinal, escritas no board, spawn/kill/exit, erros); `debug` = o que ele **recebeu** (todo evento do reducer, todo `gh` com argv e duração, quota, rate limits) | Em `info` o arquivo conta a história sem ruído de PreToolUse a cada comando do worker; em `debug` dá pra reconstruir a sequência exata que levou a um estado |
| Modo debug | `logLevel: "info" \| "debug"` no `hive.config.json`, default `info`. Lido no boot e em cada `POST /setup` (que relê o arquivo antes de gravar) | Config-driven como todo o resto. Editar o arquivo e salvar o formulário de setup troca o nível sem reiniciar. Não entra no formulário (edição à mão basta pra um botão de diagnóstico); variável de ambiente fica de fora (dois botões pro mesmo interruptor) |
| O que **nunca** entra no log, em nenhum nível | `tool_input`, `tool_response`, `message` de Notification, a pergunta/`result` do worker, o prompt renderizado, stdout do worker, conteúdo do transcript, o JSON da status line, valores de env | Payloads de hook carregam comandos, conteúdo de arquivos e o que o worker disse; o log é sobre o Hive, não sobre o trabalho. Só nomes, ids e contagens: `hook PostToolUse worker=1a2b3c4d tool=Bash` |
| `error` também vai pro stderr | `log.error` grava no arquivo **e** faz `console.error`; `info`/`debug` só no arquivo | Preserva o comportamento de hoje no headless (`pnpm run:headless`) e no terminal que abriu o `hive` |
| Escrita | Síncrona (`appendFileSync`), sem fila; erro de escrita imprime uma vez no stderr e desliga o arquivo (o Hive segue) | Linhas curtas, poucas por segundo; síncrono garante ordem sem chain de promises. Um disco cheio nunca derruba o Hive nem enche o stderr |
| Injeção | `createLogger(dir, level)` em `src/log.ts`; `ServerDeps.log?: Logger` (default: logger real em `<repo>/.hive`); `createBoard(config, { repo, exec, log })` embrulha o `exec` do GitHub pra logar cada chamada | Mesmo padrão de `boardFactory` / `spawnWorker`: o teste passa o seu, o boot passa o real. Sem singleton |
| Transições de slot | Derivadas em `dispatch`, comparando `slots` antes e depois do `reduce`: `slot 1: trabalhando → aguardando_review #30 worker=1a2b3c4d` | Um só lugar cobre toda regra do reducer, atual ou futura, sem espalhar `log.info` pelo orchestrator (que continua puro). É o que torna #23/#26 auditáveis |
| `main.ts`, `run.ts`, `orchestrator.ts`, `workers.ts`, `spawn*.ts` | Não mudam | O reducer fica puro; erros de janela/dock do Electron são do processo, não do Hive; stderr do worker já vai pro painel de saída |
| UI | Nada | O arquivo resolve "não é visível no app"; um visualizador no dashboard é outra issue |

## Config

```json
"logLevel": "info"
```

`parseConfig`: `logLevel` opcional, ∈ `LOG_LEVELS = ['info', 'debug']`, default `'info'`; qualquer outro valor → `hive.config.json: "logLevel" must be one of: info, debug`. `DEFAULT_CONFIG.logLevel = 'info'`. `saveSetup` repassa `logLevel: current?.logLevel` (o formulário não manda; quem chama a API sem mandar mantém o atual). README ganha a linha do campo.

## Types

```ts
// src/log.ts
export type LogLevel = 'info' | 'debug';
export const LOG_LEVELS: readonly LogLevel[] = ['info', 'debug'];
export const LOG_FILE = 'hive.log';
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

export interface Logger {
  error(message: string): void;
  info(message: string): void;
  debug(message: string): void;
  setLevel(level: LogLevel): void;
}

// src/types.ts
interface Config { /* … */ logLevel: LogLevel; }
```

`Task`, `State`, `Slot`, `HiveEvent`, `Effect`, `Board`, `SetupBody` não mudam.

## `src/log.ts`

- `createLogger(dir, level = 'info', options?: { maxBytes?: number; stderr?: (line: string) => void })`: `mkdirSync(dir, { recursive: true })` na criação; guarda o tamanho atual (`statSync`, 0 se não existe) e soma cada linha escrita. Antes de escrever, se `size + linha > maxBytes`: `renameSync(hive.log, hive.log.1)` e `size = 0`.
- Linha: `${new Date().toISOString()} ${LEVEL.padEnd(5)} ${message}\n`. Uma mensagem com quebra de linha é gravada como está (só o `gh` poderia trazer uma, e ela é cortada antes).
- `error` sempre grava e chama `stderr(message)` (default `console.error`); `info` grava quando `level` ∈ {`info`, `debug`}; `debug` só em `debug`.
- Falha de escrita (`EACCES`, `ENOSPC`, …): `stderr('hive.log: <erro>')` uma vez, `disabled = true`, e as chamadas seguintes viram no-op no arquivo (`error` ainda vai pro stderr).
- Helpers puros, exportados e testados:
  - `describeEvent(event: HiveEvent): string` — um resumo sem payload: `hook <hook_event_name> worker=<id8> tool=<tool_name>` (só `tool_name`, nunca `tool_input`), `poll tasks=<n> ids=<até 20 ids>`, `idle worker=<id8>` (sem a pergunta), `exit worker=<id8>`, `kill slot=<id>`, `setSignal <signal>`, `setMax <n>`, `setBudget <json do budget>`, `setUsageRules rules=<n>`, `rateLimits worker=<id8>`, `boardQuota remaining=<r>/<limit> resetsAt=<iso>`, `error <message>`, `boot`.
  - `describeEffect(effect: Effect): string` — `spawn slot=<id> #<taskId> slug=<slug> worker=<id8>`, `setStatus #<itemId> → <key>`, `kill slug=<slug> worker=<id8>`.
  - `describeChanges(prev: State, next: State): string[]` — uma linha por slot cujo `status` mudou (`slot <id>: <antes> → <depois> #<taskId> worker=<id8>`; `#…`/`worker=` só quando existem no slot novo, ou no antigo quando voltou a `vazio`), mais `signal: <antes> → <depois>` quando o sinal mudou. Lista vazia quando nada mudou.
  - `shortId(workerId?: string): string` — os 8 primeiros caracteres do uuid (`-` quando ausente).

## `src/server.ts`

- `ServerDeps.log?: Logger`; default `createLogger(join(repo, HIVE_DIR))`.
- `dispatch`: `log.debug(describeEvent(event))` antes do `reduce`; depois, `for (line of describeChanges(prev, next)) log.info(line)`; `log.debug('effects: ' + effects.map(describeEffect).join('; '))` quando há effects.
- `runEffect`: `setStatus` → `log.info(describeEffect(effect) + ' ok')` após o sucesso (a falha já passa por `fail`); `spawn` → `log.info(describeEffect(effect))` antes de `spawn()`; `kill` → `log.info(describeEffect(effect))`.
- `fail` e `persist` trocam `console.error` por `log.error`. `refreshQuota` idem no catch.
- `poll`: `log.info('poll queue=<n>')` após o `listQueue`. `activate`: `log.setLevel(config.logLevel)`; `log.info('config port=<n> board=<type> workers=<mode> logLevel=<level>')` (sem owner/path: o board já aparece no `gh`). `saveSetup`: `log.info('setup saved')` após `writeConfigFile`. `listen`: `log.info('listening port=<n>')`.
- Rotas de hook com `x-hive-worker` ausente ou `hook_event_name` ausente: `log.debug('hook ignored: no worker id / no event name')`.
- `boardFactory` default: `createBoard(config, { repo, log })`.

## `src/board.ts` e `src/boards/github.ts`

- `BoardDeps.log?: Logger`. Com `log` e sem `exec` injetado, `createBoard` passa `loggedExec(ghExec, log)` ao adapter GitHub; com `exec` injetado, embrulha o injetado do mesmo jeito (o teste vê as linhas).
- `loggedExec(exec, log)` em `src/boards/github.ts`: mede a duração e grava `log.debug('gh <argv> <ms>ms ok')` ou `log.debug('gh <argv> <ms>ms error: <mensagem>')`, relançando o erro. `argv` = `args.join(' ')` cortado em 200 caracteres com `…` (a query GraphQL é longa e cabe inteira só em `debug` de quem quer). Sem log de stdout.
- Markdown: nada a logar além do que `fail` já cobre.

## `src/hive.ts`

- Cria `const log = createLogger(join(repo, HIVE_DIR), config?.logLevel ?? 'info')` antes de tudo e passa a `createServer`. `HIVE_DIR` já é exportado por `hooks-settings.ts`.
- `bootHive`: `log.info('boot repo=<repo> mode=hive')` e, no fallback pro setup, `log.error('board: <mensagem>')` antes de `bootSetupMode`. `bootSetupMode`: `log.info('boot repo=<repo> mode=setup reason=<motivo>')`. Os `console.log` de hoje continuam (o terminal precisa da URL).
- `createBoard(config, { repo, log })` no boot com config.

## Testes (`node:test`)

- `test/log.test.ts`: cria o arquivo e `.hive/` se faltar; formato da linha (regex `^\d{4}-…Z (ERROR|INFO |DEBUG) `); `info` gravado e `debug` omitido em `info`; `setLevel('debug')` passa a gravar; `error` chama o `stderr` injetado e grava; rotação com `maxBytes` pequeno (`hive.log.1` existe com o conteúdo antigo, `hive.log` recomeça); falha de escrita (dir que é um arquivo) → uma chamada ao `stderr`, sem throw, chamadas seguintes silenciosas; `describeEvent` de um `hook` com `tool_input` não contém o conteúdo do `tool_input`; `describeEvent('idle')` não contém a pergunta; `describeChanges` lista a transição de um slot e a mudança de sinal e devolve `[]` sem mudança.
- `test/config.test.ts`: `logLevel` default `info`; valor inválido → erro nomeando o campo.
- `test/server.test.ts`: com um `log` fake injetado (array de linhas), um spawn + PR gera `slot 1: vazio → trabalhando #…` e `… → aguardando_review` em `info`; o `hook` só aparece em `debug` e nunca com `tool_input`; `POST /setup` com um arquivo cujo `logLevel` mudou pra `debug` chama `setLevel('debug')`.
- `test/board.test.ts` ou `test/boards/github.test.ts`: `loggedExec` grava `gh … ok` com o argv cortado e `error:` quando o exec rejeita, relançando.
- README: seção de config ganha `logLevel`; "Runtime state lives in `<repo>/.hive/`" menciona `hive.log`.
