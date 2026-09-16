# Agent Hive — comando `hive` e configuração pela interface

Extensão da v1 (`docs/superpowers/specs/2026-09-15-agent-hive-design.md`). Objetivo: dentro de qualquer repositório, rodar `hive` (como se roda `claude`) abre o Agent Hive apontando pra esse repo; se ainda não há `hive.config.json`, a janela abre num formulário que escolhe o GitHub Project e as colunas a partir de listas, grava o arquivo e segue pro dashboard. A mesma tela permite reconfigurar depois.

## Decisões fechadas

| Decisão | Escolha | Motivo |
|---|---|---|
| Entrada | `bin/hive.js` registrado em `package.json` `"bin"`; `pnpm link --global` cria o comando | Sem instalador; o binário do Electron vem do próprio pacote |
| Repo alvo | `argv[2]` ou `process.cwd()` | Espelha `claude` |
| Sem config | O app sobe em modo *setup* em vez de falhar | Configuração pela interface |
| Formulário | Listas carregadas do GitHub (projects do owner; colunas de Status do project) | Sem erro de digitação |
| Campos avançados | `port` e `claudeArgs` só no arquivo; `promptTemplate` editável no formulário (vazio mantém o atual) | preservados ao reconfigurar |
| Reconfigurar | Mesmo formulário e mesma rota, sem restart | Uma superfície só |

## Comando `hive`

`bin/hive.js` (Node, sem deps):

1. `repo = resolve(process.argv[2] ?? process.cwd())`.
2. `electronPath = require('electron')` (o pacote exporta o caminho do binário).
3. `spawn(electronPath, [join(__dirname, '..', 'dist', 'src', 'main.js'), repo], { stdio: 'inherit' })`; sai com o código do filho.
4. Se `dist/src/main.js` não existe: mensagem "rode `pnpm build` primeiro" e exit 2.

`package.json`: `"bin": { "hive": "bin/hive.js" }`. Instalação: `pnpm build && pnpm link --global`.

`main.ts` não muda: já resolve o repo por argv e cai no picker só sem argumento.

## Boot em dois modos (`hive.ts`, `server.ts`)

`bootHive(repo)` sempre sobe o servidor e devolve `{ port, server }`.

- **Config existe**: `loadConfig` → `prepareHiveDir` → `createBoard` → `resolveFields` → `loadState` → `createServer` → `listen` → `boot(aliveSlugs)` → `poll` (v1, inalterado).
- **Config não existe** (`ENOENT` em `hive.config.json`; qualquer outro erro de leitura ou config inválida continua falhando alto): `createServer` em modo setup, `listen` na porta default `47821`. Sem board, sem state, sem poll. `GET /events` responde o SSE com `{ configured: false }` até o setup ser salvo, pra UI não precisar de polling.

`createServer(deps)` passa a aceitar `config?`, `board?`, `state?` ausentes e expõe `configure(config): Promise<void>`, que faz o restante do boot (prepareHiveDir com a porta da config, resolveFields, loadState, boot, poll) e liga as rotas do dashboard. A porta não muda em runtime: se a config salva tiver `port` diferente da porta em uso, o servidor segue na porta atual e a UI avisa "reinicie o Hive pra usar a porta N".

`createServer` recebe um `boardFactory: (config) => Board` (default `createBoard`) pra que o setup seja testável com `fakeExec`.

## Board (`board.ts`)

Duas leituras novas, mesmo `execFile('gh', …)`:

- `listProjects(owner)` — `gh project list --owner <owner> --limit 100 --format json` → `{ number, title, url }[]`, só projects abertos (`closed === false`).
- `listStatusOptions(owner, number)` — `gh project field-list <n> --owner <o> --format json` → `string[]` com os nomes das opções do campo `Status`. Erro se não houver campo `Status` single-select. `resolveFields` passa a reaproveitar essa leitura.

Ambas independem de `resolveFields` ter rodado.

## Rotas de setup

