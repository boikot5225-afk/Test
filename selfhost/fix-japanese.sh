#!/usr/bin/env bash
# Устанавливает японский g2p (misaki[ja]) в образ tts-stt и пересобирает его.
#
# Зачем: без него Japanese озвучивается через espeak-ng, а Kokoro выбрасывает
# все фонемы, которых нет в его словаре из 114 символов. espeak пишет японское
# /a/ как "ä", в словаре его нет, поэтому あさ доезжает до модели как "s" — речь
# превращается в кашу, при этом запрос успешен и звук играет. Кандзи espeak
# просто называет вслух ("Chinese letter").
#
# Скрипт намеренно ничего не делает молча: любая неудача печатает "НЕ СДЕЛАНО"
# и причину. Рядом с изменёнными файлами остаются .bak.
#
#   bash fix-japanese.sh
#
set -u
fail() { printf '\n!!! НЕ СДЕЛАНО: %s\n' "$1" >&2; return 1; }

run_fix() (
  set -u
  docker info >/dev/null 2>&1 || { fail "docker не отвечает. Это не сервер, либо демон не запущен."; return 1; }

  # Путь берём у самого docker: compose пишет рабочий каталог в метку контейнера.
  DIR="$(docker ps -a --filter name=tts-stt --format '{{.ID}}' | head -1 \
        | xargs -r docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null)"
  [ -n "${DIR:-}" ] && [ -d "$DIR" ] || \
    DIR="$(dirname "$(find / -xdev -name docker-compose.yml -path '*tts*' 2>/dev/null | head -1)")"
  [ -n "${DIR:-}" ] && [ -d "$DIR" ] || { fail "не нашёл папку сервиса. Покажите вывод: docker ps -a | grep tts"; return 1; }

  cd "$DIR" || { fail "не смог зайти в $DIR"; return 1; }
  [ -f server/requirements.txt ] && [ -f server/Dockerfile ] || { fail "в $DIR нет server/requirements.txt и server/Dockerfile"; return 1; }
  echo ">>> папка сервиса: $DIR"

  cp server/requirements.txt server/requirements.txt.bak
  cp server/Dockerfile server/Dockerfile.bak

  grep -q unidic-lite server/requirements.txt || printf 'misaki[ja]==0.9.*\nunidic-lite==1.0.*\n' >> server/requirements.txt
  grep -q 'cmake g++' server/Dockerfile || sed -i 's/espeak-ng ffmpeg curl/espeak-ng ffmpeg curl cmake g++/' server/Dockerfile
  grep -q 'from misaki import ja' server/Dockerfile || sed -i 's|^RUN pip install --no-cache-dir -r requirements.txt$|RUN pip install --no-cache-dir -r requirements.txt \&\& pip uninstall -y unidic \&\& python -c "from misaki import ja; ja.JAG2P()(chr(0x4ECA))"|' server/Dockerfile

  grep -q unidic-lite server/requirements.txt || { fail "requirements.txt не пропатчился"; return 1; }
  grep -q 'cmake g++' server/Dockerfile || { fail "в Dockerfile не нашлась строка с espeak-ng — покажите: cat $DIR/server/Dockerfile"; return 1; }
  grep -q 'from misaki import ja' server/Dockerfile || { fail "в Dockerfile не нашлась строка pip install -r requirements.txt — покажите: cat $DIR/server/Dockerfile"; return 1; }
  echo ">>> файлы пропатчены, собираю образ (10-15 минут, не закрывайте)"

  docker compose build --no-cache tts-stt || { fail "сборка упала — пришлите последние 20 строк вывода"; return 1; }
  docker compose up -d || { fail "контейнер не поднялся"; return 1; }

  echo ">>> жду запуска"
  sleep 20
  if docker compose logs --tail=80 tts-stt | grep -q 'misaki\[ja\] unavailable'; then
    docker compose logs --tail=80 tts-stt | grep misaki
    fail "misaki всё ещё не грузится — пришлите строку выше"
    return 1
  fi
  docker compose logs --tail=80 tts-stt | grep -q 'Application startup complete' || { fail "сервер не поднялся: docker compose logs --tail=80 tts-stt"; return 1; }
  printf '\n=== ГОТОВО: японский g2p загрузился ===\n'
)

if run_fix; then :; else printf '!!! ничего не изменено (или откатите: *.bak рядом с файлами)\n' >&2; fi
