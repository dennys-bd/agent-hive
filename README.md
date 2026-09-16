# Agent Hive

Rode várias sessões do Claude Code em paralelo, cada uma numa git worktree própria, puxando tasks de um board — e veja tudo num painel.

O Hive abre até N abas do iTerm2, cada uma com um `claude` trabalhando numa task; quando uma sessão termina, a próxima task da fila entra sozinha. Um card por worker mostra em que ele está, fica amarelo quando o Claude precisa de você e azul quando o PR foi aberto. Você continua respondendo no terminal, como sempre; o Hive só observa (via hooks do Claude Code) e enfileira.

Roda 100% local, sem serviço externo. macOS + iTerm2 por enquanto.

## Como funciona

```
board (GitHub Project ou board.md)
        │ poll
        ▼
  ┌────────────┐  spawn   ┌──────────────────────────┐
  │  Agent Hive │ ───────▶ │ iTerm2 tab: claude --worktree=<task> │
  │  (Electron) │ ◀─────── │   hooks → POST /hooks/event          │
  └────────────┘  status   └──────────────────────────┘
        │ SSE
        ▼
   dashboard (cards + fila)
```

1. O Hive lê a coluna "fila" do board e preenche os slots livres (`maxConcurrent`).
2. Cada worker é `claude --worktree=<slug> "<prompt>"` numa aba nova, com um `hooks.json` injetado por `--settings`: `SessionStart`, `PreToolUse`, `Notification`, `PostToolUse`, `Stop`, `SessionEnd` fazem um `curl` pro Hive.
3. O card muda com os hooks: verde (trabalhando), amarelo (esperando você: permissão, pergunta, idle), azul (`gh pr create` detectado). O item do board vai pra "em andamento" e depois "em review".
4. Sessão encerrada libera o slot; task sem PR volta pra fila.

## Instalação

Requisitos: macOS, iTerm2, Node 24+, pnpm, `claude` (Claude Code) e `gh` autenticado (só pra boards GitHub; `gh auth refresh -s project` uma vez).

```sh
git clone <este repo> && cd agent-hive
pnpm install && pnpm build && pnpm link --global
```

Isso cria o comando `hive` (via `pnpm setup`, se ainda não tiver `PNPM_HOME`).

## Uso

```sh
cd /seu/repo
hive
```

Sem `hive.config.json` no repo, a janela abre num formulário: tipo de board, colunas (fila / em andamento / em review), máximo de workers e o prompt do worker. Salvar grava o arquivo e mostra o dashboard. "configurar" reabre o formulário a qualquer momento.

Na tela: `N/M workers ativos`, o campo `máx. workers` (muda ao vivo), a fila, e um card por slot. Clique num card pra ver a pergunta pendente ou o link do PR e pra pular pra aba do terminal; `kill` derruba o worker e devolve a task pra fila.

## Boards

### GitHub Projects v2

```json
"board": { "type": "github", "owner": "@me", "number": 6 }
```

As colunas são as opções do campo `Status` do project. O Hive move o item entre elas.

### Markdown

```json
"board": { "type": "markdown", "path": "board.md" }
```

O arquivo precisa ter uma tabela com `| id | título | status |` (colunas em qualquer ordem, outras extras permitidas). O resto do arquivo é livre — descreva as tasks abaixo da tabela, seu command do agente acha pelo id. O Hive só reescreve a célula `status`; o resto fica byte a byte igual.

```md
| id  | título              | status      |
|-----|---------------------|-------------|
| T-1 | Login com OAuth     | Ready       |
| T-2 | Página de perfil    | In progress |

## T-1 Login com OAuth
Detalhes que o worker deve ler…
```

Se o arquivo não existe, o setup cria um com uma linha de exemplo em `Done`.

## Prompt do worker

`promptTemplate` é o prompt inicial da sessão. Placeholders: `{id}`, `{title}`, `{body}`, `{url}` (`{number}` = `{id}`). Um slash command do seu repo funciona como entrypoint:

```json
"promptTemplate": "/ship #{id}"
```

Default: `Task #{id}: {title}`, o body e a instrução de abrir PR com `gh pr create`.

## Config (`hive.config.json`)

| campo | default | onde editar |
|---|---|---|
| `board` | — | formulário |
| `status.queue` / `working` / `review` | `Ready` / `In progress` / `In review` | formulário |
| `maxConcurrent` | `2` | formulário / dashboard |
| `promptTemplate` | ver acima | formulário |
| `port` | `47821` | arquivo (exige restart) |
| `claudeArgs` | `[]` | arquivo (ex.: `["--model", "sonnet"]`) |

Arquivos antigos com `project: { owner, number }` continuam aceitos. Estado de runtime fica em `<repo>/.hive/` (fora do git via `.git/info/exclude`).

## Desenvolvimento

```sh
pnpm test                       # tsc + node --test
pnpm start -- /caminho/do/repo  # Electron
node dist/src/run.js /repo      # servidor sem janela em http://127.0.0.1:47821
```

Arquitetura: `src/orchestrator.ts` é um reducer puro (estado + evento → novo estado + efeitos); `src/server.ts` recebe os hooks, roda o reducer e executa os efeitos; `src/boards/*` são os adapters; `src/ui/` é HTML + TS sem framework. Specs e planos em `docs/superpowers/`, próximos passos em `docs/roadmap.md`.

## Limitações conhecidas

- Só macOS + iTerm2 (abas via AppleScript).
- Permissões e perguntas são respondidas no terminal; o dashboard só avisa.
- Sem autenticação: o servidor escuta em `127.0.0.1` e rejeita outros `Host`.
- Trocar de board com workers vivos deixa os slots presos aos ids antigos até eles saírem.
