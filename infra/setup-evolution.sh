#!/bin/sh
# Cria a instância "whis" na Evolution API e renderiza o QR code pra parear o número.
# Idempotente: se a instância já existir, só re-renderiza o QR.
set -eu

# Carrega variáveis do profile/.env
if [ ! -f profile/.env ]; then
  echo "error: profile/.env não encontrado. Copie de profile/.env.example primeiro." >&2
  exit 1
fi
# shellcheck disable=SC1091
. ./profile/.env

EVOLUTION_HOST_URL="${EVOLUTION_HOST_URL:-http://localhost:8081}"
INSTANCE="${EVOLUTION_INSTANCE:-whis}"

echo "▶  Aguardando Evolution API em ${EVOLUTION_HOST_URL}..."
for i in $(seq 1 30); do
  if curl -fsS "${EVOLUTION_HOST_URL}/" -H "apikey: ${EVOLUTION_API_KEY}" >/dev/null 2>&1; then
    echo "✓  Evolution API respondendo."
    break
  fi
  sleep 2
  if [ "$i" = "30" ]; then
    echo "✗  Evolution API não respondeu em 60s. Verifique se 'pnpm run docker:up' subiu o serviço." >&2
    exit 1
  fi
done

# Verifica se a instância já existe
if curl -fsS "${EVOLUTION_HOST_URL}/instance/connectionState/${INSTANCE}" \
    -H "apikey: ${EVOLUTION_API_KEY}" >/dev/null 2>&1; then
  echo "ℹ  Instância '${INSTANCE}' já existe."
else
  echo "▶  Criando instância '${INSTANCE}'..."
  curl -fsS -X POST "${EVOLUTION_HOST_URL}/instance/create" \
    -H "Content-Type: application/json" \
    -H "apikey: ${EVOLUTION_API_KEY}" \
    -d "{\"instanceName\": \"${INSTANCE}\", \"integration\": \"WHATSAPP-BAILEYS\", \"qrcode\": true}" \
    >/dev/null
  echo "✓  Instância criada."
fi

# Pega QR code
echo "▶  Buscando QR code..."
QR_RESPONSE=$(curl -fsS "${EVOLUTION_HOST_URL}/instance/connect/${INSTANCE}" \
  -H "apikey: ${EVOLUTION_API_KEY}")

QR_BASE64=$(echo "$QR_RESPONSE" | sed -n 's/.*"base64":"data:image\/png;base64,\([^"]*\)".*/\1/p')

if [ -z "$QR_BASE64" ]; then
  echo "ℹ  QR code não disponível — instância pode já estar conectada."
  echo "   Estado atual:"
  curl -fsS "${EVOLUTION_HOST_URL}/instance/connectionState/${INSTANCE}" \
    -H "apikey: ${EVOLUTION_API_KEY}"
  echo ""
  exit 0
fi

# Salva PNG temporário e tenta abrir
TMPFILE=$(mktemp -t whis-qr-XXXXXX.png)
echo "$QR_BASE64" | base64 -d > "$TMPFILE"
echo "✓  QR code salvo em: $TMPFILE"
echo ""
echo "Escaneie no WhatsApp:"
echo "  Configurações → Aparelhos conectados → Conectar dispositivo"
echo ""
echo "Ou acesse o painel da Evolution em: ${EVOLUTION_HOST_URL}"
echo ""

# Tenta abrir automaticamente (best-effort)
if command -v open >/dev/null 2>&1; then
  open "$TMPFILE" || true
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$TMPFILE" || true
fi
