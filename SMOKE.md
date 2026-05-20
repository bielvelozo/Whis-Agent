# Whis MVP — Smoke Test Checklist

> Continuar a partir de outro PC: este arquivo tem tudo que você precisa pra
> validar o MVP do zero. Estado do repo no commit que adicionou este arquivo:
> Phases 1-13 completas, 50 tests verdes, falta apenas a validação de runtime
> com Docker (Phase 14).

## 0. Pré-requisitos no PC novo

- **Git** + **SSH key autorizada no GitHub** (este repo é privado).
  - Se for um PC virgem: gera nova key (`ssh-keygen -t ed25519 -C "<seu email>"`),
    copia `~/.ssh/id_ed25519.pub` e adiciona em https://github.com/settings/keys.
- **Docker Desktop** instalado e rodando (Windows/Mac/Linux).
- **Node 24** + **pnpm 10** (recomendo `nvm` ou `volta` pra gerenciar — `.nvmrc`
  do projeto pinada em `24`).
- **Plano Claude Pro ou Max** ativo (pro OAuth do Agent SDK).
- **Chip de WhatsApp dedicado** (ou seu pessoal — risco de ban é baixo, mas
  documentado).
- Para Windows: rode os passos abaixo no **Git Bash** ou **WSL**, não no
  PowerShell (alguns scripts assumem Unix shell).

## 1. Clone e bootstrap

```bash
git clone git@github.com:bielvelozo/Whis-Agent.git
cd Whis-Agent

# Confirmar Node 24
node --version    # deve mostrar v24.x

# Habilita corepack/pnpm se não tiver
corepack enable
corepack prepare pnpm@10.33.0 --activate

# Instala deps + valida que tudo compila
pnpm install
pnpm run quality-gate    # lint + typecheck + tests (deve ficar verde, ~50 tests)
```

Se `quality-gate` quebrar, abrir issue antes de seguir — código no repo passou
em CI no PC original.

## 2. Configurar profile + vault

```bash
# Copiar templates
cp profile/.env.example profile/.env
cp profile/USER.example.md profile/USER.md
cp profile/mcp.example.json profile/mcp.json

# Bootstrap do vault Obsidian (gitignored, fica só no PC)
cp -r context.example context
```

### 2.1. Editar `profile/.env`

Campos a preencher:

| Variável | Valor |
|---|---|
| `EVOLUTION_API_KEY` | Gere string aleatória: `openssl rand -hex 32` (ou similar). Anote — é o que autoriza o webhook + o painel. |
| `WHATSAPP_OWNER_NUMBER` | Seu número, **só dígitos**, formato `5511999999999` (DDI + DDD + número, sem `+` ou `@`). É a whitelist — só ele recebe resposta. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Deixe **vazio por enquanto**. Vai ser preenchido no passo 4. |

Os outros campos têm defaults que funcionam (mantém como está):
- `EVOLUTION_BASE_URL=http://evolution-api:8080` (rede interna do compose)
- `EVOLUTION_INSTANCE=whis`
- `DATABASE_*` (9 linhas — Evolution v2 exige Postgres; valores apontam pro
  service `postgres` interno do compose, deixa como está)
- `WORKSPACE_DIR=/app/context`
- `DATA_DIR=/app/data`
- `WEBHOOK_PORT=8080`
- `SESSION_IDLE_HOURS=6`
- `LOG_LEVEL=info`
- `WHIS_BACKEND=claude-code`

> **Atenção se você copiou o `.env` antes de 2026-04-25:** o bloco `DATABASE_*`
> foi adicionado depois. Se a Evolution ficar em crashloop com
> `Database provider invalid` (ver passo 5), volte aqui e copie o bloco
> `DATABASE_*` do `profile/.env.example` pro seu `profile/.env`.

### 2.2. Editar `profile/USER.md`

Preenche com info pessoal/profissional sua — é injetada no system prompt do
Whis e usada pra ele te conhecer.

## 3. Volume Docker (uma vez na vida)

```bash
docker volume create claude_home
```

Esse volume guarda `~/.claude/` da CLI dentro do container — persiste o token
OAuth entre rebuilds.

