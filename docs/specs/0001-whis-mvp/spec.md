---
status: draft
feature: whis-mvp
created: 2026-04-24
shipped: null
---
# Whis MVP — Agente pessoal via WhatsApp com vault Obsidian

**Status:** Draft
**Scope:** Entregar um agente pessoal de IA chamado Whis (em homenagem ao personagem de Dragon Ball), rodando em Docker, que recebe mensagens do Gabriel via WhatsApp (Evolution API), raciocina via Claude Code (OAuth), tem memória durável em vault Obsidian na pasta `context/` do repositório, e responde com a primeira skill `hello-world` que valida o pipeline ponta-a-ponta.

## Context

Este repositório (`project-whis`) hospeda o Whis, um agente pessoal de IA do Gabriel. A visão de longo prazo é ter um agente conversacional acessível por WhatsApp que ajude o Gabriel em tudo — anotações, agenda, hábitos, trabalho, vida pessoal — crescendo gradualmente pela adição de skills (no padrão `agentskills.io`: pasta com `SKILL.md` + arquivos auxiliares) e integrações externas (calendário, email, etc).

O **projeto-base** é `zeno-agent` (`git@github.com:ribeirogab/zeno-agent.git`, clone de referência mantido localmente em `C:\Users\gabri\AppData\Local\Temp\zeno-agent`). O Whis herda do Zeno a filosofia "harness AI" (núcleo pequeno e estável, inteligência mora nas skills) e várias peças concretas de código — `Channel` interface, `AgentBackend` interface, `AgentCore`, `system-prompt.ts`, `mcp.ts`, `ProfileWatcher`, `ClaudeCodeBackend`. Difere do Zeno em três eixos:

1. **Canal:** WhatsApp via Evolution API (Zeno: Slack via Bolt).
2. **Memória durável:** vault Obsidian em pasta `context/` editada manualmente pelo Gabriel e lida/escrita pelo agente (Zeno: pasta `context/` é vault de manutenção do mantenedor, fora do container).
3. **Escopo do MVP:** apenas `apps/worker` (Zeno tem também `apps/api` e `apps/dashboard`). Sem cron runner, sem guardrails de aprovação, sem integração GitHub.

Esta spec cobre **a primeira entrega útil**: a infraestrutura mínima provando que o loop WhatsApp ↔ Whis ↔ Claude ↔ vault funciona, usando uma skill `hello-world` como vetor de validação. Toda a arquitetura é desenhada pra que iterações seguintes (cron, novas skills, integrações) sejam aditivas, sem reescrever o núcleo.

**Decisões fundantes tomadas no brainstorming (2026-04-24):**

