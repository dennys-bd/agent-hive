# Agent Hive

Dashboard desktop (Electron) que mantém até N sessões interativas do Claude Code rodando em paralelo, cada uma em sua própria git worktree numa aba do iTerm2, puxando tasks de um board GitHub Projects v2.

## Uso

```sh
pnpm install && pnpm build && pnpm link --global   # uma vez
cd /seu/repo && hive                                # abre o dashboard pra esse repo
```

Sem `hive.config.json` no repo, a janela abre num formulário: escolha o project, as colunas (fila / em andamento / em review), o máximo de workers e o prompt do worker. O arquivo é gravado e o dashboard aparece. "configurar" reabre o mesmo formulário.

## Prompt do worker

Cada worker recebe `promptTemplate` como prompt inicial da sessão `claude`. Placeholders: `{number}`, `{title}`, `{body}`, `{url}`. Um slash command funciona como entrypoint:

```json
"promptTemplate": "/ship #{number}"
```

Default: `Task #{number}: {title}` seguido do body e da instrução de abrir PR com `gh pr create`.

## Config (`hive.config.json`)

| campo | default | onde editar |
|---|---|---|
| `project.owner`, `project.number` | — | formulário |
| `status.queue` / `working` / `review` | `Ready` / `In progress` / `In review` | formulário |
| `maxConcurrent` | `2` | formulário / dashboard |
| `promptTemplate` | ver acima | formulário |
| `port` | `47821` | arquivo (exige restart) |
| `claudeArgs` | `[]` | arquivo (ex.: `["--model", "sonnet"]`) |

Estado de runtime fica em `<repo>/.hive/` (ignorado pelo git via `.git/info/exclude`).

## Desenvolvimento

`pnpm test` (tsc + `node --test`), `pnpm start -- <repo>` (Electron), `node dist/src/run.js <repo>` (servidor sem janela, em `http://127.0.0.1:47821`).

Specs e planos em `docs/superpowers/`; próximos passos em `docs/roadmap.md`.
