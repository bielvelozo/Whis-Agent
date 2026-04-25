---
status: draft
feature: google-calendar-skill
created: 2026-04-25
shipped: null
---
# Skill `google-calendar` — Whis com agenda Google integrada

**Status:** Draft
**Scope:** Adicionar a primeira skill funcional do Whis: agendar/consultar/editar/cancelar eventos no Google Calendar do Gabriel via MCP server `@cocal/google-calendar-mcp` (nspady/google-calendar-mcp v2.6.x). Suporta múltiplas accounts (`personal` + `work`), timezone Brasil em toda operação, e enforce de protocolo de confirmação antes de qualquer escrita. Skill `hello-world` (validação de pipeline do MVP) é aposentada nessa entrega — google-calendar vira a primeira skill ativa.

## Context

A spec 0001 (MVP) entregou o pipeline `WhatsApp/Telegram → Whis → Claude → vault` ponta-a-ponta com a skill `hello-world` apenas validando que tudo subia. A spec 0002 (Telegram channel) entregou o canal alternativo que tornou o agente usável dia-a-dia. Agora chegou a hora da **primeira skill de produtividade real**: integração com o Google Calendar pra Whis virar interlocutor da agenda do Gabriel — consultar próximos eventos, criar reuniões, adiar, cancelar, e responder a convites — tudo via Telegram com confirmação humana antes de qualquer write.

A escolha por **MCP server** (em vez de skill markdown que usa Bash + `gcalcli` ou skill TS com scripts ad-hoc) é deliberada: (1) é o padrão atual do Claude Agent SDK; (2) auth, rate limits, retries, refresh de tokens ficam encapsulados na lib; (3) o Whis recebe as tools do servidor automaticamente — `agent/mcp.json` declara, SDK descobre. Skills markdown só precisam ensinar **quando/como usar** as tools, não implementar I/O.

A escolha do MCP específico (`@cocal/google-calendar-mcp` da nspady) foi pesquisada em 2026-04-25: 1101 ⭐, atualizado mar/2026, 12 tools cobrindo CRUD completo + multi-account nativo + multi-calendar + free/busy. Trade-off conhecido: a lib **não tem dry-run/confirmation** nas writes — o protocolo de confirmação é enforced no `SKILL.md` (e reforçado por regra absoluta no `SOUL.md`), não na ferramenta. Se Whis falhar de aderência (LLM "esquecer" de pedir confirmação), o evento entra direto. Risco aceito como humano-pessoal.

**Decisões fundantes confirmadas no brainstorming (2026-04-25):**

- **MCP server `@cocal/google-calendar-mcp` via npx** — sem build no Dockerfile, npx baixa em runtime e cacheia em `/home/node/.npm`.
- **OAuth Desktop app** (não Service Account) com escopo `calendar` (full read+write, inclui `list-calendars` e `get-freebusy`). Credentials baixadas do Google Cloud Console pelo Gabriel uma vez.
- **`profile/google-credentials.json` (gitignored)** com `profile/google-credentials.example.json` committed como template — mesmo padrão do `.env`.
- **Tokens OAuth persistidos** em volume Docker novo `gcal_tokens:/home/node/.config` — sobrevive a `docker:build`.
- **Setup inicial via chat com Whis no Telegram** (decisão `b` do brainstorming) — sem script `pnpm run gcal:setup`. Auth flow usa a tool `manage-accounts` do MCP: Whis recebe URL do Google, manda no chat, user autoriza, copia code, cola de volta, Whis grava token.
- **Multi-account `personal` + `work`** desde a v1 — Gabriel tem agenda dos dois ambientes e quer ambos no Whis.
- **Roteamento por inferência semântica** (decisão `a` do brainstorming) — SOUL.md já distingue `work` vs `personal` por palavras-chave; SKILL.md aplica a mesma heurística pra escolher account no calendar. Confirmação pré-write atua como catch-all (Whis sempre mostra "**no calendário X**, confirma?" antes de criar).
- **Timezone `America/Sao_Paulo` explícito** em toda criação/busca — Whis nunca chuta tz.
- **Skill `hello-world` aposentada** (decisão `b` do brainstorming) — `git rm` no diretório como parte desta entrega. `google-calendar` vira a única skill ativa em `agent/skills/`.
- **Confirmação enforced via `SKILL.md` + regra absoluta no `SOUL.md`** — protocolo de 3 passos (resumo → aguarda `sim` → executa → confirma sucesso) pra `create-event`, `update-event`, `delete-event`, `respond-to-event`. Reads (`list-*`, `search-events`, `get-event`, `get-freebusy`, `get-current-time`) executam direto.