- **Onde roda:** processo Node/TS em container Docker, na máquina local do Gabriel. Migração futura pra nuvem prevista mas não necessária agora.
- **Como o LLM é acessado:** `@anthropic-ai/claude-agent-sdk` chamado in-process. Autenticação via `CLAUDE_CODE_OAUTH_TOKEN` env var, gerada uma vez pelo comando `claude setup-token` — **não usa `ANTHROPIC_API_KEY`**. Custo previsível pelo plano. O binário `claude` fica no container só pra rodar `setup-token` quando a OAuth expirar.
- **Arquitetura:** ports & adapters herdados do Zeno. Duas abstrações plugáveis — `Channel` (fontes de mensagem) e `AgentBackend` (modelos/CLIs como Claude Code). MVP implementa uma de cada: `WhatsAppChannel` + `ClaudeCodeBackend`.
- **Ferramentas do agente:** toolset built-in do Claude Code (`Bash`, `Read`, `Glob`, `Grep`, e por padrão SDK também `Write`/`Edit`). **Nenhuma ferramenta custom é escrita no MVP.** O `cwd` do SDK aponta pro vault Obsidian, então as ferramentas nativas operam direto nas notas.
- **Canal WhatsApp:** Evolution API (open-source, baseada em Baileys, popular no BR). Roda em container vizinho no mesmo `docker-compose.yml` que o worker — sem necessidade de IP público ou tunel. Webhook configurado globalmente via env vars da Evolution apontando pra `http://whis-worker:8080/webhook/whatsapp` (DNS interno).
- **Estrutura do projeto:** monorepo Turborepo + pnpm workspaces (paridade com Zeno). Apenas `apps/worker` no MVP; `apps/api` e `apps/dashboard` ficam pra iterações posteriores se houver demanda.
- **Profile:** single profile (`profile/`, sem subpasta `default/`). Multi-profile (Zeno-style `profiles/<name>/`) é refator simples no futuro caso precise.
- **Multi-ambiente trabalho/pessoal:** resolvido cognitivamente — vault organizado em `context/personal/`, `context/work/`, `context/daily/`, `context/templates/` + instruções no `SOUL.md` ensinando o agente a identificar o "modo" pelo conteúdo da pergunta. Sem código adicional.
- **Sessão Claude SDK:** janela rotativa por inatividade. Chave = `chatId` (DM no WhatsApp). Após 6h sem mensagem (`SESSION_IDLE_HOURS=6`), nova sessão; senão resume. Memória durável fica no vault.
- **Storage:** `better-sqlite3` com dois repositórios — `SessionRepo` (mapa `chatId → {sessionId, lastMessageAt}`) e `MessageRepo` (auditoria inbound/outbound). Banco persistido em volume Docker `whis_data` em `/app/data/whis.db`.
- **Webhook HTTP:** Hono embutido no worker, porta 8080 interna. Rotas `POST /webhook/whatsapp` (recebe eventos da Evolution) e `GET /health` (liveness).
- **Reactions:** `react`/`unreact` implementados via Evolution `POST /chat/sendReaction` (mapa nome→emoji: `eyes` → 👀). `waitForReaction` é no-op. No `AgentCore`, divergência do Zeno: somente `react('eyes')` na chegada e `unreact('eyes')` no fim — sem `react('white_check_mark')` nem `react('warning')`, conforme preferência do Gabriel (a mensagem de resposta já sinaliza sucesso/erro).
- **Idioma das respostas:** PT-BR por padrão.

## Problem Statement

Hoje, o Gabriel não tem um único canal contínuo onde possa pedir ajuda em qualquer assunto pessoal ou profissional, com uma IA que entenda seu contexto, lembre de coisas importantes, e ainda esteja sempre acessível. Pra anotações usa Obsidian (no desktop). Pra perguntas técnicas usa Claude Code/ChatGPT (no desktop). Pra agenda usa o calendário. Pra hábitos, mente. Cada coisa em um app diferente, sem agregação.

O MVP resolve **um corte fino** desse problema: provar que o pipeline `WhatsApp → Whis → Claude → vault Obsidian → resposta no WhatsApp` funciona ponta-a-ponta, com uma skill mínima (`hello-world`) que apenas cumprimenta o Gabriel pelo nome (lido de `USER.md`). Esse corte é escolhido porque:

- Exercita todas as camadas (canal, normalize, agent core, backend Claude, system prompt, skills, reactions, sessão SDK, logging).
- É de baixíssimo risco — `hello-world` não escreve no vault, não chama APIs externas, não toma decisões.
- Valida a escolha de Evolution API + Claude OAuth + Obsidian como pilares antes de investir em skills mais complexas (calendário, hábitos, anotações).
- A generalização pra próximas skills é quase gratuita — adicionar uma skill nova é criar uma pasta com `SKILL.md`; o core do Whis não muda.

## Non-Goals

Explicitamente **fora do MVP** (não serão implementados nesta entrega):

