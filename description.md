# Claude Fleet — Dashboard visual para orquestração de workers paralelos no Claude Code

## Objetivo
Aplicativo desktop (Electron) que visualiza e controla múltiplas instâncias do Claude Code rodando em paralelo, cada uma isolada numa git worktree, pegando tasks de um board. Substitui o fluxo manual de "1 task por vez, esperando PR" por um pipeline com N workers simultâneos, com status ao vivo e fila automática.

## Stack
- **Electron** (processo principal em Node.js cuida de tudo que não é UI)
- **Express** embutido no processo principal, expondo endpoints HTTP locais que os *hooks* do Claude Code chamam
- **child_process** para spawnar cada sessão `claude --worktree <slug>`
- Renderer simples (HTML/CSS/JS puro é suficiente pra v1 — sem framework)

## Arquitetura (3 componentes)

**1. Servidor de hooks** (`src/hookServer.js`)
Escuta em `localhost:<porta>` e expõe endpoints que os hooks do Claude Code chamam via `curl`/HTTP a cada evento do ciclo de vida da sessão:
- `POST /hooks/worktree-create` — registra um novo worker (path da worktree, branch, sessionId)
- `POST /hooks/worktree-remove` — remove o worker do estado
- `POST /hooks/notification` — Claude está esperando input (permissão, pergunta, idle) → muda status pra "esperando você"
- `POST /hooks/stop` — sessão parou de rodar → decide se foi "terminou task" (libera slot, chama próximo da fila) ou só pausa

**2. Orquestrador / fila** (`src/orchestrator.js`)
Estado em memória (persistido em `queue.json`), com estes campos:
- `workers`: lista de objetos com `id`, `taskId`, `taskTitle`, `status`, `worktreePath`, `branch`, `startedAt`
- `queue`: lista de tasks aguardando slot, com `id`, `title`, `spec`
- `maxConcurrent`: número configurável na UI

Regra central: sempre que um slot libera (worker termina/PR sobe) OU o `maxConcurrent` é aumentado, o orquestrador tenta preencher slots vazios puxando o próximo item da fila e chamando `spawnWorker(task)`. `spawnWorker` roda `git worktree add` + `claude --worktree <slug> -p "<prompt da task>"` como processo filho e registra o worker.

**3. UI / renderer** (`src/renderer/`)
Recebe atualizações do orquestrador via IPC (`ipcMain`/`ipcRenderer`) e desenha:

- **Topo:** "N/M workers ativos" + campo numérico editável para `maxConcurrent`
- **Grid central ("chão de fábrica"):** um card fixo por slot (M cards no total, não uma lista dinâmica), cada um em um dos estados:
  - `vazio` — cinza, sem task
  - `trabalhando` — verde, mostra título da task + branch + última ação
  - `esperando_voce` — amarelo, piscando; é o estado que precisa saltar aos olhos
  - `aguardando_review` — azul, PR aberto
- **Fila lateral/rodapé:** próximas tasks aguardando slot, em ordem
- Clicar num card `esperando_voce` ou `aguardando_review` abre um painel lateral com detalhe (a pergunta pendente / link do PR)

## Escopo da v1 (não fazer mais que isso agora)
- Board de entrada = um `board.json` local simples (`{id, title, status}`), sem integração ainda com Notion/Linear/GitHub Issues — isso é plugável depois
- Aprovação de spec/plan/permissão é **notificação passiva** (o card fica amarelo, você ainda responde no terminal/IDE). Aprovação inline (responder direto pelo dashboard, segurando a resposta do hook) fica marcada como extensão de v2 — não implementar agora
- Sem multi-máquina, sem autenticação, roda 100% local

## Configuração dos hooks (referência)
No `settings.json` do Claude Code, cada hook relevante deve rodar um `curl` simples apontando pros endpoints acima, passando os dados do evento (sessionId, worktree path, mensagem) como JSON no corpo. Ver a doc oficial de Hooks (`code.claude.com/docs/en/hooks`) para o payload exato de cada evento (`Notification`, `WorktreeCreate`, `WorktreeRemove`, `Stop`).

## Critério de pronto (v1)
- Consigo setar `maxConcurrent = 3`, ter 5 tasks no `board.json`, e ver 3 slots ocuparem automaticamente, os outros 2 ficarem na fila
- Quando um worker termina (ou eu mato manualmente pra testar), o próximo da fila entra sozinho
- Um card fica visualmente amarelo quando a sessão correspondente dispara uma `Notification`