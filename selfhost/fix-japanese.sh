#!/usr/bin/env bash
# Ставит японский g2p (misaki[ja]) в образ tts-stt и пересобирает его.
#
# Зачем. Без него японский фонемизируется через espeak-ng, а kokoro_onnx молча
# выбрасывает всё, чего нет в словаре модели (114 символов):
#     "".join(filter(lambda p: p in vocab, phonemes))
# espeak пишет японское /a/ как "ä", в словаре его нет — значит каждое "а"
# удаляется по дороге, и あさ доезжает до модели как "s". Запрос при этом
# успешен и звук играет, просто без гласных. Кандзи espeak не читает вовсе,
# а называет: "tʃˈaɪniːz lˈetə" — то самое "Chinese letter".
#
# Скрипт ничего не делает молча: любая неудача печатает "НЕ СДЕЛАНО" и причину,
# и не существует пути, где он напечатает успех, не подняв контейнер.
#
# Запускать так, чтобы обрыв ssh его не убил (сборка идёт минут десять, и
# мобильное соединение её не переживает):
#
#   setsid bash fix-japanese.sh > /tmp/fixja.log 2>&1 < /dev/null &
#   tail -f /tmp/fixja.log        # Ctrl-C выходит из просмотра, не из сборки
#
# Если связь всё-таки оборвётся — подключиться заново и снова tail /tmp/fixja.log.
# Скрипт можно запускать повторно сколько угодно: он видит уже исправленные
# файлы и не трогает их.
#
set -u
BRANCH=feature/77.42-toc138-fr-layout-performance

fail() { printf '\n!!! НЕ СДЕЛАНО: %s\n' "$1" >&2; }

patched() {  # все три признака исправленных файлов на месте?
  grep -q unidic-lite server/requirements.txt 2>/dev/null \
    && grep -q 'build-essential cmake' server/Dockerfile 2>/dev/null \
    && grep -q 'from misaki import ja' server/Dockerfile 2>/dev/null
}

# Установить misaki мало: app.py должен её вызывать. get_ja_g2p() появилась в
# том же коммите, что и Dockerfile, и если развёрнутый app.py старше или изменён
# локально, японский пойдёт через espeak при полностью исправном образе — то
# есть каша останется, а логи будут чистыми. Это худший из возможных исходов,
# поэтому он проверяется до сборки, а не после.
speaks_japanese() { grep -q 'get_ja_g2p' server/app.py 2>/dev/null; }

run_fix() (
  set -u
  docker info >/dev/null 2>&1 || { fail "docker не отвечает: это не сервер, либо демон не запущен"; return 1; }

  # Где лежит сервис — спрашиваем у самого docker, а не угадываем: compose
  # пишет свой рабочий каталог в метку контейнера.
  DIR="$(docker ps -a --filter name=tts-stt --format '{{.ID}}' | head -1 \
        | xargs -r docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null)"
  if [ -z "${DIR:-}" ] || [ ! -d "$DIR" ]; then
    DIR="$(dirname "$(find / -xdev -name docker-compose.yml -path '*tts*' 2>/dev/null | head -1)")"
  fi
  [ -n "${DIR:-}" ] && [ -d "$DIR" ] || { fail "не нашёл папку сервиса; покажите: docker ps -a | grep tts"; return 1; }
  cd "$DIR" || { fail "не смог зайти в $DIR"; return 1; }
  [ -f server/requirements.txt ] && [ -f server/Dockerfile ] \
    || { fail "в $DIR нет server/requirements.txt и server/Dockerfile"; return 1; }
  echo ">>> папка сервиса: $DIR"

  if patched; then
    echo ">>> файлы уже исправлены, пересобираю"
  else
    # Сначала git: так приезжает настоящий коммит, а не его пересказ.
    if git -C "$DIR" rev-parse --git-dir >/dev/null 2>&1 \
       && git -C "$DIR" fetch --quiet origin "$BRANCH" 2>/dev/null \
       && git -C "$DIR" checkout --quiet FETCH_HEAD 2>/dev/null \
       && patched; then
      echo ">>> взял исправление из git ($BRANCH)"
    else
      echo ">>> git не сработал, правлю файлы на месте"
      cp server/requirements.txt server/requirements.txt.bak
      cp server/Dockerfile server/Dockerfile.bak
      grep -q unidic-lite server/requirements.txt \
        || printf 'misaki[ja]==0.9.*\nunidic-lite==1.0.*\n' >> server/requirements.txt
      # build-essential, не g++: cmake конфигурирует open_jtalk генератором
      # Unix Makefiles, а make в python:3.11-slim нет, и сборка падает на
      # "Getting requirements to build wheel", не называя причину.
      grep -q 'build-essential cmake' server/Dockerfile \
        || sed -i 's/espeak-ng ffmpeg curl\( cmake g++\)\?/espeak-ng ffmpeg curl build-essential cmake/' server/Dockerfile
      grep -q 'from misaki import ja' server/Dockerfile \
        || sed -i 's|^RUN pip install --no-cache-dir -r requirements.txt$|RUN pip install --no-cache-dir -r requirements.txt \&\& pip uninstall -y unidic \&\& python -c "from misaki import ja; ja.JAG2P()(chr(0x4ECA))"|' server/Dockerfile
    fi
  fi

  patched || { fail "файлы так и не исправлены; покажите: cat $DIR/server/Dockerfile"; return 1; }
  speaks_japanese || { fail "в $DIR/server/app.py нет get_ja_g2p() — misaki встанет, но вызывать её будет некому, и японский останется кашей. Пришлите: git -C $DIR status --short"; return 1; }
  echo ">>> собираю образ (первый раз 10-15 минут: pyopenjtalk компилируется; повторно — из кэша)"

  # Без --no-cache: правка requirements.txt и Dockerfile сама аннулирует слои с
  # этого места, а всё выше (базовый образ, apt) переиспользуется. С --no-cache
  # повторный запуск после обрыва связи заново компилировал бы pyopenjtalk
  # десять минут вместо того, чтобы взять уже собранный слой.
  docker compose build tts-stt || { fail "сборка упала; пришлите последние 20 строк вывода"; return 1; }
  docker compose up -d || { fail "контейнер не поднялся"; return 1; }

  echo ">>> жду запуска"
  sleep 20
  if docker compose logs --tail=80 tts-stt | grep -q 'misaki\[ja\] unavailable'; then
    docker compose logs --tail=80 tts-stt | grep misaki
    fail "misaki всё ещё не грузится; пришлите строку выше"
    return 1
  fi
  docker compose logs --tail=80 tts-stt | grep -q 'Application startup complete' \
    || { fail "сервер не поднялся; покажите: docker compose logs --tail=80 tts-stt"; return 1; }
  printf '\n=== ГОТОВО: японский g2p загрузился, озвучка должна заработать ===\n'
)

run_fix || printf '!!! ничего не изменено (или откатите: *.bak рядом с файлами)\n' >&2