| rota | função |
|---|---|
| `GET /setup` | `{ configured: boolean, repo: string, config?: Config }` |
| `GET /setup/projects?owner=@me` | `listProjects(owner)`; `owner` obrigatório |
| `GET /setup/columns?owner=@me&number=6` | `listStatusOptions(owner, number)` |
| `POST /setup` | corpo `{ project: { owner, number }, status: { queue, working, review }, maxConcurrent, promptTemplate? }` |

`POST /setup`:

1. Lê o `hive.config.json` atual se existir e mescla `port` e `claudeArgs` dele (senão defaults) com o corpo; `promptTemplate` vem do corpo, ou do arquivo/default quando ausente ou em branco.
2. `parseConfig` — erro → 400 `{ error }`.
3. `boardFactory(config).resolveFields()` — coluna inexistente ou `gh` fora → 400 `{ error }` com a mensagem do board (que lista as opções reais).
4. Só então grava `hive.config.json` (write tmp + rename) e chama `server.configure(config)` (primeiro setup) ou `server.reconfigure(config)` (troca o board em memória, mantém slots/queue, faz um `poll`).
5. `200 { ok: true, restartForPort?: number }`.

Falhas de `gh` nas listagens → 502 `{ error: stderr }`. Nenhuma rota de setup grava nada antes do passo 4.

## UI

`index.html` ganha `<form id="setup">`, escondido por padrão, e um botão "configurar" no topo:

- `owner` (texto, default `@me`) + botão "carregar" → `GET /setup/projects` → `<select id="project">` (`#número título`).
- Ao escolher o project → `GET /setup/columns` → três `<select>`: fila, em andamento, em review, pré-selecionados com os nomes atuais quando reconfigurando (ou `Ready` / `In progress` / `In review` se existirem).
- `máx. workers` (número, default 2).
- `prompt do worker` (textarea com o template atual; legenda lista `{number}`, `{title}`, `{body}`, `{url}` e o exemplo `/ship #{number}`; vazio mantém o atual).
- "salvar" → `POST /setup`; erro aparece no próprio form; sucesso esconde o form e mostra o dashboard (e o aviso de porta, se vier).

`app.ts` no load chama `GET /setup`: `configured: false` → form visível, dashboard escondido; `true` → dashboard. "configurar" abre o form preenchido com a config atual. O SSE continua sendo a única fonte do estado do dashboard.

## Testes

- `test/board.test.ts`: `listProjects` (filtra fechados, mapeia campos) e `listStatusOptions` (erro sem campo `Status`) com `fakeExec`.
- `test/setup.test.ts`: `createServer` em modo setup com `boardFactory` fake e repo em `mkdtemp`, exercitando as rotas via `fetch` na porta efêmera:
  - `GET /setup` → `configured: false`.
  - `POST /setup` feliz → arquivo gravado com os valores + defaults, `getState()` inicializado, `GET /setup` → `configured: true`.
  - coluna inexistente → 400 com as opções, arquivo não criado.
  - reconfiguração → arquivo reescrito preservando `port`/`claudeArgs`/`promptTemplate`.
  - `GET /setup/projects` sem `owner` → 400.
- `bin/hive.js`: `node bin/hive.js` com `dist/` ausente → exit 2 e mensagem (teste); caminho feliz manual: `cd /tmp/hive-test-repo && hive`.

## Critério de pronto

1. Num repo sem `hive.config.json`, `hive` abre a janela no formulário; escolher project e colunas nas listas e salvar cria o arquivo e mostra o dashboard com a fila do board, sem reiniciar.
2. Num repo já configurado, `hive` abre direto no dashboard; "configurar" mostra os valores atuais; trocar a coluna da fila e salvar atualiza a fila sem reiniciar.
3. `pnpm test` verde com os testes acima.

## Fora deste spec

`hive init`, editar `port`/`claudeArgs`/`promptTemplate` pela UI, múltiplos repos, publicar no npm, focar a janela existente quando `hive` roda com o Hive já aberto (continua falhando alto por porta em uso).
