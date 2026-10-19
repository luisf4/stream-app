#!/usr/bin/env bash
# Mantém o endereço do DuckDNS apontando para o IP da sua casa e reinicia o LiveKit
# quando o IP muda (ele anuncia o IP público para a voz/vídeo e só o descobre ao iniciar).
#
# Precisa no deploy/.env:
#   DUCKDNS_SUBDOMAIN=meuresenha      (só a parte antes de .duckdns.org)
#   DUCKDNS_TOKEN=xxxxxxxx-xxxx-...
#
# Rodado pelo cron a cada 5 minutos (o install.sh configura isso).
set -euo pipefail
cd "$(dirname "$0")"

get() { grep -E "^$1=" .env | head -n1 | cut -d= -f2-; }
SUBDOMAIN="$(get DUCKDNS_SUBDOMAIN || true)"
TOKEN="$(get DUCKDNS_TOKEN || true)"
[ -z "$SUBDOMAIN" ] || [ -z "$TOKEN" ] && exit 0

IP="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
[ -z "$IP" ] && exit 0

LAST_FILE=".last_ip"
LAST="$(cat "$LAST_FILE" 2>/dev/null || true)"

if [ "$IP" != "$LAST" ]; then
  RESULT="$(curl -fsS --max-time 10 "https://www.duckdns.org/update?domains=${SUBDOMAIN}&token=${TOKEN}&ip=${IP}" || true)"
  if [ "$RESULT" = "OK" ]; then
    echo "$IP" > "$LAST_FILE"
    echo "$(date '+%F %T') IP mudou: ${LAST:-nenhum} -> $IP"
    # Na primeira execução o LiveKit ainda pode não estar rodando; tudo bem.
    if [ -n "$LAST" ]; then
      docker compose restart livekit >/dev/null 2>&1 || true
    fi
  else
    echo "$(date '+%F %T') Falha ao atualizar o DuckDNS: $RESULT"
  fi
fi