1. **Cron runner / tarefas agendadas.** Sem lembretes proativos, sem `daily-briefing`. Entra na primeira iteração que tiver uma skill demandando (ex: `daily-habits`).
2. **Skills além do `hello-world`.** Calendário, hábitos, anotações, integração com email/calendar — todos fora. Cada skill futura é uma iteração própria.
3. **`apps/api` e `apps/dashboard`.** Sem painel web, sem endpoints REST além do webhook. Operação é por `pnpm run docker:logs` e edição manual de arquivos.
4. **Guardrails / aprovação humana de tools.** Sem `HaikuClassifier`, sem `SlackApprover` (que vira `WhatsAppApprover` no futuro). `permissionMode: 'bypassPermissions'` — o agente executa todas as tools sem confirmação.
5. **Multi-profile.** Estrutura `profile/` única. Refator pra `profiles/<name>/` quando o Gabriel comprar outro chip ou quiser isolamento físico de contextos.
6. **Múltiplos números de WhatsApp / múltiplos usuários.** Whitelist de um único número (`WHATSAPP_OWNER_NUMBER`). Mensagens de outros números são silenciosamente ignoradas com log `dm_ignored_non_owner`.
7. **Grupos do WhatsApp.** Apenas DM 1:1 com o Gabriel. Eventos de grupo são ignorados.
8. **Mídias (áudio, imagem, documento, vídeo).** Apenas mensagens de texto. Mídia entra em iteração futura quando uma skill demandar.
9. **Outros canais** (Telegram, Slack, Discord). A interface `Channel` existe, só `WhatsAppChannel` é implementada.
10. **Outros backends** (Codex, Gemini, Anthropic API direta). A interface `AgentBackend` existe, mas só `ClaudeCodeBackend` (e `MockBackend` pra dev).
11. **Streaming de resposta no WhatsApp.** Resposta final é uma única mensagem; sem "digitando..." intermediário, sem mensagens incrementais.
12. **`waitForReaction` funcional.** Implementado como no-op (retorna `null`). Só guardrails usariam — e guardrails estão fora.
13. **Retenção/expiração do `messages` log.** Tabela cresce indefinidamente no MVP. Quando incomodar, adiciono `MessageRetention` análogo ao `LogsRetention` do Zeno.
14. **Sincronização do vault entre máquinas.** Responsabilidade do Gabriel via Obsidian Sync / Syncthing / iCloud / Dropbox apontando pra `<repo>/context/`. Whis não opina.
15. **CI/CD, métricas, dashboards, alertas.** Logs JSON em stdout (`pnpm run docker:logs`) são suficientes pro MVP.
16. **Testes E2E reais** (Evolution + Claude reais). Apenas unit tests com `MockBackend`. Validação final é smoke test manual seguindo o README.
17. **Idempotência completa de webhooks.** Evolution pode retentar o mesmo evento; aceito o risco de duplicação rara no MVP. Fix planejado (UNIQUE em `messages.message_ref` + dedupe na entrada) é pós-MVP.
18. **Commit da spec/código no git.** O diretório `project-whis/` ainda não é um repositório git. Inicializar git é primeira tarefa do plano de implementação.

## Constraints

**Técnicas:**

- Precisa rodar em Docker desde o início (portabilidade pra cloud no futuro).
- Precisa usar Claude Agent SDK com OAuth, não API key — implica instalar `claude` CLI no container (pra `setup-token`) e manter `CLAUDE_CODE_OAUTH_TOKEN` no `profile/.env`.
- Primeiro `setup-token` é manual e interativo (abre URL no browser do host, copia token pro `.env`). Documentado no README.
- Evolution API exige WhatsApp Web pareado com QR code. Pareamento é manual e único; sessão persiste no volume `evolution_instances`.
- O Claude Code CLI exige user não-root (uid 1000 = `node` no container). Já é o padrão no Dockerfile derivado do Zeno.
- Stack: TypeScript + Node 24 LTS, pnpm 10, Turborepo, Biome (lint+format), Vitest (testes), Knip (unused exports). Mesma versão do Zeno.
- Container deve ter `git`, `python3`, `build-essential`, `node`, `claude` instalados. Sem `gh`, sem AWS CLI, sem `unzip` (não precisamos no MVP).

**Organizacionais:**

- Gabriel tem plano Claude Pro/Max. OAuth via plano cobre uso pessoal sem cobrança por token.
- Gabriel já tem chip de WhatsApp pessoal — vai ser pareado na Evolution. Risco de ban por uso intenso é baixo (uso pessoal individual), mas conhecido.
- Nenhum compromisso de SLA — ferramenta pessoal, "quebrou? arrumo de noite".

**De arquitetura (para evitar débito técnico imediato):**

