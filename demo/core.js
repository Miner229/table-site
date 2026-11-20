/* ArtVin Cup — shared logic for the display page (index.html) and the judge page (judge.html).
 *
 * Data model (one Google Sheet):
 *   «Настройки» tab — one row per stream:
 *       Поток | Лист | Пол | Ротация | Режим | Время ротаций | На экране
 *   one tab per stream — header row with «ФИО» (first row of the tab), e.g.
 *       № | ФИО | Год | Клуб | Разряд | Старт | Вольные | Конь | Кольца | Прыжок | Брусья | Перекладина | Сумма
 *     «Старт» = the apparatus the gymnast's group starts on. Instead of the column you can also
 *     put a separator row with just the apparatus name (e.g. «Кольца») — everyone below it starts there.
 */
(function (global) {
"use strict";

const CONFIG = {
  MAX_SCORE: 10,
  SHEET_ID: "1NCLssbli5uUVMNLn88zw8n2RdzHTaZrumR9AP0Zvd9w",
  SETTINGS_TAB: "Настройки",
  // Apps Script web-app URL (judges write scores through it). Can also come from ?api=... in the judge link.
  SCRIPT_URL: "",
};

const APPARATUS = {
  floor:  { short: "Вольные",     full: "Вольные упражнения" },
  pommel: { short: "Конь",        full: "Конь-махи" },
  rings:  { short: "Кольца",      full: "Кольца" },
  vault:  { short: "Прыжок",      full: "Опорный прыжок" },
  pbars:  { short: "Брусья",      full: "Параллельные брусья" },
  hbar:   { short: "Перекладина", full: "Перекладина" },
  ubars:  { short: "Брусья",      full: "Брусья разной высоты" },
  beam:   { short: "Бревно",      full: "Бревно" },
};

// Official Olympic rotation order
const ORDER = {
  M: ["floor", "pommel", "rings", "vault", "pbars", "hbar"],
  F: ["vault", "ubars", "beam", "floor"],
};

const ROT_MODES = { manual: "Ручная", auto: "Авто (по оценкам)", time: "По времени" };

/* ---------- small helpers ---------- */
function norm(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function parseGender(s) {
  const t = norm(s);
  if (/^(ж|д|f|w)/.test(t)) return "F";
  return "M";
}
function apparatusFromText(text, gender) {
  const t = norm(text);
  if (!t || t.length > 40) return null;
  if (/вольн/.test(t)) return "floor";
  if (/конь|махи/.test(t)) return "pommel";
  if (/кольц/.test(t)) return "rings";
  if (/прыж/.test(t)) return "vault";
  if (/брус/.test(t)) return gender === "F" ? "ubars" : "pbars";
  if (/перекл/.test(t)) return "hbar";
  if (/бревн/.test(t)) return "beam";
  return null;
}
function parseScore(raw) {
  const s = String(raw == null ? "" : raw).trim().replace(",", ".");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function fmtScore(n) {
  return n == null ? "" : n.toFixed(3).replace(".", ",");
}
function parseTimes(s) {
  return (String(s || "").match(/\d{1,2}[:.]\d{2}/g) || []).map(t => {
    const [h, m] = t.split(/[:.]/).map(Number);
    return h * 60 + m;
  }).sort((a, b) => a - b);
}

/* ---------- CSV ---------- */
function parseCSV(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (c !== "\r") cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/* ---------- settings ---------- */
function parseSettings(values) {
  const hi = values.findIndex(r => r.some(c => /лист/.test(norm(c))));
  if (hi < 0) throw new Error("Во вкладке «Настройки» нет колонки «Лист»");
  const h = values[hi].map(norm);
  const col = re => h.findIndex(c => re.test(c));
  const c = {
    title: col(/поток|назв/), tab: col(/лист/), gender: col(/^пол/), rot: col(/^ротац|^тек/),
    mode: col(/режим/), times: col(/время/), active: col(/экран|актив/),
  };
  const get = (r, k) => (c[k] >= 0 ? String(r[c[k]] == null ? "" : r[c[k]]).trim() : "");
  const out = [];
  values.slice(hi + 1).forEach(r => {
    const tab = get(r, "tab");
    if (!tab) return;
    const m = norm(get(r, "mode"));
    out.push({
      title: get(r, "title") || tab,
      tab,
      gender: parseGender(get(r, "gender")),
      rotation: parseInt(get(r, "rot"), 10) || 1,
      mode: /авто|auto/.test(m) ? "auto" : /врем|time/.test(m) ? "time" : "manual",
      times: parseTimes(get(r, "times")),
      active: /^(да|yes|1|\+|x|х|✓)/.test(norm(get(r, "active"))),
    });
  });
  return out;
}

/* ---------- stream tab ---------- */
function parseStream(values, gender, rowBase) {
  // rowBase: sheet row number of values[0] (1 for Apps Script data), or null if unknown (gviz)
  const hi = values.findIndex(r => r.some(c => norm(c) === "фио" || /^фио\b/.test(norm(c))));
  if (hi < 0) throw new Error("Не найдена строка заголовков с колонкой «ФИО»");
  const h = values[hi];
  const hn = h.map(norm);
  const nameCol = hn.findIndex(c => /^фио/.test(c));
  const yearCol = hn.findIndex(c => /год/.test(c));
  const clubCol = hn.findIndex(c => /клуб|регион|команд|город/.test(c));
  const startCol = hn.findIndex(c => /старт/.test(c));
  const appCols = {};
  h.forEach((c, i) => {
    if (i === nameCol || i === startCol) return;
    const a = apparatusFromText(c, gender);
    if (a && ORDER[gender].includes(a) && appCols[a] == null) appCols[a] = i;
  });

  const gymnasts = [];
  let section = null;
  values.slice(hi + 1).forEach((r, k) => {
    const cells = r.map(c => String(c == null ? "" : c).trim());
    const filled = cells.filter(Boolean);
    if (!filled.length) return;
    const name = cells[nameCol] || "";
    const hasData = (yearCol >= 0 && cells[yearCol]) || (clubCol >= 0 && cells[clubCol]);
    if (!hasData && filled.length <= 2) {
      // separator row: apparatus name → start group; anything else (e.g. «2018») → ignored
      const a = filled.map(f => apparatusFromText(f, gender)).find(Boolean);
      if (a) section = a;
      return;
    }
    if (!name) return;
    let start = startCol >= 0 ? apparatusFromText(cells[startCol], gender) : null;
    if (!start) start = section;
    if (start && !ORDER[gender].includes(start)) start = null;
    const scores = {};
    Object.keys(appCols).forEach(a => {
      const raw = cells[appCols[a]] || "";
      scores[a] = { raw, num: parseScore(raw) };
    });
    gymnasts.push({
      idx: gymnasts.length,
      row: rowBase == null ? null : rowBase + hi + 1 + k,
      name,
      year: yearCol >= 0 ? cells[yearCol] : "",
      club: clubCol >= 0 ? cells[clubCol] : "",
      start,
      scores,
    });
  });
  return { gender, gymnasts, appCols, nameCol, headerIndex: hi, apps: ORDER[gender].filter(a => appCols[a] != null) };
}

/* ---------- rotation ---------- */
function appAtRotation(start, r, gender) {
  const o = ORDER[gender];
  const i = o.indexOf(start);
  if (i < 0) return null;
  return o[(i + r - 1) % o.length];
}
function hasScore(g, app) {
  return !!(g.scores[app] && g.scores[app].raw !== "");
}
function autoRotation(stream) {
  const n = ORDER[stream.gender].length;
  const placed = stream.gymnasts.filter(g => g.start);
  if (!placed.length) return 1;
  let r = 1;
  for (let k = 1; k <= n; k++) {
    const done = placed.every(g => {
      const a = appAtRotation(g.start, k, stream.gender);
      return !stream.apps.includes(a) || hasScore(g, a);   // apparatus without a column can't block
    });
    if (done) r = k + 1; else break;
  }
  return Math.min(r, n);
}
function timeRotation(times, n, now) {
  const d = now || new Date();
  const m = d.getHours() * 60 + d.getMinutes();
  const passed = times.filter(t => t <= m).length;
  return Math.max(1, Math.min(n, passed || 1));
}
// Everyone has a score on every apparatus → the stream is over
function isFinished(stream) {
  const placed = stream.gymnasts.filter(g => g.start);
  return placed.length > 0 && placed.every(g => stream.apps.every(a => hasScore(g, a)));
}
// Per apparatus at rotation r: { done, total } — how many of the group on it already have a score
function rotationProgress(stream, r) {
  const groups = groupsAt(stream, r);
  const res = {};
  stream.apps.forEach(a => {
    res[a] = { done: groups[a].filter(g => hasScore(g, a)).length, total: groups[a].length };
  });
  return res;
}
// Returns { rotation, mode, total, finished }
function currentRotation(stream, st, modeOverride, now) {
  const n = ORDER[stream.gender].length;
  const mode = modeOverride || st.mode;
  const manual = Math.max(1, Math.min(n, st.rotation || 1));
  let r = manual;
  if (mode === "auto") r = Math.max(manual, autoRotation(stream));
  else if (mode === "time") r = st.times.length ? timeRotation(st.times, n, now) : manual;
  return { rotation: r, mode, total: n, finished: isFinished(stream) };
}
// Gymnasts per apparatus at rotation r. If nobody has a start apparatus, everyone is on every apparatus.
function groupsAt(stream, r) {
  const res = {};
  stream.apps.forEach(a => (res[a] = []));
  const noStarts = !stream.gymnasts.some(g => g.start);
  stream.gymnasts.forEach(g => {
    if (noStarts) { stream.apps.forEach(a => res[a].push(g)); return; }
    const a = appAtRotation(g.start, r, stream.gender);
    if (a && res[a]) res[a].push(g);
  });
  return res;
}

/* ---------- ranking ---------- */
// status: "scored" | "dns" (0 = не выступал) | "wait"
function rankList(gyms, app) {
  const items = gyms.map(g => {
    const s = g.scores[app] || { raw: "", num: null };
    let status = "wait";
    if (s.num != null && s.num > 0) status = "scored";
    else if (s.raw !== "") status = "dns";
    return { g, score: s.num, status };
  });
  const scored = items.filter(i => i.status === "scored").sort((a, b) => b.score - a.score || a.g.idx - b.g.idx);
  scored.forEach(i => { i.place = 1 + scored.filter(j => j.score > i.score + 1e-9).length; });
  const wait = items.filter(i => i.status === "wait").sort((a, b) => a.g.idx - b.g.idx);
  const dns = items.filter(i => i.status === "dns").sort((a, b) => a.g.idx - b.g.idx);
  return scored.concat(wait, dns);
}

/* ---------- data sources ---------- */
function gvizUrl(tab) {
  return `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/gviz/tq?tqx=out:csv&headers=1&sheet=${
    encodeURIComponent(tab)}&_=${Date.now()}`;
}
async function gvizValues(tab) {
  const res = await fetch(gvizUrl(tab), { cache: "no-store" });
  if (!res.ok) throw new Error("Нет доступа к Google-таблице (" + res.status + ")");
  const text = await res.text();
  if (/^\s*</.test(text)) throw new Error("Google-таблица закрыта: включите доступ «Все, у кого есть ссылка»");
  return parseCSV(text);
}

function scriptUrl() {
  const p = new URLSearchParams(location.search).get("api");
  if (p) { try { localStorage.setItem("artvin-api", p); } catch (e) {} return p; }
  try { return localStorage.getItem("artvin-api") || CONFIG.SCRIPT_URL; } catch (e) { return CONFIG.SCRIPT_URL; }
}
async function scriptGet(params) {
  const url = scriptUrl();
  if (!url) throw new Error("Не указан адрес скрипта (api)");
  const res = await fetch(url + "?" + new URLSearchParams(params), { cache: "no-store" });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "Ошибка сервера");
  return j;
}
async function scriptPost(body) {
  const url = scriptUrl();
  if (!url) throw new Error("Не указан адрес скрипта (api)");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "Ошибка сервера");
  return j;
}

/* ---------- demo store (localStorage, shared between tabs of one browser) ---------- */
const DEMO_KEY = "artvin-demo-v3";
const DEMO_NAMES_M = [
  "Абенов Арман", "Бекетов Данияр", "Волков Матвей", "Галиев Тимур", "Демченко Илья", "Ерланов Санжар",
  "Жумабеков Алихан", "Зайцев Артём", "Исаев Карим", "Калиев Нурсултан", "Литвинов Марк", "Муратов Ерасыл",
  "Нуртаев Айдос", "Орлов Кирилл", "Петров Глеб", "Рахимов Тамерлан", "Сагинтаев Алдияр", "Тимофеев Лев",
  "Усенов Дамир", "Фомин Георгий", "Хамитов Ансар", "Цой Даниил", "Шарипов Адиль", "Шевченко Роман",
  "Ыбыраев Нурали", "Юсупов Мирон", "Яковлев Тимофей", "Ахметов Бекзат", "Байжанов Ислам", "Власов Егор",
  "Габдуллин Расул", "Дюсенов Арсен", "Есенов Амир", "Жаксылыков Нурдаулет", "Захаров Максим", "Ибраев Альтаир",
];
const DEMO_NAMES_F = [
  "Абдрахманова Аружан", "Белова Алиса", "Валиева Амина", "Гордеева Ксения", "Даулетова Айша", "Егорова Варвара",
  "Жанибекова Томирис", "Иванова Полина", "Касымова Дана", "Ли Виктория", "Мухтарова Сабина", "Нестерова Ева",
  "Оспанова Аяла", "Павлова Мирослава", "Рысбаева Медина", "Смирнова София", "Токаева Айлин", "Уразова Камила",
  "Федорова Арина", "Хасенова Аиша", "Чернова Злата", "Шайхова Асель", "Юдина Ульяна", "Ясина Мария",
];
const DEMO_CLUBS = ["ArtVin", "г.Павлодар", "г.Актау", "Evdokimov School", "QZQ School", "г.Караганда", "г.Семей", "Gymteam"];

const DEMO_FIRST_M = ["Арман", "Данияр", "Матвей", "Тимур", "Илья", "Санжар", "Алихан", "Артём", "Карим", "Нурсултан"];
const DEMO_FIRST_F = ["Аружан", "Алиса", "Амина", "Ксения", "Айша", "Варвара", "Томирис", "Полина", "Дана", "Виктория"];
function demoNames(full, firsts, count) {
  // surnames from the list, first names rotated so every combination is unique
  return Array.from({ length: count }, (_, i) =>
    full[i % full.length].split(" ")[0] + " " + firsts[(i + Math.floor(i / full.length) * 5) % firsts.length]);
}
function demoTab(names, gender) {
  const apps = ORDER[gender];
  const header = ["№", "ФИО", "Год", "Клуб", "Старт"].concat(apps.map(a => APPARATUS[a].short), ["Сумма"]);
  const rows = [header];
  const per = Math.ceil(names.length / apps.length);
  names.forEach((n, i) => {
    const start = apps[Math.floor(i / per) % apps.length];
    rows.push([String(i + 1), n, String(2016 + (i % 4)), DEMO_CLUBS[(i * 3) % DEMO_CLUBS.length], APPARATUS[start].short]
      .concat(apps.map(() => ""), [""]));
  });
  return rows;
}
function demoInit(force) {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(DEMO_KEY)); } catch (e) {}
  if (d && !force) return d;
  // for the «по времени» variant: a new rotation every 2 minutes starting now
  const t0 = new Date();
  const times = Array.from({ length: 6 }, (_, i) => {
    const t = new Date(t0.getTime() + i * 120000);
    return String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0");
  }).join(" ");
  d = {
    settings: [
      ["Поток", "Лист", "Пол", "Ротация", "Режим", "Время ротаций", "На экране"],
      ["Демо · Мальчики", "Демо М", "М", "1", "авто", times, "да"],
      ["Демо · Девочки", "Демо Ж", "Ж", "1", "авто", times.split(" ").slice(0, 4).join(" "), ""],
    ],
    tabs: {
      "Демо М": demoTab(demoNames(DEMO_NAMES_M, DEMO_FIRST_M, 60), "M"),
      "Демо Ж": demoTab(demoNames(DEMO_NAMES_F, DEMO_FIRST_F, 40), "F"),
    },
  };
  // pre-fill part of rotation 1 so the board looks alive
  ["Демо М", "Демо Ж"].forEach(tab => {
    const g = tab === "Демо М" ? "M" : "F";
    const st = parseStream(d.tabs[tab], g, 1);
    st.gymnasts.forEach(x => {
      if (Math.random() < 0.55) {
        const a = appAtRotation(x.start, 1, g);
        d.tabs[tab][x.row - 1][st.appCols[a]] = randomScore();
      }
    });
  });
  demoSave(d);
  return d;
}
function demoSave(d) { localStorage.setItem(DEMO_KEY, JSON.stringify(d)); }
function randomScore() { return (7.2 + Math.random() * 2.6).toFixed(3); }

/* Unified loaders. src: "sheet" | "demo" | "script" */
async function loadSettings(src) {
  if (src === "demo") return parseSettings(demoInit().settings);
  if (src === "script") return parseSettings((await scriptGet({ action: "settings" })).values);
  return parseSettings(await gvizValues(CONFIG.SETTINGS_TAB));
}
async function loadStream(src, st) {
  if (src === "demo") return parseStream(demoInit().tabs[st.tab] || [], st.gender, 1);
  if (src === "script") return parseStream((await scriptGet({ action: "tab", tab: st.tab })).values, st.gender, 1);
  return parseStream(await gvizValues(st.tab), st.gender, null);
}

global.ArtVin = {
  CONFIG, APPARATUS, ORDER, ROT_MODES,
  norm, esc, parseScore, fmtScore, parseCSV, parseSettings, parseStream, parseGender, apparatusFromText,
  appAtRotation, autoRotation, currentRotation, groupsAt, rankList, hasScore, isFinished, rotationProgress,
  scriptGet, scriptPost, scriptUrl,
  demoInit, demoSave, randomScore, DEMO_KEY,
  loadSettings, loadStream,
};
})(window);
