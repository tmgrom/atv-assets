#!/usr/bin/env bash
#
# build.sh — двухфайловая сборка клиента для Micro IPTV.
#
# Тянет с raw.githubusercontent.com только два файла оригинала:
#   bundle.js       — собранный клиент целиком (самодостаточный)
#   application.js  — вторичный загрузчик
# и приклеивает наш патч kp-title-filter.js в конец bundle.js.
#
# Плюс три иконки из img/: bundle.js подставляет их напрямую как
# baseURL + "img/<файл>" — это значки рейтингов на карточках. Без них
# приложение работает, но вместо значков будут битые картинки.
#
# Использование:
#   ./build.sh            — собрать (без коммита)
#   ./build.sh --push     — собрать, закоммитить и запушить
#   ./build.sh --push -m "текст коммита"
#
# Рядом со скриптом должны лежать:
#   kp-title-filter.js    — наш патч (обязательно)
#   blocklist.json        — список правил (скрипт его не трогает)

set -euo pipefail

# ===== НАСТРОЙКИ ==================================================

SRC_OWNER="kpapplication"
SRC_REPO="atv4"
SRC_BRANCH="main"

PATCH_FILE="kp-title-filter.js"

# Что тянем. Порядок важен только для вывода.
FILES="bundle.js application.js"

# Иконки из img/ — ровно те, на которые ссылается сам bundle.js.
ICONS="imdb.png kinopoisk.png kinopub.png"

# Минимальные разумные размеры, байт — защита от страницы ошибки.
MIN_BUNDLE=200000
MIN_APPLICATION=2000
MIN_ICON=500

# ===== СЛУЖЕБНОЕ ==================================================

cd "$(dirname "$0")"

c_red() { printf '\033[31m%s\033[0m\n' "$1"; }
c_grn() { printf '\033[32m%s\033[0m\n' "$1"; }
c_dim() { printf '\033[2m%s\033[0m\n'  "$1"; }
die()   { c_red "✗ $1"; exit 1; }

DO_PUSH=0
COMMIT_MSG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --push) DO_PUSH=1; shift ;;
    -m)     shift; COMMIT_MSG="${1:-}"; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "неизвестный аргумент: $1 (см. --help)" ;;
  esac
done

command -v curl >/dev/null 2>&1 || die "не найден curl"
[ -f "$PATCH_FILE" ] || die "рядом нет ${PATCH_FILE}"

# BSD и GNU stat спорят про флаги — пробуем оба.
filesize() {
  if stat -f%z "$1" >/dev/null 2>&1; then stat -f%z "$1"; else stat -c%s "$1"; fi
}

min_size_for() {
  case "$1" in
    bundle.js)      echo "$MIN_BUNDLE" ;;
    application.js) echo "$MIN_APPLICATION" ;;
    *.png|*.jpg)    echo "$MIN_ICON" ;;
    *)              echo 1 ;;
  esac
}

# Отдали файл или HTML-страницу ошибки? Смотрим начало.
# -a: иконки бинарные, без него grep откажется их читать.
looks_like_html() {
  head -c 512 "$1" | LC_ALL=C tr 'A-Z' 'a-z' | grep -qa '<!doctype html\|<html'
}

# Скачать один файл и проверить, что это не заглушка.
# $1 — путь относительно корня оригинала, $2 — куда положить.
fetch() {
  c_dim "  ↓ ${RAW_BASE}/$1"
  curl -fsSL --retry 3 --retry-delay 2 -o "$2" "${RAW_BASE}/$1" \
    || die "$1 не скачался"

  [ -s "$2" ] || die "$1 пустой"
  looks_like_html "$2" && die "вместо $1 пришла HTML-страница"

  size="$(filesize "$2")"
  min="$(min_size_for "$(basename "$1")")"
  [ "$size" -ge "$min" ] || die "$1 подозрительно мал: ${size} б (ждали от ${min})"
  c_dim "    ${size} б"
}

# ===== СКАЧИВАНИЕ =================================================

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

RAW_BASE="https://raw.githubusercontent.com/${SRC_OWNER}/${SRC_REPO}/${SRC_BRANCH}"

echo "Скачиваю оригинал (${SRC_OWNER}/${SRC_REPO}@${SRC_BRANCH})…"

for f in $FILES; do
  fetch "$f" "${TMP}/${f}"
done

mkdir -p "${TMP}/img"
for i in $ICONS; do
  fetch "img/${i}" "${TMP}/img/${i}"
done

# ===== СБОРКА =====================================================

echo "Приклеиваю патч к bundle.js…"
cat "${TMP}/bundle.js" "$PATCH_FILE" > "${TMP}/bundle.patched.js"
mv "${TMP}/bundle.patched.js" "${TMP}/bundle.js"

# Патч дописан в конец — если он битый, приложение не стартует вообще.
if command -v node >/dev/null 2>&1; then
  node --check "${TMP}/bundle.js" >/dev/null 2>&1 \
    || die "после патча bundle.js не парсится — правьте ${PATCH_FILE}"
  c_dim "  синтаксис bundle.js: OK"
fi

for f in $FILES; do
  mv "${TMP}/${f}" "./${f}"
done

mkdir -p img
for i in $ICONS; do
  mv "${TMP}/img/${i}" "./img/${i}"
done

VER="$(sed -n 's/.*APP_VERSION *= *"\([^"]*\)".*/\1/p' application.js | head -1)"
[ -n "$VER" ] && c_dim "  версия оригинала: ${VER}"

c_grn "✓ Собрано: bundle.js (с патчем), application.js, img/ (${ICONS})."

# ===== ПУШ ========================================================

if [ "$DO_PUSH" -eq 1 ]; then
  command -v git >/dev/null 2>&1 || die "не найден git"
  if [ -z "$COMMIT_MSG" ]; then
    COMMIT_MSG="сборка${VER:+ на оригинале $VER}"
  fi
  echo "Пушу…"
  git add -A
  if git diff --cached --quiet; then
    c_dim "Нечего коммитить — всё уже в репозитории."
  else
    git commit -q -m "$COMMIT_MSG"
    git push
    c_grn "✓ Запушено: ${COMMIT_MSG}"
  fi
else
  c_dim "Готово. Коммит не делал (запустите с --push, чтобы отправить)."
fi
