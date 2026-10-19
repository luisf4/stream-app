# Deploy em casa no Proxmox (sem abrir portas)

Guia para rodar **tudo** do Resenha (servidor, chat e LiveKit) num container do seu Proxmox,
**sem abrir nenhuma porta no roteador**, usando o Cloudflare. Os amigos só instalam o app.

```
                       ┌──────────── Cloudflare ────────────┐
 App Resenha ──HTTPS──>│ Tunnel (site, chat, sinalização)   │<── cloudflared ──┐
      │                │                                    │                  │  seu Proxmox
      └──voz/vídeo────>│ TURN  (retransmite áudio e vídeo)  │<── LiveKit ──────┤  (só conexões
                       └────────────────────────────────────┘                  │   de saída)
                                                                    app (chat)─┘
```

- **Cloudflare Tunnel:** leva o site, o chat e a sinalização da voz até o seu Proxmox
- **TURN do Cloudflare (Realtime):** retransmite o áudio e o vídeo. O Tunnel não passa UDP, então a
  mídia vai do app para o TURN do Cloudflare, e de lá para o LiveKit na sua casa.

Os dois funcionam por **conexões de saída** do seu servidor, por isso nada precisa ser aberto no roteador
(e funciona até com CGNAT).

### O que você vai precisar

| Item | Custo |
|------|-------|
| Um **domínio** comprado no Cloudflare | ~US$10/ano para `.com` |
| **Cloudflare Tunnel** | grátis |
| **TURN do Cloudflare** | grátis até uma cota mensal alta (confira em https://developers.cloudflare.com/realtime/turn/), suficiente para um grupo de amigos |
| Proxmox com 1 container: 2 núcleos, 2 GB RAM, 16 GB de disco | — |

---

## 1. Comprar o domínio

1. Crie uma conta em https://dash.cloudflare.com
2. Vá em **Domain Registration → Register Domains**, procure um nome e compre
   (o Cloudflare vende a preço de custo)

Neste guia o domínio de exemplo é `seudominio.com`.

---

## 2. Criar o TURN (áudio e vídeo)

1. No painel do Cloudflare, abra **Realtime** (no menu lateral; em contas antigas pode aparecer como **Calls**)
2. Entre em **TURN Server → Create** e dê um nome (ex: `resenha`)
3. Anote os dois valores que aparecem:
   - **Turn Token ID**
   - **API Token** (aparece **uma vez só**; copie agora)

---

## 3. Criar o túnel

1. Abra https://one.dash.cloudflare.com (Zero Trust). Na primeira vez, ele pede para escolher um nome de
   equipe e o plano **Free** (pode pedir um cartão, mas o plano Free não cobra).
2. Vá em **Networks → Tunnels → Create a tunnel → Cloudflared**
3. Dê um nome (ex: `resenha`) e salve
4. Na tela de instalação, escolha **Docker** e copie **só o token**: o texto longo depois de `--token`
   (começa com `eyJ...`). Não precisa rodar o comando que aparece lá.
5. Avance para **Public Hostnames** (ou **Routes → Published application**) e crie **dois** endereços:

   | Subdomain | Domain | Type | URL | Para quê |
   |-----------|--------|------|-----|----------|
   | `resenha` | `seudominio.com` | HTTP | `localhost:3000` | App, login e chat |
   | `voz` | `seudominio.com` | HTTP | `localhost:7880` | Sinalização da voz (LiveKit) |

6. Salve.

> O WebSocket já vem ligado no Cloudflare. Se tiver mexido nisso, confira em **seu domínio → Network → WebSockets: On**.

---

## 4. Criar o container no Proxmox

Recomendado: **container LXC Debian 12** (leve). Uma VM Debian/Ubuntu também funciona.

1. No Proxmox: **local → CT Templates → Templates** e baixe `debian-12-standard`
2. **Create CT**:
   - Template: `debian-12-standard`
   - Disco: 16 GB · CPU: 2 núcleos · Memória: 2048 MB · Swap: 512 MB
   - Rede: DHCP serve (não precisa de IP fixo, já que nada aponta para o container)
3. **Antes de iniciar**, em **Options → Features**, marque **nesting** e **keyctl** (o Docker precisa)
4. Inicie o container e abra o **Console**

---

## 5. Enviar o projeto para o container

> Se você criou o túnel com o container temporário `cloudflared-temp`, apague-o antes do passo 6
> (o `install.sh` sobe o túnel definitivo): `docker rm -f cloudflared-temp`

### Opção A — pelo GitHub (recomendado)

O código está em https://github.com/luisf4/stream-app (público). **No console do container**:

```bash
apt-get install -y git && git clone https://github.com/luisf4/stream-app.git /root/resenha && cd /root/resenha/deploy/cloudflare
```

Senhas e tokens do projeto não vão para o GitHub (os `.env` estão no `.gitignore`), então o repositório
pode ser público sem problema.

Para atualizar depois: `cd /root/resenha && git pull && cd deploy/cloudflare && docker compose up -d --build`.

### Opção B — sem GitHub (arquivo compactado)

Só as pastas `server/` e `deploy/` são necessárias.

**No seu PC (PowerShell)**, na pasta do projeto, empacote e envie para o host Proxmox:

```bash
tar -czf resenha.tar.gz --exclude=node_modules --exclude=dist --exclude=data --exclude=.env server deploy
```

```bash
scp resenha.tar.gz root@IP_DO_PROXMOX:/root/
```

**No shell do host Proxmox**, copie para dentro do container (troque `101` pelo ID do container):

```bash
pct push 101 /root/resenha.tar.gz /root/resenha.tar.gz
```

**No console do container:**

```bash
mkdir -p /root/resenha && tar -xzf /root/resenha.tar.gz -C /root/resenha && cd /root/resenha/deploy/cloudflare
```

---

## 6. Rodar o instalador

Ainda no container, em `/root/resenha/deploy/cloudflare`:

```bash
bash install.sh
```

Responda:

| Pergunta | O que colocar |
|----------|---------------|
| Nome do servidor, senha, canais | como quiser |
| Endereço do app | `resenha.seudominio.com` |
| Endereço da voz | aperte Enter (usa `voz.seudominio.com`) |
| Token do túnel | o token do passo 3 |
| Turn Token ID / API Token | os valores do passo 2 |

O instalador instala o Docker, gera as chaves do LiveKit, sobe `app`, `livekit` e `cloudflared`
e agenda o `ip-watch.sh`, que reinicia o LiveKit sozinho se o IP da sua casa mudar.

### Conferir

```bash
docker compose ps
```

Os três serviços devem aparecer como `running`, e no painel do Cloudflare o túnel deve estar **HEALTHY**.
Abra no navegador `https://resenha.seudominio.com/api/health`: deve aparecer `{"ok":true}`.

O log do servidor confirma que o TURN está ativo:

```bash
docker compose logs app | grep pronto
```

Deve terminar com `(mídia via TURN do Cloudflare)`.

---

## 7. Gerar o app para os amigos

No seu PC, crie o `client/.env` (copie de `client/.env.example`):

```ini
VITE_SERVER_URL=resenha.seudominio.com
VITE_SERVER_PASSWORD=a-senha-do-passo-6
```

E gere o instalador:

```bash
cd client
npm run dist
```

Mande `client/dist/Resenha-Setup-1.0.0.exe` para os amigos. Eles só digitam o apelido.
O endereço da voz e o TURN não entram no app: o servidor passa tudo automaticamente.

---

## Manutenção

Todos os comandos são rodados em `/root/resenha/deploy/cloudflare` no container.

| Tarefa | Comando |
|--------|---------|
| Ver logs do servidor | `docker compose logs -f app` |
| Ver logs da voz | `docker compose logs -f livekit` |
| Ver logs do túnel | `docker compose logs -f cloudflared` |
| Aplicar mudanças no `.env` | `docker compose up -d` |
| Atualizar depois de mudar o código (envie `server/` de novo) | `docker compose up -d --build` |
| Atualizar LiveKit e cloudflared | `docker compose pull && docker compose up -d` |
| Backup (mensagens + arquivos) | `tar -czf /root/backup-resenha-$(date +%F).tar.gz data .env` |

Dica: agende um **Backup** do container no Proxmox (Datacenter → Backup), que já leva tudo junto.

Trocar a senha **desloga todo mundo**. Atualize também `VITE_SERVER_PASSWORD` no `client/.env`
e mande um instalador novo.

O uso do TURN aparece no painel do Cloudflare em **Realtime → TURN Server**.

---

## Problemas comuns

| Sintoma | Causa provável | Solução |
|---------|----------------|---------|
| Docker não sobe no LXC (`permission denied`, erro de `sysctl` ou `overlay`) | Faltou **nesting/keyctl** | Desligue o container, marque em Options → Features e ligue de novo (ou use uma VM) |
| Túnel aparece **DOWN** / **INACTIVE** | Token errado ou sem internet | `docker compose logs cloudflared`; corrija `CLOUDFLARE_TUNNEL_TOKEN` no `.env` e `docker compose up -d` |
| Erro **502 Bad Gateway** | Public Hostname apontando errado | `resenha` → `localhost:3000` e `voz` → `localhost:7880`, ambos tipo `HTTP` |
| Ao entrar na voz: "Falha ao preparar a conexão de voz (TURN)" | Turn Token ID ou API Token errados | Veja `docker compose logs app`; corrija `CLOUDFLARE_TURN_*` no `.env` e `docker compose up -d` |
| Voz fica em "Conectando…" e cai | O LiveKit não descobriu o IP público da casa, ou o roteador bloqueia UDP de saída | Em `docker compose logs livekit`, a linha `using external IPs` deve mostrar o seu IP público (ex: `179.x.x.x/192.168.x.x`); se não mostrar, `docker compose restart livekit` |
| A voz parou depois que a internet caiu e voltou | O IP de casa mudou | O `ip-watch.sh` reinicia o LiveKit sozinho em até 2 minutos (histórico em `ip-watch.log`) |
| Upload falha com arquivo grande | Limite de 100 MB do Cloudflare (plano grátis) | Mantenha `MAX_UPLOAD_MB=95` |
| `install.sh: $'\r': command not found` | Arquivo com quebras de linha do Windows | `sed -i 's/\r$//' install.sh` |

---

## Alternativa: sem Cloudflare, abrindo portas

Se um dia preferir não usar o Cloudflare, dá para rodar no mesmo container com as portas abertas no
roteador e um endereço grátis do **DuckDNS** (que acompanha a troca de IP de casa):

1. Confirme que sua internet **não tem CGNAT**: o IP em https://api.ipify.org deve ser igual ao IP WAN
   mostrado no roteador. Se for diferente, peça "IP público" para a operadora.
2. Crie um subdomínio em https://www.duckdns.org e anote o token
3. Dê **IP fixo** ao container e encaminhe no roteador para ele: **TCP 80, 443, 7881** e **UDP 50000-50100**
4. No container, use a pasta `deploy/` (não a `deploy/cloudflare/`) e rode `bash install.sh`,
   informando o subdomínio e o token do DuckDNS
5. No `client/.env`, use `VITE_SERVER_URL=seusubdominio.duckdns.org`

O `deploy/duckdns.sh` atualiza o IP no DuckDNS a cada 5 minutos e reinicia o LiveKit quando ele muda.
Manutenção e problemas comuns desse modo estão no [DEPLOY.md](DEPLOY.md).
