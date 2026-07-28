# Self-hosted TTS + STT (Kokoro + faster-whisper)

Replaces OpenRouter for `ttsAudio` and `transcribeAudio` with a service you run
on your own VPS. DeepSeek (translations/analysis) is untouched — it never
went through OpenRouter. OpenRouter stays wired up as an automatic fallback:
if your VPS is down, the app keeps working (just paid again for that request).

## 1. Prepare the VPS

Needs Docker + Docker Compose. On Debian/Ubuntu:

```bash
curl -fsSL https://get.docker.com | sh
sudo apt-get install -y docker-compose-plugin
```

## 2. Copy this folder to the VPS

```bash
scp -r selfhost/ user@your-vps-ip:~/tts-stt
ssh user@your-vps-ip
cd ~/tts-stt
```

## 3. Configure

```bash
cp .env.example .env
nano .env   # set SELFHOST_TOKEN to: openssl rand -hex 32
```

## 4. Build and run

```bash
docker compose up -d --build
```

First build downloads the Kokoro model weights (~350MB) and installs
faster-whisper — can take several minutes on a 1 vCPU box. Then check:

```bash
curl http://127.0.0.1:8080/health
# {"ok":true}
```

## 5. Expose it over HTTPS

The container only listens on `127.0.0.1:8080` (not reachable from outside).
Put nginx + a real TLS cert in front if you want a public HTTPS URL for the
Cloud Function to call:

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo cp nginx.conf.example /etc/nginx/sites-available/tts-stt
sudo nano /etc/nginx/sites-available/tts-stt   # replace YOUR_DOMAIN_HERE
sudo ln -s /etc/nginx/sites-available/tts-stt /etc/nginx/sites-enabled/
sudo certbot --nginx -d your.domain.here
sudo systemctl reload nginx
```

Needs a domain name pointed at the VPS's IP (an A record). If you don't have
one, a free subdomain from something like DuckDNS works fine.

Firewall — only 80/443/22 need to be open publicly, 8080 stays internal:

```bash
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

## 6. Point the Cloud Functions at it

```bash
cd functions
export FIREBASE_TOKEN='...'
npx --yes firebase-tools functions:secrets:set SELFHOST_TTS_STT_URL --project french-da79a
# paste: https://your.domain.here

npx --yes firebase-tools functions:secrets:set SELFHOST_TOKEN --project french-da79a
# paste the same token that's in the VPS .env

npx --yes firebase-tools deploy --only functions:ttsAudio,functions:transcribeAudio --non-interactive --project french-da79a
```

Once both secrets are set and the functions redeployed, TTS/STT requests try
your VPS first (`engine === 'kokoro'` only — the app never selects any other
TTS engine right now) and silently fall back to OpenRouter if the VPS
times out or errors. Nothing changes for DeepSeek.

## Updating later

```bash
cd ~/tts-stt
git pull   # if you keep this folder as a git checkout, otherwise re-scp
docker compose up -d --build
```

## Rolling back

Unset either secret (or just stop the container) and the functions fall back
to OpenRouter-only behavior automatically — no code changes needed.

```bash
npx --yes firebase-tools functions:secrets:destroy SELFHOST_TTS_STT_URL --project french-da79a
npx --yes firebase-tools functions:secrets:destroy SELFHOST_TOKEN --project french-da79a
npx --yes firebase-tools deploy --only functions:ttsAudio,functions:transcribeAudio --non-interactive --project french-da79a
```
