---
feature: google-calendar-skill
spec: "[[spec]]"
plan: "[[plan]]"
created: 2026-04-25
---
# Discovery — Google Calendar Skill (0003)

**Data:** 2026-04-25
**Verificado por:** Gabriel + Claude assistente

Source inspecionado: `npm pack @cocal/google-calendar-mcp@2.6.1` → tar extract → grep em `build/index.js` e `build/auth-server.js`.

## 1. `@cocal/google-calendar-mcp`

**Versão atual:** `2.6.1` (npm latest em 2026-04-25). Hoje aplicado `^2` no `agent/mcp.json` — npx pega 2.6.x atualizado, sem trocar major sem amendment.

**Engines:** não declarados explicitamente no metadata; runtime exige Node ≥18 (compat com Node 24 ✓).

## 2. `manage-accounts` flow — **callback HTTP, NÃO paste-code**

**Source:**

```js
// build/auth-server.js
this.portRange = { start: 3500, end: 3505 };

async startServerOnAvailablePort() {
  for (let port = this.portRange.start; port <= this.portRange.end; port++) {
    // testa porta livre, listen()
  }
}
```

**Como funciona:**

1. User chama `manage-accounts` com action `add` + `nickname` (ex: `personal`).
2. MCP escolhe primeira porta livre no range **3500-3505** e levanta HTTP server local.
3. MCP imprime URL de autorização do Google (com `redirect_uri = http://localhost:<porta>/oauth2callback`).
4. User abre URL no browser, autoriza no Google.
5. Google redireciona pro `http://localhost:<porta>/oauth2callback?code=...`.
6. MCP captura o code automaticamente, troca por tokens, persiste, fecha o server.

**Implicação CRÍTICA pra Whis no container:**

O MCP roda **dentro do container**. O browser do user roda **no host**. Pra browser conseguir bater em `http://localhost:3500/oauth2callback`, **o compose precisa expor a port range 3500-3505 do container pro host**.

**Não há fallback paste-code** verificado no source. O flow é estritamente callback HTTP.

**Amendment ao plan/tasks (Task 2):**

`infra/docker-compose.yml` precisa adicionar port mapping em `whis-worker`:

```yaml
ports:
  - "3500-3505:3500-3505"
```

(Sem isso, browser do host não alcança o auth server interno do container e setup G1 do user falha silenciosamente.)

**Amendment à Etapa 1 do SMOKE.md (Task 7):**

OAuth Desktop app credentials.json baixado do Google Cloud Console contém por default `redirect_uris: ["http://localhost"]` — Google é permissivo com `localhost:*` em apps Desktop type. **Sem necessidade de declarar portas específicas no Cloud Console.** MCP injeta a porta concreta no `redirect_uri` da request a cada flow.

## 3. Path dos tokens — `~/.config/google-calendar-mcp/tokens.json` (single file, multi-account)

**Source:**

```js
// build/index.js
function getTokenPath() {
  if (process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH) {
    return path.resolve(process.env.GOOGLE_CALENDAR_MCP_TOKEN_PATH);
  }
  const configDir = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return path.join(configDir, "google-calendar-mcp", "tokens.json");
}
```

**Path no container** (user `node`, `homedir()` = `/home/node`, sem `XDG_CONFIG_HOME` setado):

```
/home/node/.config/google-calendar-mcp/tokens.json
```

**Volume `gcal_tokens:/home/node/.config`** (Task 2 do plan) cobre. ✓

**Estrutura do arquivo: SINGLE file, multi-account.** Não é `personal.json` + `work.json`. É `tokens.json` com mapa interno:

```js
multiAccountTokens[this.accountMode] = cachedTokens;
// ex: { personal: { access_token, refresh_token, cached_email, ... }, work: { ... } }
```

**Override opcional** via env `GOOGLE_CALENDAR_MCP_TOKEN_PATH` se quiser custom path. Não usaremos — default é fine.

**Validação de account nicknames:** regex `^[a-z0-9_-]{1,64}$`. `personal` e `work` validam ✓. Reservados existem (não documentados aqui) mas não conflitam.

## 4. `GOOGLE_OAUTH_CREDENTIALS` env — aceita absolute path ✓

Confirmado no README e source. Vamos passar `/app/profile/google-credentials.json` (absoluto, dentro do bind mount `./profile:/app/profile:ro`).

## Verdict

**OK pra prosseguir** com Tasks 1-7, **com 2 amendments na implementação**:

1. **Task 2** ganha port mapping `3500-3505:3500-3505` no `whis-worker` do compose. Sem isso, G1 não funciona.
2. **Task 7 (SMOKE.md)** adicionar nota explícita: redirect_uris no Google Cloud Console pode ficar `http://localhost` (default Desktop) — MCP injeta a porta concreta.

**Open Questions resolvidas:**

- ~~Open Question 2 (one-shot vs two-shot)~~ — resolvido: callback HTTP one-shot na port range 3500-3505.
- ~~Open Question 3 (path dos tokens)~~ — resolvido: `~/.config/google-calendar-mcp/tokens.json` (volume cobre).

**Risco residual:**

Port range 3500-3505 hard-coded no source. Se WSL2 ou alguma rede do user tiver conflito, edição direta do source seria necessária — improvável pra setup pessoal com Docker Desktop padrão.
