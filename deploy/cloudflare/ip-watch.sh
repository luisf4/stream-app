#!/usr/bin/env bash
# Reinicia o LiveKit quando o IP público da casa muda.
# O LiveKit descobre o IP só ao iniciar e o anuncia para o TURN do Cloudflare;
# com o IP antigo, a voz para de funcionar (site e chat continuam normais).
# Rodado pelo cron a cada 2 minutos (o install.sh configura isso).
set -euo pipefail
cd "$(dirname "$0")"

IP="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
[ -z "$IP" ] && exit 0

LAST_FILE=".last_ip"
LAST="$(cat "$LAST_FILE" 2>/dev/null || true)"

if [ "$IP" != "$LAST" ]; then
  echo "$IP" > "$LAST_FILE"
  if [ -n "$LAST" ]; then
    echo "$(date '+%F %T') IP mudou: $LAST -> $IP, reiniciando o LiveKit"
    docker compose restart livekit >/dev/null 2>&1 || true
  fi
fi