## 4. Build da imagem + token Claude

```bash
# Build (~3-5min na primeira vez)
pnpm run docker:build

# OAuth token: abre browser, completa fluxo, imprime token no terminal
pnpm run docker:setup-token
```

Cola o token impresso em `profile/.env` na linha `CLAUDE_CODE_OAUTH_TOKEN=`.

## 5. Subir os containers

```bash
pnpm run docker:up
```

Sobem 2 services: `evolution-api` (porta `8081` no host pra painel) e
`whis-worker` (porta `8080` interna — não exposta).

## 6. Parear o WhatsApp

```bash
pnpm run evolution:setup
```

O script:
1. Aguarda Evolution responder.
2. Cria a instância `whis` se não existir (ou pula se já existir).
3. Renderiza o QR code (PNG temporário) e tenta abrir automaticamente.
4. Você escaneia: WhatsApp → Configurações → Aparelhos conectados → Conectar
   dispositivo.

Alternativa se o QR não abrir automaticamente: acessa `http://localhost:8081`
no browser e faz login com a `EVOLUTION_API_KEY` (campo do painel) — o QR
aparece ali.

QR expira em ~60s. Se expirar, roda `pnpm run evolution:setup` de novo.

## 7. Confirmar que o Whis está online

```bash
pnpm run docker:logs
```

Espera ver a sequência:

```
boot_start → db_opened → migrations_applied → soul_md_loaded
→ user_md_loaded → mcp_loaded → evolution_health_ok → whis_online
```

Quando `whis_online` aparecer, o pipeline está pronto.

## 8. Smoke tests

### S1 — Caminho feliz

Manda `oi` no WhatsApp do número pareado.

> **Modo single-number** (sem chip dedicado): pareia teu próprio número na
> Evolution, configura `WHATSAPP_OWNER_NUMBER` com ele mesmo, abre no app a
> conversa "Mensagem enviada a mim mesmo" (próprio nome), e manda `oi` ali.
> Whis responde no mesmo chat. O worker rastreia IDs das mensagens emitidas
> pra distinguir tua mensagem do echo da resposta dele — sem loop.

**Esperado:**
1. Reação 👀 aparece na sua mensagem em até ~3 segundos.
2. Resposta do Whis chega em até ~30s steady state (pode levar 45-60s na
   primeira mensagem após boot — cold start aceitável).
3. Resposta menciona seu nome (lido de `USER.md`) e segue a personalidade
   do Whis (DBZ — calma, polida, irônica).
4. Reação 👀 desaparece após a resposta.

Logs (`pnpm run docker:logs`) mostram:
`message_received → session_created → backend_started → backend_completed → response_sent`,
todos com o mesmo `correlationId`.

### S2 — Número não autorizado (opcional)

Se tiver outro chip à mão, manda mensagem dele pro número pareado.

**Esperado:**
- Sem reação no WhatsApp.
- Sem resposta no chat.
- Log `dm_ignored_non_owner` aparece com o número não-whitelisted.

### S5 — Token Claude expirado

Edita `profile/.env`, define `CLAUDE_CODE_OAUTH_TOKEN=invalid`, e:

```bash
pnpm run docker:up -d --force-recreate
```

Manda `oi`.

**Esperado:** Whis responde com:

> *"meu token Claude expirou. Roda `pnpm run docker:setup-token`, cola o
> novo no `profile/.env` e `pnpm run docker:up -d --force-recreate`."*

Restaura o token válido depois.

### S7 — Hot-reload do prompt

Edita `agent/SOUL.md` (ex: adiciona "responda sempre começando com 'Beleza,'"
antes da seção de regras). Salva.

**Sem reiniciar o container**, manda nova mensagem no WhatsApp.

**Esperado:**
- Resposta começa com "Beleza,".
- Log `system_prompt_reloaded` apareceu logo após o save (debounce 250ms).

Reverte a edição quando terminar.

## 9. Comandos do dia-a-dia

