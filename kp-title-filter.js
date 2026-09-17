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
  // ---- таймауты запросов ----
  // В оригинале Ajax ставит XHR timeout = 10 с и НЕ определяет ontimeout:
  // при таймауте не вызывается ни onload, ни onerror, колбэк не приходит —
  // и раздел крутит загрузку вечно. Поднимаем лимит и повторяем запрос.
  var AJAX_TIMEOUT = 30000;     // мс; 0 — не трогать чужой таймаут
  var AJAX_RETRIES = 1;         // сколько раз повторить после таймаута

  // Чем ответить, когда и повтор не дожил: пустой список лучше вечного
  // спиннера — раздел отрисуется пустым, а не подвиснет.
  var EMPTY_LIST = '{"items":[],"pagination":{"total":0,"current":1,"perpage":0,"total_pages":0}}';

  // ---- диагностика ----
  // Показывает поверх интерфейса экран «Диагностика»: какой API-хост подставлен,
  // какие запросы ушли и чем кончились, и какие хосты вообще отвечают
  // с этого устройства. Закрывается кнопкой Menu на пульте.
  // Включается без пересборки: поле "debug": true в blocklist.json
  // (значение кэшируется, так что со второго запуска работает и оффлайн).
  var DEBUG_FORCE = false;      // true — показывать всегда, мимо blocklist.json
  var DEBUG_DELAY = 22000;      // через сколько мс после старта показать
  var NET_MAX = 40;             // сколько последних запросов помнить

  // Хосты для проверки связи с устройства. mode нужен только чтобы собрать
  // правильный путь: "u" → <host>/api/v1/, "a" → <host>/v1/.
  var PROBE_HOSTS = [
    { host: "https://ro03.flexcdn.cloud", mode: "u" },
    { host: "https://api.teleos.club",    mode: "a" },
    { host: "https://proxykp.xyz",        mode: "u" }
  ];

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
  var DEBUG_KEY = "kpTitleFilterDebug";

  // Хост API из blocklist.json (поля apiHost / apiHostMode). Переопределяет
  // DEFAULT_HOST и кэшируется, чтобы применяться уже при следующем запуске:
  // populate() срабатывает через секунду после старта, ждать загрузки списка
  // по сети некогда.
  var HOST_OVERRIDE = null;   // { host: "https://...", mode: "u"|"a" }

  var DEBUG = DEBUG_FORCE;    // может включиться полем "debug" из списка
  var NET = [];               // кольцевой буфер запросов для диагностики
  var PROBE = [];             // результаты проверки хостов
  var scrubErrors = 0;        // сбои фильтрации (не должны случаться)
  var netTimeouts = 0;        // сколько запросов упёрлись в таймаут
  var netRetries = 0;         // сколько раз пришлось повторить
  var bootHost = "";          // что в итоге подставили в hashConfig
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
    if (obj && typeof obj === "object") {
      if (obj.apiHost) setHostOverride(obj.apiHost, obj.apiHostMode);
      if (typeof obj.debug === "boolean") setDebug(obj.debug);
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
      if (localStorage.getItem(DEBUG_KEY) === "1") DEBUG = true;
    } catch (e) {}
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (raw) applyList(JSON.parse(raw));
    } catch (e) { /* пусто или битый кэш — не страшно */ }
  }

  function setDebug(on) {
    DEBUG = on || DEBUG_FORCE;
    try { localStorage.setItem(DEBUG_KEY, on ? "1" : "0"); } catch (e) {}
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

    // Запуск с обработкой таймаута: повтор, а на последней попытке —
    // синтетический пустой ответ, чтобы колбэк всё-таки был вызван.
    function fire(args, attempt) {
      var xhr = orig.apply(obj, args);
      try {
        if (!xhr || typeof xhr !== "object") return xhr;
        if (AJAX_TIMEOUT) {
          // у синхронных запросов timeout менять нельзя — отсюда try
          try { xhr.timeout = AJAX_TIMEOUT; } catch (e) {}
        }
        xhr.ontimeout = function () {
          netTimeouts++;
          if (attempt < AJAX_RETRIES) {
            netRetries++;
            try { fire(args, attempt + 1); } catch (e) {}
            return;
          }
          var cb = args[3];
          if (typeof cb === "function") {
            try {
              cb({ status: 0, readyState: 4, responseText: EMPTY_LIST });
            } catch (e) {}
          }
        };
      } catch (e) {}
      return xhr;
    }

    obj[name] = function () {
      var args = Array.prototype.slice.call(arguments);
      var cb = args[3]; // колбэк — 4-й аргумент во всех методах Ajax

      if (typeof cb === "function") {
        args[3] = function (xhr) {
          // responseText у XHR только для чтения, поэтому подменяем
          // объект целиком заглушкой с теми же полями.
          // Любая ошибка внутри scrub не должна съесть колбэк: иначе
          // исключение улетит в onload и раздел будет грузиться вечно.
          var raw = "";
          try { raw = xhr.responseText; } catch (e) {}
          var text = raw;
          try { text = scrub(raw); }
          catch (e) { scrubErrors++; text = raw; }
          return cb({
            status: xhr.status,
            readyState: xhr.readyState,
            responseText: text
          });
        };
      }
      return fire(args, 0);
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
    // Показать диагностику вручную: Ajax.showTitleFilterDebug()
    Ajax.showTitleFilterDebug = function () { probeHosts(); setTimeout(showReport, 7000); };

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
    bootHost = mode + "=" + host;
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

  /* ===== ДИАГНОСТИКА =============================================== */

  // Наблюдение за сетью на уровне XMLHttpRequest: ловим и то, что идёт мимо
  // Ajax. Только фиксируем факты, ничего не меняем — обёртки насквозь.
  function watchNetwork() {
    try {
      var P = XMLHttpRequest.prototype;
      if (P.__titleFilterWatch) return;
      var open = P.open, send = P.send;

      P.open = function (method, url) {
        try { this.__fm = { m: String(method || "?"), u: String(url || ""), t0: 0, st: "—", code: 0 }; }
        catch (e) {}
        var r = open.apply(this, arguments);
        // Оригинал ставит timeout до open() — значит здесь его уже видно и
        // ещё можно поднять. Нулевой не трогаем: там таймаута и не хотели.
        // У синхронных запросов присвоение бросает исключение — отсюда try.
        try {
          if (AJAX_TIMEOUT && this.timeout && this.timeout < AJAX_TIMEOUT) {
            this.timeout = AJAX_TIMEOUT;
          }
        } catch (e) {}
        return r;
      };

      P.send = function () {
        var self = this, rec = null;
        try {
          rec = self.__fm;
          if (rec && !self.__fmSkip) {
            rec.t0 = Date.now();
            rec.st = "идёт";
            NET.push(rec);
            while (NET.length > NET_MAX) NET.shift();
            var done = function (state) {
              return function () {
                if (rec.st !== "идёт") return;
                rec.ms = Date.now() - rec.t0;
                try { rec.code = self.status; } catch (e) {}
                rec.st = state === "ok"
                  ? (rec.code >= 200 && rec.code < 300 ? "ok" : "HTTP " + rec.code)
                  : state;
              };
            };
            self.addEventListener("load",    done("ok"));
            self.addEventListener("error",   done("ошибка сети"));
            self.addEventListener("timeout", done("таймаут"));
            self.addEventListener("abort",   done("прервано"));
          }
        } catch (e) {}
        return send.apply(this, arguments);
      };

      P.__titleFilterWatch = true;
    } catch (e) {}
  }

  // Достучаться до хоста с самого устройства — ровно так, как это делает
  // приложение: с его токеном и его заголовками. Синтетический запрос без
  // токена часть прокси просто рвёт, поэтому первая версия проверки врала
  // «ошибка сети» там, где настоящие запросы проходили.
  // Меряем два конца: лёгкий /types и тяжёлый /items (каталог, perpage=47) —
  // именно тяжёлый и упирается в таймаут.
  function apiToken() {
    try {
      var t = localStorage.getItem("accessToken");
      return t ? String(t).replace(/^"+|"+$/g, "") : "";
    } catch (e) { return ""; }
  }

  function probeOne(rec, field, url) {
    var t0 = Date.now();
    rec[field] = "идёт…";
    try {
      var x = new XMLHttpRequest();
      x.open("GET", url, true);
      x.__fmSkip = true;          // не засорять список запросов проверками
      x.timeout = 15000;
      try { x.setRequestHeader("Content-Type", "application/json"); } catch (e) {}
      x.onload = function () {
        var ms = Date.now() - t0;
        rec[field] = (x.status === 200 ? "" : "HTTP " + x.status + " ") + ms + "мс";
      };
      x.onerror   = function () { rec[field] = "ошибка (" + (Date.now() - t0) + "мс)"; };
      x.ontimeout = function () { rec[field] = "таймаут"; };
      x.send();
    } catch (e) { rec[field] = "исключение"; }
  }

  function probeHosts() {
    var tok = apiToken();
    PROBE = [];
    for (var i = 0; i < PROBE_HOSTS.length; i++) {
      var h = PROBE_HOSTS[i];
      var base = h.host + (h.mode === "a" ? "/v1/" : "/api/v1/");
      var rec = { host: h.host.replace(/^https?:\/\//, ""), light: "—", heavy: "—" };
      PROBE.push(rec);
      var tail = "access_token=" + tok + "&rand=" + Date.now();
      probeOne(rec, "light", base + "types?" + tail);
      probeOne(rec, "heavy", base + "items?type=movie&page=1&perpage=47&" + tail);
    }
  }

  function shortUrl(u) {
    var v = String(u).replace(/^https?:\/\//, "");
    v = v.replace(/access_token=[^&]*/, "token=…");
    if (v.length > 52) v = v.slice(0, 26) + "…" + v.slice(-24);
    return v;
  }

  function buildReport() {
    var L = [];
    L.push("API-хост: " + (bootHost || "из ссылки, не подставляли"));
    try { L.push("apiBase:  " + KINOPUB.apiBase); } catch (e) {}
    L.push("Правил: " + RULES.block.length + " · вырезано: " + removedTotal +
           (scrubErrors ? " · сбоев фильтра: " + scrubErrors : ""));
    L.push("Таймаутов: " + netTimeouts + " · повторов: " + netRetries +
           " · токен: " + (apiToken() ? "есть" : "НЕТ"));
    L.push("");

    L.push("Хосты (лёгкий /types · каталог /items):");
    if (!PROBE.length) L.push("  проверка не запускалась");
    for (var i = 0; i < PROBE.length; i++) {
      L.push("  " + PROBE[i].host);
      L.push("     " + PROBE[i].light + " · " + PROBE[i].heavy);
    }
    L.push("");

    L.push("Последние запросы:");
    var n = 0;
    for (var j = NET.length - 1; j >= 0 && n < 14; j--) {
      var r = NET[j];
      var st = r.st;
      // «идёт» дольше 8 секунд — это и есть бесконечная загрузка
      if (st === "идёт" && Date.now() - r.t0 > 8000) st = "висит";
      L.push("  " + st + (r.ms ? " " + r.ms + "мс" : "") + " · " + shortUrl(r.u));
      n++;
    }
    if (!n) L.push("  ни одного запроса не зафиксировано");
    return L.join("\n");
  }

  function esc(t) {
    return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function showReport() {
    try {
      if (typeof navigationDocument === "undefined") return;
      var tvml =
        '<?xml version="1.0" encoding="UTF-8" ?>' +
        '<document><descriptiveAlertTemplate>' +
        '<title>Диагностика фильтра</title>' +
        '<description>' + esc(buildReport()) + '</description>' +
        '</descriptiveAlertTemplate></document>';
      var doc = new DOMParser().parseFromString(tvml, "application/xml");
      navigationDocument.presentModal(doc);
    } catch (e) {}
  }

  function startDiagnostics() {
    watchNetwork();
    setTimeout(function () { if (DEBUG) { try { probeHosts(); } catch (e) {} } },
               Math.max(1000, DEBUG_DELAY - 16000));
    setTimeout(function () { if (DEBUG) showReport(); }, DEBUG_DELAY);
    // Второй снимок: к этому моменту видно, какие запросы так и не ответили
    setTimeout(function () {
      if (!DEBUG) return;
      for (var i = 0; i < NET.length; i++) {
        if (NET[i].st !== "ok") { showReport(); return; }
      }
    }, DEBUG_DELAY + 30000);
  }

  /* ===== СТАРТ ===================================================== */

  readCache();   // мгновенно — правила с прошлого запуска
  startDiagnostics();

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