## Problem Statement

O Whis hoje sabe responder `oi` e tem identidade definida no SOUL, mas não faz **nada útil** que justifique conversa diária. Pra virar parte da rotina do Gabriel, precisa de uma capacidade que ele já queira fazer pelo telefone múltiplas vezes ao dia. Agenda é o vetor mais óbvio: criar evento agora pelo Telegram tira o atrito de abrir Google Calendar app, escolher data, escolher horário, escrever título — substituído por *"reunião com cliente Y sex 14h"*.

A spec resolve esse problema entregando:

1. **Agenda consultável conversacionalmente:** *"que reuniões eu tenho hoje?"* / *"tô livre amanhã 14h?"* / *"quando é a próxima 1x1 com Marcos?"* respondidas em formato Telegram-nativo (MarkdownV2).
2. **Agenda editável conversacionalmente:** criar/adiar/cancelar eventos com confirmação humana antes de cada write — minimizando risco de Whis criar coisa errada.
3. **Roteamento automático entre agendas:** Gabriel não precisa especificar `personal` vs `work` toda vez — Whis infere por contexto, e o protocolo de confirmação pega erros antes de virarem evento ruim.

A skill **não** automatiza decisões (não cria eventos sem ser pedido, não responde convites sem ser pedido). É um **interlocutor humano-em-loop** sobre a agenda — tudo passa por confirmação explícita do Gabriel.

## Non-Goals

Explicitamente **fora do escopo** desta spec:

1. **Eventos recorrentes — modificação da série.** v1 só edita/deleta a **instância única**. Modificar série inteira (`"muda toda quinta às 10h pra 11h"`) v1 responde *"ainda não faço isso, abre o app"*. v2 cobre.
2. **Attendees em criação.** Gabriel cria eventos pra si; sem convidados. Adiciona manualmente quando precisar. v2: criar com attendees + decisão de notification.
3. **Cross-account conflict detection** automática. Se evento `personal` 14h e Whis cria `work` 14h sem checagem, passa. Gabriel pode pedir explicitamente *"tô livre amanhã 14h?"* via `get-freebusy`. v2: Whis checa proativamente antes de cada `create-event`.
4. **Color/emoji per-event.** Default colors do Google.
5. **Anexar arquivos do vault Obsidian em descrições** (`"agenda 1x1 com Marcos, anexa as notas em personal/marcos.md"`). v3+.
6. **Cron / lembretes proativos** (Whis manda *"daqui 30min tem reunião"*). Whis hoje só responde, não inicia. Spec própria futura.
7. **Sync bidirecional Obsidian ↔ Calendar** (notas do vault virando eventos automaticamente, ou eventos virando notas). Fora.
8. **Exportar agenda pro vault** (`"salva a agenda da semana em context/work/agenda-2026-04.md"`). Fora.
9. **`list-colors` tool** exposta via skill. v2.
10. **Setup automatizado via script `pnpm run gcal:setup`.** Decisão `b` do brainstorming — setup roda manualmente via chat com Whis.
11. **WhatsApp na v1.** Whis no WhatsApp continua dormente (spec 0002); skill funciona em qualquer canal ativo, mas validação manual desta spec é via Telegram. Quando WhatsApp voltar (chip dedicado), skill já estará pronta — single SOUL+SKILL.

## Constraints

**Técnicas:**

- `@cocal/google-calendar-mcp` v2.6.x (npm `@cocal/google-calendar-mcp`). Pinned no `agent/mcp.json` via `npx -y @cocal/google-calendar-mcp` (sem versão pinada na CLI; npx pega latest patch — discovery validará compat).
- Node ≥18 dentro do container (já é Node 24).
- OAuth scope `https://www.googleapis.com/auth/calendar` — aceito como trade-off pra ter `list-calendars` + `get-freebusy`.
- Credentials JSON baixado do Google Cloud Console (Desktop app type) salvo em `profile/google-credentials.json` (gitignored).
- Volume Docker `gcal_tokens` mapeado pra `/home/node/.config` no container — persiste tokens OAuth entre rebuilds.
- MCP server consome stdin/stdout — gerenciado pelo Claude Agent SDK, sem mudança no `worker/index.ts`.
- TS strict + tests Vitest mantidos. Skill é puramente markdown (sem código TS novo no worker).