- `AgentCore` **não pode importar** nada específico de WhatsApp, Evolution, ou Claude. Só conhece os tipos de `channels/types.ts` e `agent/types.ts`.
- `WhatsAppChannel` é o único módulo que conhece a Evolution API. Toda interação com Evolution passa pelo `evolution-client.ts`.
- Tools são built-ins do Claude Code; **pasta `tools/` não existe** no MVP. Adicionar tool custom será justificado por necessidade concreta de skill futura.
- Segredos (tokens, API keys) **nunca commitados**. `profile/.env` no `.gitignore`; `profile/.env.example` versionado.
- Vault Obsidian (`context/`) **gitignored**. `context.example/` versionado serve de seed.
- Worker é único writer do `whis.db` — sem locks concorrentes, sem necessidade de pool. `journal_mode=WAL` ainda assim, por hábito e pra facilitar debug com leitor externo.

**De comunicação com o usuário:**

- Idioma: PT-BR por padrão. Whis muda de idioma se Gabriel falar em outro.
- Tom: direto, prático, humor leve quando couber. Pegada do personagem Whis (Dragon Ball): calma, polida, levemente irônica, eficiente.
- Formato: Markdown WhatsApp (`*bold*`, `_italic_`, `~strike~`, `` `code` ``). Sem blocos de código gigantes (WhatsApp renderiza mal). Mensagens curtas. Quebra de parágrafos curtos.

## User Stories / Scenarios

**S1 — Caminho feliz (vetor de validação):**

1. Gabriel manda no WhatsApp do Whis: `oi`.
2. Evolution API recebe via sessão WhatsApp Web e POSTa `http://whis-worker:8080/webhook/whatsapp` com o evento `messages.upsert`.
3. Whis responde com `react('eyes')` → 👀 aparece na mensagem original do Gabriel dentro de 2s.
4. `WhatsAppChannel` normaliza, `AgentCore` consulta `SessionRepo`, monta system prompt com SOUL+USER+skills always-active, chama `ClaudeCodeBackend.query()`.
5. Claude SDK roda com `cwd=/app/context`, identifica que é uma saudação, ativa skill `hello-world`, gera resposta.
6. `AgentCore` chama `channel.send(target, text)` → Evolution `POST /message/sendText/whis` → mensagem aparece no WhatsApp do Gabriel: `"E aí, Gabriel. Aqui é o Whis. Tudo tranquilo no universo de hoje? Em que posso ajudar?"`.
7. Whis faz `unreact('eyes')` — 👀 desaparece. `MessageRepo` grava in/out com `correlationId`. `SessionRepo.upsert(chatId, sessionId, now)`.
8. Logs estruturados mostram a sequência completa em `pnpm run docker:logs`.

**S2 — Mensagem de número não autorizado:**

1. Outro número manda mensagem pro WhatsApp pareado do Whis.
2. Evolution recebe e POSTa o webhook normalmente.
3. `normalize.ts` checa `WHATSAPP_OWNER_NUMBER` — não bate.
4. Mensagem é silenciosamente descartada com log `dm_ignored_non_owner`. Nenhuma reação no WhatsApp, nenhuma resposta. Outro número não percebe que existe um bot ali.

**S3 — Modo cognitivo (work/personal):**

1. Gabriel manda: `me lembra que tenho reunião com cliente X amanhã às 14h`.
2. Skill `hello-world` não bate com a descrição. Claude responde livremente seguindo o `SOUL.md`.
3. SOUL.md instrui a identificar o modo pelo conteúdo: "reunião com cliente" → modo `work`. Em uma versão futura com skill de notas, o agente escreveria em `context/work/lembretes.md`. No MVP (sem essa skill), o agente responde em PT-BR confirmando que entendeu, mas avisa que ainda não tem ferramenta pra agendar — sugere o Gabriel anotar manualmente no Obsidian.
4. Validação: o agente identifica corretamente o modo `work` em vez de `personal`. Comportamento confirmado por inspeção da resposta.

**S4 — Pergunta genérica fora do escopo do vault:**

