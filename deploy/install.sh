#!/usr/bin/env bash
# Instala o servidor do Resenha numa VPS (Ubuntu/Debian) com as portas abertas.
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

PUBLIC_IP="$(curl -4 -fsS --max-time 10 https://api.ipify.org || true)"

if [ ! -f .env ]; then
  DEFAULT_DOMAIN=""
  if [ -n "$PUBLIC_IP" ]; then
    DEFAULT_DOMAIN="${PUBLIC_IP//./-}.sslip.io"
  fi

  echo
  echo "Já tem um app distribuído para os amigos? Use o MESMO endereço dele (VITE_SERVER_URL),"
  echo "assim ninguém precisa reinstalar. Sem domínio próprio, aceite o endereço sslip.io."
  read -rp "Domínio [${DEFAULT_DOMAIN}]: " DOMAIN
  DOMAIN="${DOMAIN:-$DEFAULT_DOMAIN}"
  DOMAIN="${DOMAIN#https://}"
  DOMAIN="${DOMAIN%/}"
  if [ -z "$DOMAIN" ]; then
    echo "Não consegui descobrir o IP público; informe um domínio."
    exit 1
  fi

  read -rp "Nome do servidor [Resenha]: " SERVER_NAME
  SERVER_NAME="${SERVER_NAME:-Resenha}"

  echo "Se o app já foi distribuído, use a mesma senha embutida nele (VITE_SERVER_PASSWORD)."
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
EOF
  chmod 600 .env
  echo "==> .env criado"
fi

DOMAIN="$(grep '^DOMAIN=' .env | cut -d= -f2)"

# O certificado HTTPS só sai se o domínio já apontar para esta máquina.
RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1 {print $1}' || true)"
if [ -n "$PUBLIC_IP" ] && [ "$RESOLVED" != "$PUBLIC_IP" ]; then
  echo
  echo "AVISO: ${DOMAIN} aponta para '${RESOLVED:-nada}', mas o IP desta máquina é ${PUBLIC_IP}."
  echo "  No painel de DNS, crie um registro A: ${DOMAIN} -> ${PUBLIC_IP}"
  echo "  No Cloudflare: proxy DESLIGADO (nuvem cinza, 'DNS only') e sem o CNAME/hostname do túnel."
  read -rp "Continuar mesmo assim? [s/N]: " CONTINUE
  [[ "$CONTINUE" =~ ^[sS]$ ]] || exit 1
fi

# Firewall do sistema (se o ufw estiver ativo)
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  echo "==> Liberando portas no ufw..."
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 7881/tcp
  ufw allow 7882/udp
fi

mkdir -p data

echo "==> Subindo os containers..."
docker compose up -d --build

# Atualiza sozinho a cada 10 minutos quando chega commit novo na main
if [ -d ../.git ]; then
  echo "==> Configurando a atualização automática..."
  CRON_LINE="*/10 * * * * cd '$(pwd)' && bash auto-update.sh >> auto-update.log 2>&1"
  { crontab -l 2>/dev/null | grep -v 'auto-update.sh' || true; echo "$CRON_LINE"; } | crontab -
fi

echo
echo "Pronto! No app, use o endereço:  https://${DOMAIN}"
echo
echo "Lembre de liberar no firewall do painel da cloud (entrada, de 0.0.0.0/0):"
echo "  TCP 80, 443, 7881  e  UDP 7882"