**Organizacionais:**

- Gabriel precisa de um Google Cloud project (gratuito) — ~5min setup. Documentado em SMOKE.md.
- Setup OAuth (Etapa 3 da seção Setup flow) é interativo via chat — exige Whis online + bot Telegram alcançável.
- Sem SLA — ferramenta pessoal.

**De arquitetura (pra evitar débito imediato):**

- Skill é **pure markdown** em `agent/skills/google-calendar/SKILL.md`. Sem código TS no worker.
- `SOUL.md` ganha **1 linha** nova reforçando regra absoluta de confirmação antes de write — paridade com regras tipo `rm -rf`.
- `agent/mcp.json` ganha entrada `google-calendar`. `profile/mcp.json` permanece pra MCPs específicos do user (não usado no MVP atual).
- `agent/skills/hello-world/` é **deletado** nesta entrega (decisão `b`). `profile/config.yaml`'s `always_active_skills` removido se referenciava `hello-world`.
- Worker code (`apps/worker/src/`) **não muda** — toda integração é via mcp.json + SKILL.md.
- Tests: nenhum test TS novo (skill é markdown). Validação é via smoke manual da spec.

**De comunicação:**

- Idioma: PT-BR padrão (herdado do SOUL).
- Format de eventos: MarkdownV2 do Telegram (já implementado em `format.ts`). Listagens com bullets + grouping por dia. Detalhes com emojis ASCII-safe (📅 📍 👤 📝).
- Tom: igual ao SOUL — calmo, direto, irônico leve. Confirmações curtas: *"Confirma?"* não *"Você tem certeza absoluta de que deseja prosseguir com a criação deste evento?"*.

## User Stories / Scenarios

**G1 — Setup inicial (uma vez):**

1. Gabriel cria Google Cloud project + habilita Calendar API + cria OAuth Desktop app credentials → baixa `gcp-oauth.keys.json` → renomeia + move pra `profile/google-credentials.json`.
2. `docker compose down` + `docker:build --no-cache` + `docker:up` (sem `--profile whatsapp`).
3. Logs mostram `mcp_server_enabled name=google-calendar`. `whis_online`.
4. No Telegram: *"Whis, conecta meu calendário pessoal."*
5. Whis chama `manage-accounts` (action `auth`, nickname `personal`) → MCP retorna URL do Google.
6. Whis: *"Abre essa URL pra autorizar e me manda o código que aparecer no final:"* + URL.
7. Gabriel autoriza no browser → cola code de volta no chat.
8. Whis chama `manage-accounts` passando code → tokens gravados em `/home/node/.config/google-calendar-mcp/personal.json`.
9. Whis: *"Conectado. Posso listar eventos do calendário pessoal."*
10. Gabriel: *"Whis, conecta o calendário do trabalho como `work`."* — repete steps 5-9 com nickname `work`.

**G2 — Listar eventos (read, sem confirmação):**

1. Gabriel: *"que reuniões eu tenho hoje?"*
2. Whis chama `list-events` com range = today, accounts = ambas.
3. Whis formata em MarkdownV2:
   ```
   *Próximos eventos hoje:*
   • 14:00–15:00 Reunião com Cliente Y _(work)_
   • 18:00 Academia _(personal)_
   ```
4. Latência <30s steady state.

**G3 — Criar evento (write, com confirmação):**

1. Gabriel: *"agenda café com José sábado 10h"*
2. Whis infere `personal` (nome próprio sem contexto profissional).
3. Whis chama `get-current-time` se necessário pra resolver "sábado" → 26/04/2026.
4. Whis monta resumo + manda no chat: *"Vou criar **Café com José**, sáb 26/04 às 10:00 (1h por default), no calendário **personal**. Confirma?"*
5. Gabriel: *"sim"*
6. Whis chama `create-event` com `account: "personal"`, `timeZone: "America/Sao_Paulo"`, `start: "2026-04-26T10:00:00-03:00"`, `end: "2026-04-26T11:00:00-03:00"`, `summary: "Café com José"`.
7. Whis confirma sucesso: *"Pronto. [Link do evento]"*

