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

First build downloads the Kokoro model weights (~350MB), installs
faster-whisper, and compiles pyopenjtalk from source — ten minutes or so on a
1 vCPU box. Chinese and Japanese both get misaki's own g2p (`misaki[zh]`,
`misaki[ja]`); espeak-ng covers the rest.

Japanese needs that g2p, it is not a nicety. Kokoro's `jf_` and `jm_` voices
were trained on misaki phonemes, and espeak-ng cannot read kanji at all — it
*names* them, so 朝 comes out of the speaker as "Chinese letter". The Dockerfile
therefore ends its pip step with `python -c "from misaki import ja; ja.JAG2P()"`:
**if Japanese g2p is missing, the build fails.** A build that succeeds is proof
the image has it.

(An earlier version of this file called `misaki[ja]` opt-in because unidic
downloads ~1GB. That gigabyte belongs to the `unidic` stub package, not to
misaki: `unidic-lite` is a complete 249MB dictionary needing no download, and
the Dockerfile drops the stub so fugashi uses it.)

Then check:

```bash
curl http://127.0.0.1:8080/health
# {"ok":true}
```

And confirm Japanese loaded — this should print **nothing**:

```bash
docker compose logs tts-stt | grep 'misaki\[ja\] unavailable'
```

That line is the whole of it. With espeak-ng standing in, the requests still
succeed and audio still plays — it just has no vowels in it. Kokoro drops every
phoneme outside its 114-symbol vocabulary without saying so, and espeak spells
Japanese /a/ as `ä`, which is not in it, so 「あさ」 reaches the model as `s`.
`scripts/check_ja_phonemes.py` in the app repo measures that directly.

If it prints a line, the container is running an image built before Japanese
was wired in. `fix-japanese.sh` in this folder patches an already-deployed
server in place and rebuilds it — it finds the service directory by asking
docker for the running container's compose working_dir rather than guessing a
path, and prints "НЕ СДЕЛАНО" with the reason on any failure instead of
finishing quietly. See also "Updating later".

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

`docker compose up -d --build` only rebuilds from the files that are on the
VPS. If you deployed by `scp` (step 2), the VPS has a **copy** — `git pull` in
the repo on your laptop does not touch it, and the rebuild will faithfully
rebuild the old image. Copy the folder again first:

```bash
# on your machine, in the repo
scp -r selfhost/server/ user@your-vps-ip:~/tts-stt/
```

```bash
# on the VPS
cd ~/tts-stt
git pull        # only if this folder really is a git checkout
grep -n unidic-lite server/requirements.txt   # new files have this line; old ones don't
docker compose build --no-cache tts-stt
docker compose up -d
docker compose logs tts-stt | grep 'misaki\[ja\] unavailable'   # expect no output
```

`--no-cache` because the Kokoro weights are fetched by a `RUN curl` layer that
Docker will happily reuse even when the layers above it changed.

## Rolling back

Unset either secret (or just stop the container) and the functions fall back
to OpenRouter-only behavior automatically — no code changes needed.

```bash
npx --yes firebase-tools functions:secrets:destroy SELFHOST_TTS_STT_URL --project french-da79a
npx --yes firebase-tools functions:secrets:destroy SELFHOST_TOKEN --project french-da79a
npx --yes firebase-tools deploy --only functions:ttsAudio,functions:transcribeAudio --non-interactive --project french-da79a
```