1. Gabriel: `qual a capital do Peru?`
2. Skill `hello-world` não bate. Claude responde naturalmente ("Lima"), sem invocar tool.
3. Whis posta resposta. Não há erro, apenas uso do LLM puro sem ferramenta.

**S5 — Token Claude expirado:**

1. Gabriel: `oi`
2. `ClaudeCodeBackend.query()` lança `AgentBackendError` com `kind: 'auth_expired'`.
3. `AgentCore` captura, traduz via `translateError()`, envia: *"meu token Claude expirou. Roda `pnpm run docker:setup-token`, cola o novo no `profile/.env` e `pnpm run docker:up -d --force-recreate`."*
4. Faz `unreact('eyes')`. Logs registram `warn` com `correlationId`.

**S6 — Boot do container:**

1. Gabriel preenche `profile/.env` (incluindo `CLAUDE_CODE_OAUTH_TOKEN` gerado por `pnpm run docker:setup-token`), copia `context.example/` pra `context/`, e roda `pnpm run docker:up`.
2. Evolution API inicia primeiro (depends_on). Whis worker inicia em sequência.
3. Worker: `boot_start` → valida env (Zod) → abre DB → aplica migrations → carrega SOUL/USER/skills → carrega MCP → ping Evolution → `whis_online`.
4. `evolution:setup` script é rodado — cria a instância "whis", imprime QR code. Gabriel escaneia no app WhatsApp → Aparelhos conectados.
5. Smoke test: Gabriel manda `oi` → S1 funciona.

**S7 — Hot-reload do prompt:**

1. Gabriel edita `agent/SOUL.md` ou `profile/USER.md` no host (ex: VS Code).
2. `ProfileWatcher` detecta mudança em até 250ms (debounce), recompõe `systemPrompt`, registra log `system_prompt_reloaded`.
3. Próxima mensagem do Gabriel já usa o prompt atualizado. Sem precisar reiniciar o container.

## Success Criteria

Esta entrega está **pronta** quando todos os seguintes são observáveis numa máquina limpa do Gabriel:

1. `git init && git add . && git commit -m "init"` no repositório `project-whis/`. (O diretório vira repo git como primeira tarefa do plano.)
2. `pnpm install` na raiz instala as dependências sem erro (workspaces `apps/worker`, `packages/storage`, `packages/logger`).
3. `pnpm run quality-gate` passa: `biome lint`, `tsc --noEmit`, `vitest run`. Cobertura inclui ao menos os seguintes arquivos de teste:
   - `apps/worker/src/agent/system-prompt.test.ts` — `buildSystemPrompt` com SOUL/USER/skills variando (presentes, ausentes, defaults).
   - `apps/worker/src/agent/mcp.test.ts` — merge agent/profile, interpolação `${VAR}`, override.
   - `apps/worker/src/agent/core.test.ts` — `bind` com `MockBackend`; reactions (👀 on/off); session create/resume; expira em `SESSION_IDLE_HOURS`; `translateError`; ignorar `dm_ignored_non_owner`.
   - `apps/worker/src/channels/whatsapp/normalize.test.ts` — fixtures Evolution: DM válida → `IncomingMessage`; não-mensagem → null; número fora da whitelist → null.
   - `apps/worker/src/channels/whatsapp/format.test.ts` — markdown Claude → WhatsApp.
   - `apps/worker/src/webhook/server.test.ts` — payload válido aciona handler; 400 em malformado; 401 em apikey errado; `/health` retorna ok.
   - `apps/worker/src/profile/watcher.test.ts` — debounce + classificação por arquivo (herdo do Zeno).
   - `apps/worker/src/agent/backends/claude-code.test.ts` — smoke (mock `query()` do SDK), classificação de erros.
   - `packages/storage/src/session-repo.test.ts` — get/upsert/delete; janela rotativa.
   - `packages/storage/src/message-repo.test.ts` — insert/recent ordenado.
