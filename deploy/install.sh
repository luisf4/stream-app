#!/usr/bin/env bash
# Instala o servidor do Resenha numa VPS ou servidor de casa (Ubuntu/Debian, LXC do Proxmox).
# Uso (dentro da pasta deploy/):  sudo bash install.sh
set -euo pipefail
cd "$(dirname "$0")"

if [ "$(id -u)" -ne 0 ]; then
  echo "Rode com sudo: sudo bash install.sh"
  exit 1
fi

echo "==> Resenha - instalação do servidor"

if ! command -v curl >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1 || ! command -v crontab >/dev/null 2>&1; then
  apt-get update && apt-get install -y curl openssl cron
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Instalando Docker..."
  curl -fsSL https://get.docker.com | sh
fi

if [ ! -f .env ]; then
  PUBLIC_IP="$(curl -fsS https://api.ipify.org || true)"
  DEFAULT_DOMAIN=""
  if [ -n "$PUBLIC_IP" ]; then
    DEFAULT_DOMAIN="${PUBLIC_IP//./-}.sslip.io"
  fi

  echo
  echo "Servidor em casa (IP muda)? Use o DuckDNS grátis: crie um subdomínio em https://www.duckdns.org"
  read -rp "Subdomínio DuckDNS (só a parte antes de .duckdns.org; Enter para não usar): " DUCKDNS_SUBDOMAIN
  DUCKDNS_TOKEN=""
  if [ -n "$DUCKDNS_SUBDOMAIN" ]; then
    DUCKDNS_SUBDOMAIN="${DUCKDNS_SUBDOMAIN%.duckdns.org}"
    while [ -z "$DUCKDNS_TOKEN" ]; do
      read -rp "Token do DuckDNS (aparece no topo do site): " DUCKDNS_TOKEN
    done
    DEFAULT_DOMAIN="${DUCKDNS_SUBDOMAIN}.duckdns.org"
  fi

  read -rp "Domínio [${DEFAULT_DOMAIN}]: " DOMAIN
  DOMAIN="${DOMAIN:-$DEFAULT_DOMAIN}"
  if [ -z "$DOMAIN" ]; then
    echo "Não consegui descobrir o IP público; informe um domínio."
    exit 1
  fi

  read -rp "Nome do servidor [Resenha]: " SERVER_NAME
  SERVER_NAME="${SERVER_NAME:-Resenha}"

  while true; do
    read -rsp "Senha para os amigos entrarem: " SERVER_PASSWORD
    echo
    [ -n "$SERVER_PASSWORD" ] && break
  done

  read -rp "Canais de voz (separados por vírgula) [Geral,Jogos,Filmes]: " CHANNELS
  CHANNELS="${CHANNELS:-Geral,Jogos,Filmes}"

  cat > .env <<EOF
DOMAIN=${DOMAIN}
SERVER_NAME=${SERVER_NAME}
SERVER_PASSWORD=${SERVER_PASSWORD}
JWT_SECRET=$(openssl rand -hex 32)
LIVEKIT_API_KEY=API$(openssl rand -hex 6)
LIVEKIT_API_SECRET=$(openssl rand -hex 32)
CHANNELS=${CHANNELS}
MAX_UPLOAD_MB=100
DUCKDNS_SUBDOMAIN=${DUCKDNS_SUBDOMAIN}
DUCKDNS_TOKEN=${DUCKDNS_TOKEN}
EOF
  chmod 600 .env
  echo "==> .env criado"
fi

# Firewall do sistema (se o ufw estiver ativo)
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  echo "==> Liberando portas no ufw..."
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 7881/tcp
  ufw allow 50000:50100/udp
fi

mkdir -p data

# DuckDNS: atualiza o IP agora (antes do HTTPS) e a cada 5 minutos via cron
if grep -qE '^DUCKDNS_TOKEN=.+' .env; then
  echo "==> Configurando DuckDNS..."
  chmod +x duckdns.sh
  bash duckdns.sh
  CRON_LINE="*/5 * * * * cd '$(pwd)' && bash duckdns.sh >> duckdns.log 2>&1"
  { crontab -l 2>/dev/null | grep -v 'duckdns.sh' || true; echo "$CRON_LINE"; } | crontab -
fi

echo "==> Subindo os containers..."
docker compose up -d --build

DOMAIN="$(grep '^DOMAIN=' .env | cut -d= -f2)"
echo
echo "Pronto! No app, use o endereço:  https://${DOMAIN}"
echo
echo "Lembre de liberar (no roteador de casa ou no painel da nuvem):"
echo "  TCP 80, 443, 7881  e  UDP 50000-50100"
