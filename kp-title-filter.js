/* ------------------------------------------------------------------
   kp-title-filter.js  v2

   Фильтрация выдачи по словам, фразам и целым названиям
   для клиента KinoPub (bundle.js для Micro IPTV / Apple TV).

   Установка:
     cat bundle.js kp-title-filter.js > bundle.new.js
     mv bundle.new.js bundle.js

   Список правил лежит в отдельном blocklist.json рядом с bundle.js
   и подтягивается на лету — правится через git push, приложение
   переустанавливать не нужно.
   ------------------------------------------------------------------ */

(function () {
  "use strict";

  /* ===== НАСТРОЙКИ ================================================= */

  // Адрес blocklist.json. Пустая строка = взять из того же каталога,
  // откуда загрузился сам bundle.js (globalThis.baseURL).
  // Задан абсолютом намеренно: boot URL вводится через короткий редирект, и
  // если оболочка возьмёт BASEURL от домена сокращателя, а не от конечного
  // адреса, относительный путь уедет в никуда.
  var LIST_URL = "https://tmgrom.github.io/atv-assets/blocklist.json";

  // Запасной адрес, если baseURL по каким-то причинам недоступен.
  var LIST_URL_FALLBACK =
    "https://raw.githubusercontent.com/tmgrom/atv-assets/main/blocklist.json";

  // Как часто перечитывать список, минут. 0 = только при старте.
  var REFRESH_MIN = 15;

  // true — скрывать и карточку фильма при заходе напрямую
  // (история, TopShelf, продолжение просмотра)
  var BLOCK_DETAIL = true;

  // Правила «на всякий случай»: работают, даже если blocklist.json
  // недоступен и в кэше пусто. Синтаксис тот же, что в файле.
  var BUILTIN = [];

  var LOG = false;

  // ---- API-хост по умолчанию ----
  // Micro IPTV не принимает boot URL с «#», а без хвоста приложение остаётся
  // на хосте, зашитом в bundle.js. Подставляем значение сами — тогда ссылку
  // можно вводить чистой: .../bundle.js
  //
  // В оригинале хост приезжает хвостом «#u=<hex>» (так делают свежие
  // редиректы) или «#a=<hex>» (старый способ). hex — это имя хоста,
  // поксоренное ключом KINOPUB.clientSecret; кодируем сами из обычной
  // строки, чтобы хост можно было менять руками.
  //   "u" — хост-прокси целиком заменяет https://proxykp.xyz:
  //         apiBase → <host>/api/v1/, cdn → <host>/cdn/
  //   "a" — хост API: apiBase → <host>/v1/, cdn → <host, api.→m.>/
  // Пустая строка = ничего не подставлять.
  //
  // Хосты автора (проверять, если каталог перестал грузиться):
  //   https://ro03.flexcdn.cloud  — "u", urlr.me/!atv4kp (актуальный)
  //   https://api.teleos.club     — "a", git.new/atv4kptos, atv4.dnskp.cc
  var DEFAULT_HOST = "https://ro03.flexcdn.cloud";
  var DEFAULT_HOST_MODE = "u";

  // true — подставлять, даже если в ссылке уже есть свой a= или u=
  var FORCE_DEFAULT_HOST = false;

  // Брошенные хосты. Если хвост ссылки (в том числе сохранённый boot URL
  // «открывать автоматически при запуске», куда AppSettings.setDefaultUrl
  // зашил старое значение) ведёт на такой хост — подменяем его на актуальный,
  // не дожидаясь, пока пользователь перевведёт ссылку.
  var STALE_HOSTS = [
    "https://api.teleos.club",
    "https://proxykp.xyz"
  ];

  // ---- индикатор в интерфейсе ----
  // Дописывает к шестерёнке настроек в верхнем меню счётчик вида "⚙ 12·37":
  //   12 — сколько правил блокировки сейчас загружено
  //   37 — сколько записей вырезано с момента запуска приложения
  var BADGE = true;
  var BADGE_ICON = "\u2699";        // символ шестерёнки, как в оригинале
  var BADGE_SHOW_REMOVED = true;    // false — показывать только число правил
  var BADGE_SEP = "\u00B7";         // разделитель между числами

  /* ===== НОРМАЛИЗАЦИЯ И СОПОСТАВЛЕНИЕ ============================== */

  // Класс «буква»: цифры, латиница, кириллица (вкл. укр./бел.), _
  var L = "0-9A-Za-z\\u0400-\\u04FF\\u0500-\\u052F_";

  function norm(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/\u0451/g, "\u0435")   // ё -> е (реально пишут и так, и так)
      .replace(/[\u2010-\u2015\u2212]/g, "-")
      .replace(/[\u00AB\u00BB\u201C\u201D\u201E\u2018\u2019]/g, "")
      .replace(/\s+/g, " ")
      .replace(/^\s+|\s+$/g, "");
  }

  function esc(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Границы слова через группы, а не через \b и не через lookbehind:
  // \b в JS работает только по ASCII, а (?<=) появился лишь в свежих
  // версиях JavaScriptCore и на старых Apple TV упадёт.
  function phraseRe(p) {
    var body = esc(p).replace(/\s+/g, "\\s+");
    return new RegExp("(^|[^" + L + "])" + body + "([^" + L + "]|$)");
  }

  // Компиляция одного правила в функцию-предикат
  function compile(raw) {
    var s = String(raw == null ? "" : raw);
    var trimmed = s.replace(/^\s+|\s+$/g, "");
    if (!trimmed || trimmed.charAt(0) === "#") return null; // пустое / коммент

    // re:  — сырое регулярное выражение
    if (/^re:/i.test(trimmed)) {
      try {
        var re = new RegExp(trimmed.slice(3).replace(/^\s+/, ""), "i");
        return function (t, parts) { return re.test(t); };
      } catch (e) {
        if (LOG) console.log("[filter] битая регулярка: " + trimmed);
        return null;
      }
    }

    // =  — точное совпадение с названием целиком
    if (trimmed.charAt(0) === "=") {
      var want = norm(trimmed.slice(1));
      if (!want) return null;
      return function (t, parts) {
        if (t === want) return true;
        for (var i = 0; i < parts.length; i++) {
          if (parts[i] === want) return true;
        }
        return false;
      };
    }

    // иначе — слово или фраза по границам слов
    var n = norm(trimmed);
    if (!n) return null;
    var pre = phraseRe(n);
    return function (t, parts) { return pre.test(t); };
  }

  function compileAll(arr) {
    var out = [];
    if (Object.prototype.toString.call(arr) !== "[object Array]") return out;
    for (var i = 0; i < arr.length; i++) {
      var f = compile(arr[i]);
      if (f) out.push(f);
    }
    return out;
  }

  /* ===== СОСТОЯНИЕ ================================================= */

  var RULES = { block: compileAll(BUILTIN), allow: [] };
  var CACHE_KEY = "kpTitleFilterList";
  var HOST_KEY = "kpTitleFilterHost";

  // Хост API из blocklist.json (поля apiHost / apiHostMode). Переопределяет
  // DEFAULT_HOST и кэшируется, чтобы применяться уже при следующем запуске:
  // populate() срабатывает через секунду после старта, ждать загрузки списка
  // по сети некогда.
  var HOST_OVERRIDE = null;   // { host: "https://...", mode: "u"|"a" }
  var removedTotal = 0;

  /* ===== ИНДИКАТОР В МЕНЮ ========================================== */

  var lastBadge = null;

  function badgeText() {
    var s = BADGE_ICON + " " + RULES.block.length;
    if (BADGE_SHOW_REMOVED) s += BADGE_SEP + removedTotal;
    return s;
  }

  // Обновляет уже отрисованную шестерёнку во всех открытых документах.
  // Меню строится один раз при старте, поэтому дорисовывать приходится
  // по живому DOM, а не только через шаблон.
  function refreshBadge() {
    if (!BADGE) return;
    var text = badgeText();
    if (text === lastBadge) return;

    try {
      var docs = navigationDocument.documents;
      var touched = false;
      for (var i = 0; i < docs.length; i++) {
        var el = docs[i].getElementById("Settings");
        if (!el) continue;
        var t = el.getElementsByTagName("title").item(0);
        if (t) { t.textContent = text; touched = true; }
      }
      if (touched) lastBadge = text;
    } catch (e) { /* меню ещё не отрисовано — не страшно */ }
  }

  // Подмена в самом шаблоне, чтобы при первой отрисовке
  // счётчик уже стоял на месте и не мигал.
  function patchTemplates() {
    if (typeof Templates === "undefined" || !Templates) return false;
    if (Templates.__titleFilterBadge) return true;

    var names = ["menuBar", "menuBarChild"];
    for (var i = 0; i < names.length; i++) {
      (function (name) {
        var orig = Templates[name];
        if (typeof orig !== "function") return;
        Templates[name] = function () {
          var doc = orig.apply(Templates, arguments);
          if (!BADGE || typeof doc !== "string") return doc;
          lastBadge = badgeText();
          return doc.replace(
            /(<menuItem\s+id\s*=\s*"Settings"\s*>\s*<title>)[^<]*(<\/title>)/,
            "$1" + badgeText() + "$2"
          );
        };
      })(names[i]);
    }

    Templates.__titleFilterBadge = true;
    return true;
  }

  function applyList(obj) {
    // Принимаем и голый массив, и объект { block: [...], allow: [...] }
    var block, allow;
    if (Object.prototype.toString.call(obj) === "[object Array]") {
      block = obj; allow = [];
    } else if (obj && typeof obj === "object") {
      block = obj.block || obj.blocklist || [];
      allow = obj.allow || obj.allowlist || [];
    } else {
      return false;
    }
    if (obj && typeof obj === "object" && obj.apiHost) {
      setHostOverride(obj.apiHost, obj.apiHostMode);
    }
    RULES = { block: compileAll(block), allow: compileAll(allow) };
    if (LOG) {
      console.log("[filter] правил: блок " + RULES.block.length +
                  ", исключений " + RULES.allow.length);
    }
    refreshBadge();
    return true;
  }

  function matches(list, title, parts) {
    for (var i = 0; i < list.length; i++) {
      if (list[i](title, parts)) return true;
    }
    return false;
  }

  // В API название приходит одной строкой "Русское / Original",
  // проверяем и целиком, и каждую часть по отдельности.
  function isBlocked(item) {
    if (!item) return false;
    var t = norm(item.title);
    var sub = norm(item.subtitle);
    var full = sub ? (t + " / " + sub) : t;

    var parts = [];
    var chunks = full.split(" / ");
    for (var i = 0; i < chunks.length; i++) {
      var c = chunks[i].replace(/^\s+|\s+$/g, "");
      if (c) parts.push(c);
    }

    if (matches(RULES.allow, full, parts)) return false;
    return matches(RULES.block, full, parts);
  }

  /* ===== ЗАГРУЗКА СПИСКА =========================================== */

  function readCache() {
    try {
      var h = localStorage.getItem(HOST_KEY);
      if (h) HOST_OVERRIDE = JSON.parse(h);
    } catch (e) {}
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (raw) applyList(JSON.parse(raw));
    } catch (e) { /* пусто или битый кэш — не страшно */ }
  }

  // Хост из списка: запоминаем в localStorage, применится со следующего
  // запуска (текущая сессия уже подняла API на прежнем хосте).
  function setHostOverride(host, mode) {
    host = String(host).replace(/\/+$/, "");
    mode = (mode === "a" || mode === "u") ? mode : DEFAULT_HOST_MODE;
    if (HOST_OVERRIDE && HOST_OVERRIDE.host === host &&
        HOST_OVERRIDE.mode === mode) return;
    HOST_OVERRIDE = { host: host, mode: mode };
    try { localStorage.setItem(HOST_KEY, JSON.stringify(HOST_OVERRIDE)); } catch (e) {}
    if (LOG) console.log("[filter] новый API-хост из списка: " + mode + " " + host);
  }

  function writeCache(text) {
    try { localStorage.setItem(CACHE_KEY, text); } catch (e) {}
  }

  function listUrl() {
    var base = LIST_URL;
    if (!base) {
      try {
        if (typeof baseURL === "string" && baseURL) {
          base = baseURL.replace(/[^\/]*$/, "") + "blocklist.json";
        }
      } catch (e) {}
    }
    if (!base) base = LIST_URL_FALLBACK;
    // Обход кэша CDN у GitHub
    return base + (base.indexOf("?") === -1 ? "?" : "&") + "t=" + Date.now();
  }

  function fetchList() {
    var url = listUrl();
    try {
      var x = new XMLHttpRequest();
      x.open("GET", url, true);
      x.timeout = 8000;
      x.onload = function () {
        if (x.status < 200 || x.status >= 300) return;
        var parsed;
        try { parsed = JSON.parse(x.responseText); }
        catch (e) { if (LOG) console.log("[filter] blocklist.json не парсится"); return; }
        if (applyList(parsed)) writeCache(x.responseText);
      };
      x.onerror = function () { if (LOG) console.log("[filter] список недоступен"); };
      x.send();
    } catch (e) {}
  }

  /* ===== ФИЛЬТРАЦИЯ ОТВЕТОВ ======================================== */

  function scrub(text) {
    if (!RULES.block.length) return text;

    var data;
    try { data = JSON.parse(text); } catch (e) { return text; }
    if (!data || typeof data !== "object") return text;

    // Списки: /items, /items/search, /watching, коллекции, похожие
    if (Object.prototype.toString.call(data.items) === "[object Array]") {
      var before = data.items.length;
      var kept = [];
      for (var i = 0; i < data.items.length; i++) {
        if (!isBlocked(data.items[i])) kept.push(data.items[i]);
      }
      data.items = kept;

      var removed = before - kept.length;
      if (removed > 0) {
        if (data.pagination && typeof data.pagination.total === "number") {
          data.pagination.total = Math.max(0, data.pagination.total - removed);
        }
        removedTotal += removed;
        refreshBadge();
        if (LOG) console.log("[filter] вырезано: " + removed);
      }
      return JSON.stringify(data);
    }

    // Карточка одного фильма: /items/{id}
    if (BLOCK_DETAIL && data.item && isBlocked(data.item)) {
      if (LOG) console.log("[filter] карточка заблокирована");
      return JSON.stringify({ status: 404, message: "Not found" });
    }

    return text;
  }

  /* ===== ПЕРЕХВАТ Ajax ============================================= */

  function wrap(obj, name) {
    var orig = obj[name];
    if (typeof orig !== "function") return;

    obj[name] = function () {
      var args = Array.prototype.slice.call(arguments);
      var cb = args[3]; // колбэк — 4-й аргумент во всех методах Ajax

      if (typeof cb === "function") {
        args[3] = function (xhr) {
          // responseText у XHR только для чтения, поэтому подменяем
          // объект целиком заглушкой с теми же полями
          return cb({
            status: xhr.status,
            readyState: xhr.readyState,
            responseText: scrub(xhr.responseText)
          });
        };
      }
      return orig.apply(obj, args);
    };
  }

  function install() {
    if (typeof Ajax === "undefined" || !Ajax) return false;
    if (Ajax.__titleFilter) return true;

    // aget/apost внутри вызывают get/post — их не трогаем,
    // иначе фильтр отработает дважды.
    wrap(Ajax, "get");
    wrap(Ajax, "post");
    wrap(Ajax, "apostInUrl");

    Ajax.__titleFilter = true;

    // Ручное обновление из консоли отладчика: Ajax.reloadTitleFilter()
    Ajax.reloadTitleFilter = function () { fetchList(); refreshBadge(); };

    if (LOG) console.log("[filter] перехват установлен");
    return true;
  }

  /* ===== BOOT: API-ХОСТ И ПЕРВАЯ ЗАГРУЗКА СПИСКА =================== */

  // hashConfig и baseURL — настоящие глобальные переменные bundle.js
  // (globalThis.hashConfig / globalThis.baseURL), заполняет их App.onLaunch.
  // Оборачиваем onLaunch и дописываем недостающее ПОСЛЕ разбора ссылки, но
  // ДО AppSettings.populate(hashConfig): populate вызывается из onLaunch
  // через setTimeout на секунду, так что успеваем.
  // Тот же объект hashConfig потом читает AppSettings.setDefaultUrl(), так
  // что и сохранённый boot URL получится с правильным хвостом.
  // Обратная операция к Utils.getByKey: строка -> XOR-hex тем же ключом.
  // XOR симметричен, поэтому кодирование и декодирование — один и тот же код.
  function xorHex(str, key) {
    var out = "";
    for (var i = 0; i < str.length; i++) {
      var b = str.charCodeAt(i) ^ (key.charCodeAt(i % key.length) % 255);
      out += (b < 16 ? "0" : "") + b.toString(16);
    }
    return out;
  }

  function secret() {
    try {
      if (globalThis.KINOPUB && KINOPUB.clientSecret) return KINOPUB.clientSecret;
    } catch (e) {}
    return "3z5124kj5liqy9gahnjr07qpj65ferl2";   // дефолт из bundle.js
  }

  function unHex(hex, key) {
    var m = String(hex).match(/.{1,2}/g) || [];
    var out = "";
    for (var i = 0; i < m.length; i++) {
      out += String.fromCharCode(parseInt(m[i], 16) ^ key.charCodeAt(i % key.length) % 255);
    }
    return out;
  }

  function isStale(hex, key) {
    var host;
    try { host = unHex(hex, key).replace(/\/+$/, ""); } catch (e) { return false; }
    for (var i = 0; i < STALE_HOSTS.length; i++) {
      if (STALE_HOSTS[i] === host) return true;
    }
    return false;
  }

  function applyDefaultApiHost() {
    var host = DEFAULT_HOST, mode = DEFAULT_HOST_MODE;
    if (HOST_OVERRIDE && HOST_OVERRIDE.host) {
      host = HOST_OVERRIDE.host;
      mode = HOST_OVERRIDE.mode || DEFAULT_HOST_MODE;
    }
    if (!host) return;
    var cfg = globalThis.hashConfig;
    if (!cfg || typeof cfg !== "object") return;
    var own = cfg.a || cfg.u;
    if (own && !FORCE_DEFAULT_HOST && !isStale(own, secret())) return;
    if (own && LOG) console.log("[filter] хост из ссылки заброшен, подменяю");
    var hex = xorHex(host, secret());
    if (mode === "a") { cfg.a = hex; delete cfg.u; }
    else { cfg.u = hex; delete cfg.a; }
    if (LOG) console.log("[filter] API-хост по умолчанию: " + mode + "=" + host);
  }

  function patchBoot() {
    if (typeof App === "undefined" || !App) return false;
    if (App.__titleFilterBoot) return true;
    var orig = App.onLaunch;
    if (typeof orig !== "function") return false;

    App.onLaunch = function () {
      try {
        return orig.apply(App, arguments);
      } finally {
        try { applyDefaultApiHost(); } catch (e) {}
        // baseURL известен только начиная с onLaunch, поэтому первый запрос
        // списка делаем отсюда, а не при загрузке файла
        try { fetchList(); } catch (e) {}
      }
    };

    App.__titleFilterBoot = true;
    return true;
  }

  /* ===== СТАРТ ===================================================== */

  readCache();   // мгновенно — правила с прошлого запуска

  // API-хост по умолчанию + первая загрузка списка. Если обернуть onLaunch
  // не вышло (её уже вызвали или её нет) — тянем список сразу.
  if (!patchBoot()) fetchList();

  if (REFRESH_MIN > 0) {
    setInterval(fetchList, REFRESH_MIN * 60 * 1000);
  }

  // Ajax и Templates появляются в globalThis только внутри onLaunch,
  // поэтому ждём их до 30 секунд, а не 5.
  if (!install() || !patchTemplates()) {
    var tries = 0;
    var timer = setInterval(function () {
      var done = install() && patchTemplates();
      if (done || ++tries > 300) clearInterval(timer);
    }, 100);
  }

  // Меню могло отрисоваться раньше, чем доехал список — подстрахуемся
  setTimeout(refreshBadge, 3000);
  setTimeout(refreshBadge, 10000);
})();
