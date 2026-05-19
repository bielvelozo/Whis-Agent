---
feature: habit-tracking
spec: "[[spec]]"
plan: "[[plan]]"
created: 2026-05-18
---
# Discovery — Habit Tracking (0006)

**Data:** 2026-05-18

## 1. contextDir em runtime

**Variável de config:** `config.workspaceDir` (`apps/worker/src/config.ts:74`).
**Env:** `WORKSPACE_DIR` (zod default `'/app/context'` em `config.ts:30`).
**Path no container:** `/app/context`.
**Montagem (compose):** `./context:/app/context` (`infra/docker-compose.yml:54`).
**Permissões:** volume host-bind, dono = usuário do compose. No container roda como `node:node` (Dockerfile padrão). Write em subdir é OK (mesmo padrão usado pelas skills do vault).

**Decisão pro renderer:** o `dashboardPath` passado a `createHabitsMcpServer` será `join(config.workspaceDir, 'habits', 'dashboard.md')`. O handler `habit_render_dashboard` cria o diretório `habits/` com `mkdirSync(..., { recursive: true })` se não existir.

**Veredito:** OK pra prosseguir.

## 2. Tool routing cross-skill no dispatchSynthetic

Pesquisa em `apps/worker/src/agent/backends/claude-code.ts`:

- Linha 25: `inProcessMcpServers?: Record<string, InProcessMcpServer>`
- Linha 49: armazenado como field `this.inProcessMcpServers`
- Linha 171: `...(this.inProcessMcpServers as Record<string, McpServerConfig>)` espalhado dentro do `mcpServers` passado pra SDK em **toda** chamada `query()`.

Isso significa que o `ClaudeCodeBackend` **não filtra por skill** — todos os servers in-process registrados ficam disponíveis em qualquer turn. `AgentCore.dispatchSynthetic` (criado em spec 0004) reusa o mesmo `backend.query()`, portanto qualquer prompt sintético tem acesso completo às tools de `habits` (incluindo `habit_today_status`) sem mudança no backend.

**Decisão prática:** o payload do scheduled-message agent criado pelo Whis no fluxo de `habit_create` (lembrete pré-emptivo) pode chamar `habit_today_status(habitId=X)` diretamente. Sem mudança em `ClaudeCodeBackend`, `core.ts` ou `scheduler/dispatcher.ts`.

**Veredito:** OK pra prosseguir.

## 3. Rendering Unicode no Obsidian

**Emojis propostos pro heatmap:** ✅ (feito) · 🟧 (parcial) · ⬜ (pendente) · ▫️ (fora do dia).

Todos os 4 são suportados nativamente pelo Obsidian (renderer usa fontes do sistema operacional + emoji set). Não há validação live aqui — confirmar visualmente na Task 11 (smoke H8). Se algum tiver problema de alinhamento ou render, fallback:
- `▫️` → `·`
- `🟧` → `▣`
- `✅` → `■`
- `⬜` → `□`

**Decisão pro renderer:** seguir com a lista atual (✅ 🟧 ⬜ ▫️). Trocar só se H8 mostrar problema.

## 4. Open questions resolvidas pelo Gabriel

- **Janela do `habit_log_undo`:** 5min (default proposto na spec, confirmado tacitamente — sem feedback).
- **Dashboard:** 1 arquivo único `context/habits/dashboard.md` (default da spec).
- **Granularidade do heatmap:** inclui nível parcial (`🟧`) pra hábitos quantity/duration abaixo do target — adiciona valor visual de "fez algo, mas não bateu meta".
- **Lembrete já-feito:** silencia totalmente (log estruturado, sem mensagem) — fechado na conversa.
- **Check-in noturno com zero pendências:** mensagem positiva curta. Decidido no SKILL.md (Task 10).