| Comando | O que faz |
|---|---|
| `pnpm run docker:up` | Sobe em background |
| `pnpm run docker:down` | Desce |
| `pnpm run docker:logs` | Tail dos logs (worker + evolution) |
| `pnpm run docker:sh` | Shell dentro do `whis-worker` |
| `pnpm run docker:setup-token` | Renova o token Claude (quando expira) |
| `pnpm run evolution:setup` | Re-pareia o WhatsApp se a sessão cair |
| `pnpm run evolution:logs` | Tail só dos logs da Evolution |
| `pnpm run quality-gate` | Lint + typecheck + tests (rápido, local) |

## 10. Troubleshooting

| Sintoma | Solução |
|---|---|
| `whis_online` não aparece | Cheque `profile/.env` — variável faltando geralmente é o que falta. `pnpm run docker:logs` mostra qual zod schema falhou. |
| `evolution_health_failed` | Evolution não subiu — `pnpm run evolution:logs` pra investigar. Pode ser API key incompatível ou volume corrompido. |
| Evolution em crashloop com `Database provider invalid` | Faltam as envs `DATABASE_*` no `profile/.env`. Copia o bloco `DATABASE_*` do `profile/.env.example`, depois `pnpm run docker:up -d --force-recreate`. |
| Worker em crashloop com `ERR_MODULE_NOT_FOUND` | Build da imagem está stale. Roda `pnpm run docker:build --no-cache && pnpm run docker:up -d --force-recreate`. |
| Whis não reage | Cheque `WHATSAPP_OWNER_NUMBER` em `profile/.env` — só esse número é aceito. Confere também que pareou o WhatsApp certo (e não outro chip). |
| Token Claude expirado | `pnpm run docker:setup-token` → cola o novo no `.env` → `pnpm run docker:up -d --force-recreate`. |
| `claude_home` volume não existe | `docker volume create claude_home`. |
| QR code não aparece | `pnpm run evolution:setup` de novo, ou abre painel em `http://localhost:8081`. |
| Sessão WhatsApp caiu (logout no app) | `pnpm run evolution:setup` re-pareia. |
| Evolution loga `stream:error code 515` + `Pre-key upload timeout` | Bug bem documentado da Evolution v2.3.x — umbrella [issue #2437](https://github.com/EvolutionAPI/evolution-api/issues/2437). Garante que o teu `profile/.env` tem o **bloco completo de workaround** (`CONFIG_SESSION_PHONE_VERSION`, `CACHE_REDIS_ENABLED=false`, `CACHE_LOCAL_ENABLED=true`, e os 4 `DATABASE_SAVE_DATA_{CHATS,CONTACTS,HISTORIC,LABELS}=false`). Se mantiver, o valor de `CONFIG_SESSION_PHONE_VERSION` pode ficar obsoleto quando WhatsApp atualizar protocolo — checa #2437 pro valor corrente. |
| `telegram_health_failed` ao boot | Token inválido ou rede sem outbound HTTPS. Confere `TELEGRAM_BOT_TOKEN` em `profile/.env`. Pra novo token: BotFather → `/revoke` + cria de novo. |
| Bot mudo (não responde no Telegram) | Confere `TELEGRAM_OWNER_CHAT_ID` em `profile/.env` — se for outro chat_id, log `dm_ignored_non_owner` aparece com `channel: 'telegram'`. Re-roda `pnpm run telegram:setup`. |
| `409 Conflict` nos logs Telegram | Outra instância do worker rodando com mesmo token. Mata a outra. Pode acontecer também se rodar `pnpm run telegram:setup` com worker rodando — pare o worker antes (`pnpm run docker:down`). |

## Setup Telegram (canal default do MVP)

Setup mínimo pra usar Whis via Telegram (sem chip dedicado de WhatsApp):

1. **Cria o bot:**
   - Abre `@BotFather` no Telegram
   - Manda `/newbot` → escolhe nome (ex: `Whis`) e username único (ex: `whis_gabriel_bot`)
   - Cola o token retornado em `profile/.env` na linha `TELEGRAM_BOT_TOKEN=`

2. **Descobre teu chat_id** (Git Bash ou PowerShell):
   ```bash
   pnpm run telegram:setup
   ```
   Script imprime `Bot pareado: @nome_do_bot`. Aí abre o chat com o bot no app, manda `/start`.
   Script captura, imprime `TELEGRAM_OWNER_CHAT_ID=<numero>`, encerra.

3. **Cola** o `TELEGRAM_OWNER_CHAT_ID=<numero>` em `profile/.env`.

4. `pnpm run docker:up` (sem `--profile whatsapp`). Aguarda logs `telegram_health_ok` + `whis_online`.

5. Manda `oi` no chat com o bot. Whis responde com 👀 + texto.

## Modo dual (Telegram + WhatsApp simultâneos)

Quando tiver chip dedicado WhatsApp pareado:

1. Em `profile/.env`: `WHATSAPP_ENABLED=true`. Mantém `TELEGRAM_ENABLED=true`.
2. `pnpm run docker:up --profile whatsapp` — sobe os 3 containers (worker + Postgres + Evolution).
3. Pareia WhatsApp via `pnpm run evolution:setup`.
4. Smoke S1 do WhatsApp + smoke Telegram em paralelo. Sessões isoladas por canal.

## Setup Google Calendar (skill 0003)

A skill `google-calendar` exige um Google Cloud project pessoal com OAuth
Desktop app credentials. Setup uma vez, ~5min.

### Etapa 1 — Google Cloud Console

1. Acessa https://console.cloud.google.com → cria/seleciona project (ex: `whis-personal`).
2. **APIs & Services → Library** → busca *Google Calendar API* → **Enable**.
3. **APIs & Services → OAuth consent screen** → **External** → preenche app
   name (`Whis`), email teu, sem logo. Em **Test users**, adiciona teu email
   Google pessoal e do trabalho. Salva.
4. **APIs & Services → Credentials** → **Create Credentials → OAuth client
   ID** → tipo **Desktop app** → nome `Whis Desktop`. Clica **Download
   JSON** → salva como `gcp-oauth.keys.json`.
5. **Move/renomeia** pra `profile/google-credentials.json` no repo
   (gitignored — não vai pro git). `redirect_uris` no JSON pode ficar como
   o default `["http://localhost"]` — o MCP injeta a porta concreta
   (3500-3505) no flow runtime.

### Etapa 2 — Build + up

```bash
docker compose -f infra/docker-compose.yml --project-directory . down
pnpm run docker:build --no-cache
pnpm run docker:up
pnpm run docker:logs
```

Aguarda nos logs:
- `mcp_server_enabled name=google-calendar layer=agent`
- `whis_online`

### Etapa 3 — Auth via chat com Whis (Telegram)

Manda no chat com o bot:

> *"Whis, conecta meu calendário pessoal."*

Whis chama `manage-accounts` → MCP levanta auth server local em port
3500-3505 (exposta pro host pelo compose) e retorna URL longa do Google.
Whis manda a URL no chat. Tu abre **no browser do MESMO PC que está
rodando o container** — Google redireciona pra `http://localhost:<porta>/oauth2callback`,
MCP captura code automaticamente, salva token. Whis confirma.

Repete pro `work`: *"Whis, conecta o calendário do trabalho como `work`."*

### Smoke da skill

Manda no chat:
- *"que reuniões eu tenho hoje?"* → lista MarkdownV2.
- *"agenda café com José sábado 10h"* → resumo + confirma → cria evento.
- *"tô livre amanhã 14h?"* → freebusy.

### Troubleshooting

| Sintoma | Solução |
|---|---|
| `mcp_server_skipped name=google-calendar reason=unresolved_env` | `GOOGLE_OAUTH_CREDENTIALS` env não foi resolvida — confere `agent/mcp.json` (path `/app/profile/google-credentials.json`) e que o arquivo existe no host em `profile/google-credentials.json`. |
| Browser redireciona pra `localhost:3500/oauth2callback` mas dá *"site can't be reached"* | Compose não está expondo as ports 3500-3505. Confere `infra/docker-compose.yml` em `whis-worker` ports + recria container. |
| Whis tenta tool e retorna *"unauthorized"* / *"invalid_grant"* | Token OAuth expirou. Manda *"reconecta meu calendário [personal/work]"* — Whis dispara o flow de auth de novo. |
| Whis cria evento sem perguntar antes | Bug de aderência ao SOUL.md. Reporta pro próximo ajuste de SKILL/SOUL. |
| `npx @cocal/google-calendar-mcp` falha com `ENOTFOUND` | Container sem outbound HTTPS. Confere DNS / firewall. |
| Eventos criados em UTC em vez de Brasil | Whis chutou timezone. SKILL.md exige `America/Sao_Paulo` explícito — reportar. |

## Deploy remoto — Google Calendar OAuth (spec 0007)

Quando o Whis roda em servidor remoto (EC2 etc.), o OAuth flow do
`@cocal/google-calendar-mcp` não funciona direto — o redirect URI é
hard-coded em `http://localhost:3500-3505/oauth2callback`, mas o
`localhost` do browser do Gabriel é o laptop dele, não o servidor.

A solução é um **SSH tunnel** que mapeia ports 3500-3505 do laptop pro
server. O Whis precisa saber que está em deploy remoto pra instruir o
tunnel proativamente — sinal: presença da env `WHIS_AUTH_TUNNEL_HINT`
no `profile/.env` do server.

### Setup do server remoto (uma vez)

1. **Adiciona o comando do tunnel no `profile/.env` do server:**

   ```bash
   # No server, editar /home/ubuntu/Whis-Agent/profile/.env
   WHIS_AUTH_TUNNEL_HINT=ssh -i C:\Users\gabri\Downloads\whis-key.pem -L 3500:localhost:3500 -L 3501:localhost:3501 -L 3502:localhost:3502 -L 3503:localhost:3503 -L 3504:localhost:3504 -L 3505:localhost:3505 ubuntu@18.231.48.71
   ```

   Trocar `C:\Users\gabri\...` pelo path real da chave SSH no laptop,
   e `ubuntu@18.231.48.71` pelo user@host do server. Comando assume
   PowerShell (OpenSSH nativo do Windows 11). Em Git Bash / WSL,
   ajustar o path da chave pra `~/...` ou `/c/Users/...`.

2. **Cria a pasta `backups/` no server** (pra auto-restore de tokens):

   ```bash
   mkdir -p /home/ubuntu/Whis-Agent/backups
   ```

3. **Recria o container:**

   ```bash
   docker compose -f infra/docker-compose.yml --project-directory . up -d --force-recreate whis-worker
   ```

### Workflow: tokens expiraram (R2)

O Gabriel manda algo de agenda no Telegram (*"que reuniões eu tenho hoje?"*).
Whis tenta a tool, MCP retorna *"Authentication token is invalid or expired"*.

Whis (orientado pelo bloco "Deployment context" injetado no system prompt)
responde:

1. *"Token do calendário **personal** expirou. Posso reconectar?"* → Gabriel: *"sim"*.
2. Whis chama `manage-accounts` (auth, `personal`) → MCP retorna URL longa.
3. Whis manda **primeiro** o comando SSH tunnel em bloco de código + instrução
   "abre em outro terminal e mantém aberto".
4. Whis manda **depois** a URL + lembrete dos 5min de timeout do MCP.
5. Gabriel cola o comando no PowerShell (autentica com a chave), tunnel ativo.
6. Gabriel clica a URL → Google login → autoriza → callback `localhost:3500`
   do laptop → tunnel encaminha pra EC2 → MCP captura code → grava tokens.
7. Whis confirma sucesso. Gabriel fecha o terminal do tunnel.

Repete pra `work` se for o calendário do trabalho.

### Workflow R6 — Backup tarball local + sync pro server

Quando os tokens locais estão frescos (Whis local lista agenda sem erro), vale
gerar um tarball atualizado pra usar como seed em CDs futuros do server.

1. **Gera tarball local** (PowerShell):

   ```powershell
   docker run --rm `
     -v whis_gcal_tokens:/source:ro `
     -v "${PWD}\backups:/backup" `
     alpine sh -c "cd /source && tar -czf /backup/gcal_tokens.tar.gz ."
   ```

2. **Sincroniza pro server**:

   ```powershell
   scp -i C:\Users\gabri\Downloads\whis-key.pem .\backups\gcal_tokens.tar.gz ubuntu@18.231.48.71:/home/ubuntu/Whis-Agent/backups/
   ```

3. No próximo restart do server, se o volume `gcal_tokens` vier vazio, o
   `entrypoint.sh` extrai esse tarball antes de subir o worker (log
   `event=gcal_tokens_restore source=/app/backups/gcal_tokens.tar.gz`).

> **Nota:** o tarball pode ficar stale (refresh tokens em apps OAuth em modo
> Testing expiram em 7d). Se o restore acontecer com tarball stale, o Whis vai
> entrar no flow R2 (reauth via tunnel) — esperado.

### Smoke do auto-restore (R3) local

Validar que o entrypoint restaura o volume vazio antes do worker subir:

```bash
# Pré-requisito: backups/gcal_tokens.tar.gz existe localmente (gerado via R6).
pnpm run docker:down
docker volume rm whis_gcal_tokens
pnpm run docker:up

# Confere nos logs do worker
pnpm run docker:logs | grep -E "gcal_tokens_(restore|seed_unavailable|present)"
# Esperado: event=gcal_tokens_restore source=/app/backups/gcal_tokens.tar.gz dest=/home/node/.config

# Valida que o volume foi populado
docker run --rm -v whis_gcal_tokens:/v alpine ls /v/google-calendar-mcp/
# Esperado: tokens.json
```

### Recomendação — mover OAuth app pra "In production"

Apps OAuth no Google Cloud Console em modo "Testing" têm refresh tokens que
expiram em **7 dias** — significa que o flow R2 (reauth via tunnel) precisa
acontecer toda semana. Mover pra "In production" (sem submeter pra
verification — só clica "Publish App" no consent screen) elimina essa
expiração.

Acesse: https://console.cloud.google.com → APIs & Services → OAuth consent
screen → **Publish App**. Aparece warning sobre "unverified app" no consent
flow (clicar em "Advanced → Go to Whis (unsafe)" é normal num app pessoal),
mas o refresh token para de expirar.

### Troubleshooting (deploy remoto)

| Sintoma | Solução |
|---|---|
| Whis manda URL de OAuth mas o browser dá *"site can't be reached"* em `localhost:3500` | Tunnel não está ativo. Cola o comando do bloco anterior do Whis no PowerShell, confirma "Connected", clica a URL de novo. |
| `ssh -L` falha com *"bind: Address already in use"* | Algo no laptop já ocupa port 3500-3505. Rodar `netstat -ano \| findstr :3500` (PowerShell) ou ajustar o range em `WHIS_AUTH_TUNNEL_HINT` + nas ports do compose. |
| Whis sugere *"rode npm run auth no servidor"* | Regressão da SKILL.md G7 — a tool canônica é `manage-accounts auth <nickname>` via MCP, nunca um comando npm. Reportar pro próximo ajuste. |
| Logs do server: `event=gcal_tokens_seed_unavailable` | Pasta `backups/` no server existe mas está vazia. Roda workflow R6 (gerar tarball local + scp). |
| Logs do server: `event=gcal_tokens_restore_failed` | Tarball corrompido. Re-gera local e re-sync. |
| Após restore (R3), Whis ainda diz que token expirou | Tarball stale (>7d com OAuth em Testing mode). Esperado — segue flow R2 normal pra reauth via tunnel. |

## Smoke `scheduled-messages` (skill 0004)

Skill `scheduled-messages` não exige setup adicional — funciona em cima do
Telegram channel + DB SQLite local. Total ~15min.

### SM1 — One-shot literal

> *"me lembra de comprar pão amanhã"*

Esperado: Whis classifica literal + heurística 9h → resumo *"Vou criar lembrete
**comprar pão** pra amanhã (DD/MM) às 09:00. Confirma?"*. "sim" → confirma com id.

> *"que lembretes tenho?"*

Esperado: lista MarkdownV2 com a entrada.

### SM2 — One-shot agent

> *"daqui 5min me manda um resumo da minha agenda do dia"*

Esperado: modo agent, prompt sintético. Em 5min: Whis chama google-calendar,
formata, envia. Logs: `scheduled_dispatched_agent`.

### SM3 — Recorrente agent

> *"todo dia 8h: bom dia + agenda"*

Esperado: cron `0 8 * * *`. (Pra smokar rápido, criar com cron `*/2 * * * *`,
smokar, cancelar.)

### SM4 — Captura por anotação livre

> *"lembrar de ir lavar o carro segunda"*

Esperado: Whis percebe sem você dizer "agenda" → propõe agendamento com
heurística 9h → confirma → cria.

### SM5 — Listar e cancelar

> *"que lembretes tenho?"* → *"cancela o do carro"*

Esperado: list MarkdownV2; cancel pede confirma, deleta. Re-listar não aparece.

### SM6 — Editar

> *"todo dia 8h: bom dia"* → confirma → *"muda o bom-dia pra 7h"*

Esperado: Whis identifica id, monta diff, confirma, atualiza linha. Listar
mostra `07:00`.

### SM7 — Pausar e reativar

> *"pausa o bom-dia"* → confirma. Listar com filter='paused' mostra.
> *"reativa o bom-dia"* → confirma. Volta pra ativos.

### SM8 — Catch-up <24h

Cria one-shot pra daqui 5min, confirma, espera 1min, `pnpm run docker:down`,
espera 8min, `pnpm run docker:up:local`.

```bash
pnpm run docker:logs:local | grep -E "scheduler_boot_recovered|scheduled_dispatched_literal"
```

Esperado: mensagem entregue com prefixo `(atrasado, era HH:MM)`. Logs:
`scheduler_boot_recovered { oneshot_caught_up: 1, ... }`.

### SM9 — Recorrente atrasada

Container down ~12h, sobe.

Esperado: **NÃO** dispara retroativo. Logs: `scheduled_recurrent_skipped`.
(Difícil testar manual. `dispatcher.test.ts` cobre via unit test —
"start() recomputes recurrent past due without firing".)

### Troubleshooting

| Sintoma | Solução |
|---|---|
| `scheduler_disabled reason=no_owner_chat` no boot | `TELEGRAM_OWNER_CHAT_ID` não setado em `profile/.env`. Roda `pnpm run telegram:setup`. |
| Tool retorna erro `cron parse failed` | LLM gerou cron malformado. SKILL.md tem exemplos — verificar instruções seguidas. |
| Lembrete dispara mas sem reaction (👀) na mensagem | Esperado — `dispatchSynthetic` pula `react/unreact` (não há messageRef real). |
| Listar mostra `paused: true` mas dispara mesmo assim | Bug. Investigar `findDue` query no repo (deve filtrar `paused = 0`). |

## Smoke `habits` (skill 0006)

Pré: `pnpm run docker:up` no ar, Telegram conectado, container limpo (`docker volume rm whis_data` antes do up se quiser DB zerado).

### H1 — Criar hábito com lembrete pré-emptivo
- Gabriel: *"todo dia 17h me lembrar de me exercitar"*
- Esperado: Whis confirma criação + lembrete agendado pras 17h diário.
- Logs: `habit_created`, `mcp_inprocess_registered name=habits`.

### H1b — Criar sem horário (Whis pergunta)
- Gabriel: *"quero começar a meditar 10min todo dia"*
- Esperado: Whis pergunta sobre lembrete + check-in. Após confirmar, cria.

### H1c — Ativar check-in noturno geral
- Gabriel: *"quer que o Whis me cobre todo dia 21h sobre o que faltou"*
- Esperado: Whis confirma + cria scheduled-message agent recorrente único (não linkado a hábito).

### H3 — Log natural (duração)
- Gabriel: *"acabei de meditar 12min"*
- Esperado: log + *"Anotado: **meditar** 12min hoje. Streak: N."*. Log estruturado `habit_logged`.

### H5 — Log binário
- Gabriel: *"fui pra academia"*
- Esperado: log + confirmação curta com streak.

### H6 — Log retroativo
- Gabriel: *"meditei ontem, esqueci de avisar, 8min"*
- Esperado: Whis chama `habit_log(at='YYYY-MM-DD', value=8)`. Streak recalcula.

### H7 — Status rápido
- Gabriel: *"como tô hoje?"*
- Esperado: MarkdownV2 com agrupamento done/pending e streak por hábito.

### H8 — Render dashboard
- Gabriel: *"atualiza o dashboard"*
- Esperado: arquivo `context/habits/dashboard.md` criado/atualizado.
- Verificação: abrir no Obsidian, conferir header + legenda + seção por hábito + heatmap 30 dias visual.

### H9 — Lembrete pré-emptivo (pending)
- 17h: dispatcher dispara o scheduled-message #N criado em H1.
- Esperado: Whis envia mensagem curta de lembrete. Log `habit_reminder_sent { habit_id, schedule_id }`.

### H9b — Lembrete silenciado (já feito)
- Cenário: H5 ou H3 logou meditação/academia antes das 17h.
- 17h dispara → `habit_today_status` retorna `done` → Whis **não envia** nada.
- Verificação: log estruturado `habit_reminder_silenced { habit_id, schedule_id }` no `docker:logs:local`.

### H9c — Check-in noturno geral
- 21h: dispatcher dispara o scheduled-message do check-in (criado em H1c).
- Esperado: se algum hábito pending → Whis lista; se todos done → mensagem positiva curta.

### H10 — Editar hábito
- Gabriel: *"muda a meditação pra 15min"*
- Esperado: confirma → `habit_edit` → atualiza target. Histórico fica.

### H11 — Archive com cascade
- Gabriel: *"parei de fazer flexões, arquiva"*
- Esperado: Whis mostra resumo incluindo cancelamento do lembrete → confirma → `habit_archive` + `schedule_cancel` em sequência.

### H12 — Undo dentro de 5min
- Gabriel logou algo → Gabriel: *"desfaz, foi mal"*
- Esperado: `habit_log_undo` retorna `undone: true`. Confirmação curta.

### Troubleshooting (habits)

| Sintoma | Solução |
|---|---|
| `habit_render_dashboard` falha com EACCES | Verifica permissão de `context/habits/`. Container deve poder escrever. |
| Heatmap renderiza com caracteres "?" no Obsidian | Emojis Unicode não suportados pela fonte do sistema. Fallback ASCII em `dashboard.ts` (substituir `✅ 🟧 ⬜ ▫️` por `■ ▣ □ ·`). |
| Lembrete pré-emptivo dispara mesmo com `habit_today_status` retornando `done` | LLM ignorou instrução do payload. Reforçar wording no SKILL.md. |
| `habit_log_undo` retorna `undone: false` mesmo logo após o log | Verificar `clock` no env — janela é 5min relativa a `Date.now()` do worker. |

## 11. Quando o smoke passar

Marca Phase 14 (Task 36) como concluída editando
`docs/specs/0001-whis-mvp/spec.md` (mudar `status: draft` → `status: shipped`
+ `shipped: 2026-MM-DD`) e cria um `docs/specs/0001-whis-mvp/smoke-results.md`
documentando o pass — segue o template em Task 36 Step 7 do `tasks.md`.

Aí o MVP está shipped. Próxima iteração: skill nova (sugestão minha — algo
que use o vault, tipo `daily-note` ou `quick-task`) ou cron pra hábitos.

## 12. Risco conhecido (OAuth do Agent SDK)

A política da Anthropic atualizada em fev/2026 não autoriza explicitamente uso
do `CLAUDE_CODE_OAUTH_TOKEN` no Agent SDK programático. Tecnicamente funciona
hoje, mas pode ser revogado a qualquer momento.

**Plano de fallback** se quebrar: troca pra `ANTHROPIC_API_KEY` em `profile/.env`
— o SDK resolve a precedência sozinho, código não muda. Custo passa a ser por
token (~R$30-50/mês estimado pra uso pessoal esporádico).

Detalhes em `docs/specs/0001-whis-mvp/discovery-notes.md` seção 1.