4. `cp profile/.env.example profile/.env` + `cp profile/USER.example.md profile/USER.md` + `cp profile/mcp.example.json profile/mcp.json` + `cp -r context.example context` produzem um setup funcional após o Gabriel preencher os campos `EVOLUTION_API_KEY` e `WHATSAPP_OWNER_NUMBER`.
5. `docker volume create claude_home` cria o volume externo (uma vez na vida).
6. `pnpm run docker:build` builda imagem `whis-worker:dev` sem erro.
7. `pnpm run docker:setup-token` abre URL no browser, completa OAuth, imprime token; cola no `.env` e o SDK consome em `pnpm run docker:up` subsequente.
8. `pnpm run docker:up` sobe os 2 containers (`evolution-api` e `whis-worker`) e ambos ficam `up`.
9. `pnpm run evolution:setup` cria instância "whis" na Evolution, renderiza QR code no terminal; Gabriel escaneia → sessão fica `open`.
10. `pnpm run docker:logs` mostra o log final `whis_online` no worker.
11. **S1 (caminho feliz) funciona ponta-a-ponta** em menos de 30 segundos em **steady state** (turno seguinte ao primeiro após boot, com sessão SDK aquecida): `oi` no WhatsApp → 👀 reação → resposta personalizada do `hello-world` em PT-BR mencionando o nome do Gabriel (lido de `USER.md`) → 👀 sai. **Cold start** (primeira mensagem após `docker:up`) pode levar 45-60s; aceitável.
12. **S2** funciona — número não autorizado é silenciosamente ignorado, log `dm_ignored_non_owner` aparece.
13. **S5** (token expirado) produz a mensagem de erro corretamente traduzida (forçar manualmente colocando `CLAUDE_CODE_OAUTH_TOKEN=invalid` valida).
14. **S7** (hot-reload) funciona — editar `agent/SOUL.md` muda o tom da próxima resposta sem reiniciar.
15. Logs JSON estruturados em stdout, com sequência esperada (`message_received` → `session_resumed`/`session_started` → `backend_started` → `backend_completed` → `response_sent`), todos com `correlationId` consistente por turno.
16. `profile/.env`, `profile/USER.md`, `profile/mcp.json`, e `context/` estão no `.gitignore` — nada confidencial vaza no commit.
17. `README.md` documenta o setup completo (passos 1-11) e os comandos do dia-a-dia (`docker:up`, `docker:down`, `docker:logs`, `docker:sh`, `docker:setup-token`, `evolution:setup`, `evolution:logs`).
18. `AGENTS.md` na raiz orienta o Claude Code (rodando localmente pelo Gabriel pra editar o projeto) sobre convenções, comandos, e onde achar specs/learnings — paridade com o Zeno.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Conhecimento do modelo (Claude) é de janeiro/2026 e estamos em abril/2026 — APIs de Claude Agent SDK, Evolution API, Hono, e libs auxiliares podem ter mudado. | **Task 0 do plano de implementação é discovery obrigatório** — verificar docs oficiais atuais de cada dependência antes de codar. Se algo mudou materialmente, voltar pra spec e ajustar. Formalizar esse passo como convenção do projeto após o MVP. |
| Token OAuth do Claude expira sem aviso prévio claro. | Detectar erro de auth no `ClaudeCodeBackend`, classificar como `kind: 'auth_expired'`, traduzir em mensagem no WhatsApp com instruções (S5). |
| Primeiro `setup-token` via Docker exige copiar URL do terminal pro browser do host e colar token de volta no `.env` — fluxo chato. | README documenta explicitamente. UX pobre é aceitável; setup é único (e por-renovação). |
| Pareamento WhatsApp Web exige QR code que expira em ~60s. Conexão pode cair se o Gabriel demorar. | Script `evolution:setup` re-renderiza o QR ao detectar expiração. Se cair em runtime, Evolution reconecta automaticamente; se sessão for invalidada (logout no app), Gabriel re-pareia rodando `evolution:setup` novamente. |
| Banimento da conta WhatsApp por uso de bot via Web (Evolution usa Baileys, que é unofficial). | Risco real mas baixo pra uso pessoal individual. Documentar no README. Mitigação futura: migrar pra WhatsApp Business Cloud API (paga, oficial). Não bloqueia MVP. |
| Evolution API retenta webhooks em falha de rede — pode causar resposta duplicada. | Aceito no MVP (uso pessoal, falhas raras). Fix planejado pós-MVP: UNIQUE em `messages.message_ref` + dedupe na entrada do webhook. |
| `bypassPermissions` deixa o agente executar qualquer Bash/Write sem confirmação — risco de comando destrutivo no vault. | Mitigado por: (a) `cwd=/app/context` (vault) + SOUL.md instruindo a não sair da pasta nem mexer em `/app/agent`, `/app/profile`, `/app/data`; (b) container = sandbox sem acesso ao host além dos volumes montados; (c) regras absolutas de segurança no SOUL.md proíbem `rm -rf` fora do vault e exigem confirmação pra ações irreversíveis. Guardrails entram em iteração futura se incomodar. |
| Janela de sessão de 6h pode ser curta demais (perder contexto de uma conversa que volta às 8h da noite após a manhã) ou longa demais (custo de sessão grande). | `SESSION_IDLE_HOURS` é env var configurável. Gabriel ajusta após uso real. Default 6h é um chute fundamentado, não sagrado. |
| Vault `context/` cresce e o agente lê em excesso, gastando tokens ou ficando lento. | Memória durável é explícita: o agente só lê quando uma skill ou pergunta demanda. SOUL.md orienta a não escanear o vault inteiro a cada turno. Quando crescer demais, skill `recall` futura indexa. |
| Rate limit do plano Claude pode bater em uso intenso. | Detectar erro específico no `ClaudeCodeBackend`, classificar `kind: 'rate_limited'`, traduzir em mensagem ("bati o limite, tenta daqui a pouco"). Não é bloqueador — é feedback claro. |
| Webhook do Whis fica acessível a qualquer container na rede do compose (Evolution + worker). | Validação opcional de `apikey` header no Hono handler (mesma key da Evolution). Suficiente pra evitar erros de config; em rede privada Docker é zero risco real. |
| **Anthropic atualizou em fev/2026 a política de uso do Agent SDK proibindo OAuth de Free/Pro/Max em agentes programáticos.** O Whis usa exatamente esse caminho via `CLAUDE_CODE_OAUTH_TOKEN`. Tecnicamente funciona em abril/2026, mas pode ser revogado a qualquer momento (issue oficial em aberto: `anthropics/claude-code#42106`). | Aceitar risco no MVP (uso pessoal individual, baixa visibilidade). Fallback trivial: trocar pra `ANTHROPIC_API_KEY` muda só env var — o SDK resolve a precedência de auth sozinho, código não muda. README documenta o risco e o procedimento de troca. Validado em discovery 2026-04-25. |