**G4 — Cancelar evento (write, com confirmação + busca):**

1. Gabriel: *"cancela a daily de amanhã"*
2. Whis chama `search-events` (`query: "daily"`, range = tomorrow).
3. Whis encontra "Daily Standup", 09:30-09:45.
4. Whis monta resumo: *"Encontrei **Daily Standup** amanhã (sáb 26/04) 09:30–09:45 no calendário **work**. Cancelar?"*
5. Gabriel: *"sim"*
6. Whis chama `delete-event`. Confirma sucesso.

**G5 — Verificar disponibilidade (read):**

1. Gabriel: *"tô livre amanhã 14h?"*
2. Whis chama `get-freebusy` (range = tomorrow 14:00-15:00, ambas accounts).
3. Whis: *"Sim, livre nas duas agendas (personal e work)."* OU *"Não — tem **Reunião com Cliente Y** das 14:00 às 15:00 (work)."*

**G6 — Adiar evento (write, com confirmação + busca):**

1. Gabriel: *"adia minha 1x1 com Marcos pra próxima"*
2. Whis chama `search-events` (`query: "Marcos"`).
3. Encontra "1x1 Marcos" qua 30/04 11:00.
4. Whis: *"Achei **1x1 Marcos** quarta 30/04 às 11:00 (work). Adiar pra qua **07/05** mesmo horário?"*
5. Gabriel: *"sim"*
6. Whis chama `update-event`. Confirma.

**G7 — Token OAuth expirou (worst case):**

1. Refresh token foi invalidado (Google purge após 6 meses sem uso, ou usuário revogou).
2. Whis tenta `list-events` → MCP retorna erro de auth.
3. Whis: *"Token do calendário **personal** expirou. Posso re-autenticar pra você?"*
4. Gabriel: *"sim"* → Whis chama `manage-accounts auth` de novo (mesmo flow do G1.5-9).

## Success Criteria

Esta entrega está **pronta** quando:

