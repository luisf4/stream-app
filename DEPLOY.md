# Deploy do servidor Resenha na nuvem

Guia passo a passo para colocar o servidor no ar e os amigos conectarem de qualquer lugar.

No final você terá uma VPS rodando 3 containers Docker:

| Container | O que faz | Portas |
|-----------|-----------|--------|
| `caddy`   | HTTPS automático (Let's Encrypt) e proxy | TCP 80, 443 |
| `app`     | Login, canais, chat, uploads (Node + SQLite) | interna (3000) |
| `livekit` | Voz, vídeo e compartilhamento de tela (WebRTC) | TCP 7881, UDP 50000-50100 |

> Quer rodar num servidor de casa (Proxmox) sem abrir portas no roteador? Veja o [DEPLOY-PROXMOX.md](DEPLOY-PROXMOX.md).

Você **não precisa comprar domínio**: o script usa `SEU-IP.sslip.io` (ex: `203-0-113-5.sslip.io`),
que aponta automaticamente para o seu IP e recebe certificado HTTPS de verdade.

---

## 1. Criar a VPS

Qualquer VPS com **Ubuntu 22.04/24.04 ou Debian 12**, **1 vCPU e 1–2 GB de RAM** já basta para um grupo de amigos.

| Provedor | Plano sugerido | Preço | Observação |
|----------|----------------|-------|------------|
| Oracle Cloud | Ampere A1 (ARM) | grátis | Precisa de cartão para cadastro; tem firewall extra (ver passo 2) |
| Hetzner | CX22 | ~€4/mês | 20 TB de tráfego incluso, muito simples |
| DigitalOcean / Vultr | 1 GB | ~US$6/mês | Tráfego menor incluso |

**Tráfego:** uma transmissão 1080p60 usa ~4–7 Mbps **por espectador**. 3 amigos assistindo 3h por dia ≈ 300 GB/mês.

Ao criar a VPS, escolha login por **chave SSH** (mais seguro) e anote o **IP público**.

---

## 2. Liberar as portas no firewall da nuvem

No painel do provedor (Security Group / Firewall / Security List), libere **entrada** de qualquer origem (`0.0.0.0/0`):

| Protocolo | Portas | Para quê |
|-----------|--------|----------|
| TCP | 22 | SSH (já costuma vir liberada) |
| TCP | 80 | Emissão do certificado HTTPS |
| TCP | 443 | App (API, chat, sinalização da voz) |
| TCP | 7881 | Voz/vídeo quando UDP está bloqueado |
| UDP | 50000-50100 | Voz/vídeo (principal) |

### Só na Oracle Cloud

Além da Security List, as imagens Ubuntu da Oracle vêm com regras de `iptables` que bloqueiam tudo.
Depois de entrar na VPS (passo 3), rode:

```bash
sudo iptables -I INPUT -p tcp -m multiport --dports 80,443,7881 -j ACCEPT
sudo iptables -I INPUT -p udp --dport 50000:50100 -j ACCEPT
sudo netfilter-persistent save
```

---

## 3. Enviar o projeto para a VPS

Só as pastas `server/` e `deploy/` são necessárias no servidor.

### Opção A — pelo Windows, sem Git (PowerShell)

O Windows 11 já vem com `tar` e `scp`. Na pasta do projeto:

```bash
tar -czf resenha.tar.gz --exclude=node_modules --exclude=dist --exclude=data --exclude=.env server deploy
```

```bash
scp resenha.tar.gz ubuntu@SEU_IP:~
```

Troque `ubuntu` pelo usuário da sua VPS (Oracle: `ubuntu`; Hetzner: `root`).
Depois entre na VPS e extraia:

```bash
ssh ubuntu@SEU_IP
```

```bash
mkdir -p ~/resenha && tar -xzf ~/resenha.tar.gz -C ~/resenha && cd ~/resenha/deploy
```

### Opção B — com Git

O código está público em https://github.com/luisf4/stream-app:

```bash
git clone https://github.com/luisf4/stream-app.git resenha && cd resenha/deploy
```

---

## 4. Rodar o instalador

Dentro de `deploy/`:

```bash
sudo bash install.sh
```

O script vai:

1. Instalar o Docker (se ainda não tiver)
2. Perguntar:
   - **Domínio** — aperte Enter para usar `SEU-IP.sslip.io`
   - **Nome do servidor** — aparece no topo do app
   - **Senha** — a que você vai passar para os amigos
   - **Canais de voz** — ex: `Geral,Jogos,Filmes`
3. Gerar as chaves secretas e criar o arquivo `deploy/.env`
4. Liberar as portas no `ufw` (se estiver ativo)
5. Construir e subir os containers

No final ele mostra o endereço, por exemplo:

```
Pronto! No app, use o endereço:  https://203-0-113-5.sslip.io
```

> A primeira subida leva 1–3 minutos (build da imagem + emissão do certificado).

---

## 5. Conferir se está tudo no ar

```bash
docker compose ps
```

Os três serviços (`app`, `livekit`, `caddy`) devem aparecer como `running`.

Teste a API (do seu PC ou da VPS):

```bash
curl https://SEU-DOMINIO/api/health
```

Resposta esperada: `{"ok":true}`.

Agora abra o Resenha no Windows (`npm run dev` em `client/`), coloque o endereço, a senha e um apelido, entre num canal de voz
e peça para um amigo entrar também. **Teste de uma rede diferente** (ex: celular roteando 4G) para
ter certeza de que as portas UDP estão abertas.

---

## 6. Configurar o app com o seu servidor (antes do build)

Para os amigos **só digitarem o apelido**, o endereço e a senha do servidor ficam embutidos
no instalador. Isso é feito uma vez, no seu PC, antes de gerar o `.exe`.

1. Na pasta `client/`, copie o exemplo:

   ```bash
   copy .env.example .env
   ```

2. Edite `client/.env` com os dados que o `install.sh` mostrou:

   ```ini
   VITE_SERVER_URL=203-0-113-5.sslip.io
   VITE_SERVER_PASSWORD=a-senha-que-voce-definiu
   ```

   | Variável | O que colocar |
   |----------|---------------|
   | `VITE_SERVER_URL` | O endereço do passo 4 (com ou sem `https://`). Portas e caminhos do LiveKit **não** entram aqui: o servidor informa tudo ao app automaticamente. |
   | `VITE_SERVER_PASSWORD` | A mesma `SERVER_PASSWORD` do `deploy/.env` |

3. Gere o instalador:

   ```bash
   cd client
   npm run dist
   ```

Pronto: ao abrir o app, a tela de login pede **só o apelido**.

O `.env` é lido **na hora do build** (e também no `npm run dev`, depois de reiniciar).
**Sem** o `client/.env`, ou com as variáveis vazias, o app volta a pedir endereço + senha + apelido
(útil para testar com `localhost:3000`).

> ⚠️ **Se você trocar a senha ou o domínio do servidor**, atualize o `client/.env`, gere e mande um
> instalador novo: o app antigo vai mostrar "A senha embutida neste app está desatualizada".
>
> ⚠️ Quem tem o `.exe` consegue entrar no servidor (a senha vai dentro dele). Mande o instalador só
> para os amigos. O `.env` está no `.gitignore` para não vazar se você usar Git.

---

## 7. Mandar o app para os amigos

Envie `client/dist/Resenha-Setup-1.0.0.exe` (só ele, não precisa mandar endereço nem senha).
Na primeira execução o Windows mostra "O Windows protegeu o computador" (o app não é assinado):
**Mais informações → Executar assim mesmo**.

---

## Manutenção

### Ver logs

```bash
docker compose logs -f app
```

```bash
docker compose logs -f livekit
```

```bash
docker compose logs -f caddy
```

### Atualizar o servidor depois de mudar o código

Envie de novo a pasta `server/` (passo 3) e, dentro de `deploy/`:

```bash
docker compose up -d --build
```

### Atualizar LiveKit e Caddy para a versão mais nova

```bash
docker compose pull && docker compose up -d
```

### Trocar a senha (ou nome, limite de upload)

Edite `deploy/.env` e aplique:

```bash
nano .env
```

```bash
docker compose up -d
```

Trocar a senha **desloga todo mundo**. Atualize também o `VITE_SERVER_PASSWORD` no `client/.env`,
gere o instalador de novo (passo 6) e mande para os amigos.

### Variáveis do `.env`

| Variável | Descrição |
|----------|-----------|
| `DOMAIN` | Domínio público (ex: `203-0-113-5.sslip.io` ou `resenha.seudominio.com`) |
| `SERVER_NAME` | Nome exibido no app |
| `SERVER_PASSWORD` | Senha para entrar |
| `JWT_SECRET` | Segredo das sessões (não compartilhe) |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | Chaves do LiveKit (não compartilhe) |
| `CHANNELS` | Canais criados na **primeira** subida (depois, gerencie pelo app) |
| `MAX_UPLOAD_MB` | Tamanho máximo de arquivo no chat (padrão 100) |

### Backup

Mensagens (SQLite) e arquivos enviados ficam em `deploy/data/`:

```bash
tar -czf ~/backup-resenha-$(date +%F).tar.gz -C ~/resenha/deploy data .env
```

Para restaurar numa VPS nova: extraia o backup dentro de `deploy/` antes de rodar `docker compose up -d --build`.

### Usar um domínio próprio

1. No seu provedor de DNS, crie um registro **A** apontando `resenha.seudominio.com` para o IP da VPS
2. Edite `DOMAIN=` no `deploy/.env`
3. `docker compose up -d`
4. Troque o `VITE_SERVER_URL` no `client/.env`, gere o instalador de novo (passo 6) e mande para os amigos

---

## Problemas comuns

| Sintoma | Causa provável | Solução |
|---------|----------------|---------|
| App diz "Não foi possível conectar ao servidor" | Porta 443 fechada ou certificado ainda não emitido | Confira o passo 2; veja `docker compose logs caddy` |
| Caddy mostra erro de certificado / ACME | Porta 80 fechada | Libere TCP 80 (Let's Encrypt precisa dela) |
| Chat funciona, mas a voz fica em "Conectando…" ou cai | Portas do LiveKit bloqueadas | Libere UDP 50000-50100 e TCP 7881; na Oracle, rode os comandos de `iptables` |
| Entra na voz mas ninguém se ouve | UDP bloqueado na rede de alguém | Confirme TCP 7881 aberto (fallback automático) |
| `install.sh: $'\r': command not found` | Arquivo copiado com quebras de linha do Windows | `sed -i 's/\r$//' install.sh` e rode de novo |
| "Senha do servidor incorreta" para todos | Senha mudou no `.env` | Use a senha atual (`grep SERVER_PASSWORD .env`) |
| Upload falha com arquivo grande | Acima de `MAX_UPLOAD_MB` | Aumente no `.env` e `docker compose up -d` |
| VPS sem memória (containers reiniciando) | RAM de 1 GB apertada no build | Crie swap: `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile` |

---

## Segurança

- Só os amigos com a senha conseguem entrar; as sessões duram 30 dias.
- Os arquivos enviados no chat ficam acessíveis por um link longo e aleatório (não listável) —
  quem tiver o link consegue abrir.
- Mantenha o `deploy/.env` privado (o script já cria com permissão `600`).
- Atualize o sistema da VPS de vez em quando: `sudo apt update && sudo apt upgrade -y`.
