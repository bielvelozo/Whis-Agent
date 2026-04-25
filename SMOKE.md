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