1. **`agent/mcp.json` declara** `google-calendar` como MCP server via `npx -y @cocal/google-calendar-mcp@^2` (major pinado pra evitar major bumps acidentais; minor/patch via npx) com `GOOGLE_OAUTH_CREDENTIALS=/app/profile/google-credentials.json`.
2. **`profile/google-credentials.example.json` committed** como template (estrutura JSON sem segredos). `profile/google-credentials.json` gitignored.
3. **`infra/docker-compose.yml`** ganha volume `gcal_tokens:/home/node/.config` no service `whis-worker`.
4. **`agent/skills/hello-world/`** removido. `profile/config.yaml`'s `always_active_skills` atualizado se necessário (provável: vazio `[]`).
5. **`agent/skills/google-calendar/SKILL.md`** criado com seções: descrição, when_to_use, ferramentas disponíveis, protocolo de confirmação obrigatório, formato MarkdownV2 de eventos, padrões de uso (G1-G7 acima), roteamento de account.
6. **`agent/SOUL.md`** ganha 1 regra absoluta nova na seção *"Regras absolutas de segurança"*: `"Calendário: ações de escrita (create-event, update-event, delete-event, respond-to-event) sempre mostre o resumo da operação e peça 'sim' antes de chamar a tool. Reads são livres. Esta regra é absoluta — vale como rm -rf no vault."`.
7. **`pnpm run quality-gate`** continua verde — 91 tests passando (zero novos, zero perdidos; skill é markdown).
8. **Setup G1 completável manualmente** (pelo SMOKE.md): user cria Cloud project, baixa creds, edita compose, sobe, autentica via chat. <15min total.
9. **G2 (list events) funciona ponta-a-ponta** após setup. Resposta em <30s steady, formato MarkdownV2 correto, sem lint errors no Telegram.
10. **G3 (create event)** funciona com protocolo de confirmação enforced. Whis NÃO cria sem `sim` explícito. Validado manualmente — se Whis pular o resumo, é bug e re-roda.
11. **G4 (delete) e G6 (update)** funcionam com search → resumo → confirm → exec.
12. **G5 (freebusy)** retorna resposta correta cross-account.
13. **`SMOKE.md`** ganha seção "Setup Google Calendar" com Etapas 1-3 documentadas + troubleshooting.
14. **`AGENTS.md`** atualizado: tabela de "Locais de conhecimento" referencia spec 0003. Tabela de comandos não muda (sem `gcal:setup`).
15. **Logs estruturados:** quando MCP é carregado, log `mcp_server_enabled name=google-calendar`. Quando user chama tool, log inclui correlationId. Erros de auth logam `mcp_tool_failed` com classificação.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| `@cocal/google-calendar-mcp` lança versão major incompatível e `npx` pega ela. | Discovery (Task 0 do plan) pina major no `args` do mcp.json (`npx -y @cocal/google-calendar-mcp@^2`). Atualização major exige amendment. |
| Whis "esquece" de pedir confirmação antes de write (LLM falha de aderência). | Regra absoluta em `SOUL.md` (mesmo nível das `rm -rf`). SKILL.md tem 3 exemplos few-shot do protocolo. Risco residual aceito — uso pessoal individual; se acontecer, é bug de prompt e ajustamos SKILL.md. |
| Token OAuth expira sem aviso, todos os tools de Calendar falham. | MCP refresh automaticamente via refresh_token (Google standard). Se refresh quebrar, Whis traduz erro pro user e oferece `manage-accounts auth` de novo (G7). |
| User esquece de criar `profile/google-credentials.json` antes do `docker:up`. | MCP loga erro claro no boot do worker. Worker continua subindo (Telegram channel não depende). Quando user chamar primeira tool, Whis explica setup (instruído pelo SKILL.md). |
| OAuth scope `calendar` (full) é amplo demais — vaza pra Whis acesso a calendars compartilhados que o user não quis expor. | Scope é teu próprio account; Whis só acessa o que tu já vê. Mitigação real: criar conta Google secundária dedicada (futuro). v1 aceito. |
| Test users limit do Google OAuth (External + não-publicado limita a 100 test users) bate. | Não atinge — Gabriel é o único user. Se virar multi-user, app precisa Google Verification (bureaucracy). |
| MCP server consome muito stdin/stdout buffer e trava o worker. | grammy/Telegram channel é independente do MCP. Se MCP travar, Whis ainda recebe mensagens; só as tools do calendar param. Mitigação: log + timeout futuro. |
| Recurring events na v1 — user pede "muda toda quinta" e Whis silenciosamente edita só uma instância. | SKILL.md instrui Whis a detectar campo `recurringEventId` na resposta de `get-event` e responder explicitamente *"esse é evento recorrente; só consigo mudar a instância de hoje. Tudo bem?"*. |
| Gabriel cola code OAuth errado durante setup. | MCP retorna erro descritivo via tool. Whis traduz e pede pra repetir. |
| Performance: cold start do `npx @cocal/google-calendar-mcp` em cada `docker:up` é lento. | Volume `/home/node/.npm` opcional pra cachear. v1 aceita ~3-5s de boot extra. |
| Gabriel deleta evento que Whis criou ainda na mesma sessão (sem refresh do contexto). | Whis pode ter info stale. Aceita risco — comportamento humano normal. |

## Open Questions

Nenhuma bloqueante. Todas as decisões core resolvidas no brainstorming 2026-04-25.

Itens menores resolvíveis na implementação (Task 0 do plan):

- Versão exata pinada de `@cocal/google-calendar-mcp` no momento da discovery (esperado: `^2.6`).
- Confirmar shape exato do `manage-accounts auth` flow em runtime — alguns MCPs retornam URL + esperam segunda chamada com code; outros retornam URL e o token chega via callback HTTP. Discovery valida.
- Nome exato do diretório onde `@cocal/google-calendar-mcp` salva tokens (`~/.config/google-calendar-mcp/` ou `~/.config/@cocal/google-calendar-mcp/`?). Validar antes de definir o path do volume.
- Se vale ou não persistir cache npx (`/home/node/.npm`) em volume separado — depende de quanto tempo demora o cold start medido.