## Open Questions

Nenhuma bloqueante. Todos os itens elencados originalmente como "possíveis surpresas do discovery" foram resolvidos em 2026-04-25; ver `docs/specs/0001-whis-mvp/discovery-notes.md` pro detalhe completo.

Resolvidos pela discovery (2026-04-25):

- ✓ **Imagem Evolution:** `atendai/evolution-api` foi abandonada; trocado para `evoapicloud/evolution-api:v2.3.7` (mesma equipe, conta nova). Endpoints/schema do webhook preservados.
- ✓ **Endpoints e schema do webhook Evolution:** confirmados sem mudanças (`WEBHOOK_GLOBAL_URL`, `messages.upsert` com `data.key.remoteJid`/`data.key.fromMe`/`data.key.id`, `data.message.conversation`).
- ✓ **Política OAuth do Agent SDK:** mudou em fev/2026 (proibida pra agentes programáticos). Aceito como risco — ver tabela "Risks and Mitigations".
- ✓ **better-sqlite3** 12.9.0 compatível com Node 24 (glibc/`node:24-slim`); musl exigiria rebuild — não é o caso.
- ✓ **Hono** 4.12.15 ainda recomendado, sem mudança de sintaxe.
- ✓ **Claude Agent SDK** 0.2.119 (saltou minor desde 0.1.4x). Contrato `query()` preservado. Novidades opcionais (`sessionStore`, `title`, `agents`, `managedSettings`) não usadas no MVP.
