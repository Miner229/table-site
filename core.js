/* ArtVin Cup — shared logic for the display page (index.html) and the judge page (judge.html).
 *
 * Data model (one Google Sheet):
 *   «Настройки» tab — one row per stream:
 *       Поток | Лист | Пол | Ротация | Режим | Время ротаций | На экране | Начало
 *     «Начало» (optional) = «27.11.2026 08:00», venue time. See activeStream().
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
  SCRIPT_URL: "https://script.google.com/macros/s/AKfycbwL7ixbqxwNu_GhgpZZOYg-OHBM_zkoxX9NmiCix9qus78HiK_0OhWhfgH-CR4WZgnd8A/exec",
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

/* ---------- venue time ----------
 * All clock times in the sheet («Начало», «Время ротаций») are Aktobe time (Asia/Aqtobe).
 * Aktobe is UTC+5 all year (no daylight saving), so a fixed offset is exact and does not depend
 * on the time zone of the TV, phone or laptop showing the page. */
const VENUE = { tz: "Asia/Aqtobe", offsetMin: 5 * 60 };
const DAY_MS = 86400000;
function toMs(now) { return now == null ? Date.now() : +now; }
function venueParts(now) {
  const d = new Date(toMs(now) + VENUE.offsetMin * 60000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}
function venueMinutes(now) { const p = venueParts(now); return p.h * 60 + p.mi; }
function venueDay(now) { return Math.floor((toMs(now) + VENUE.offsetMin * 60000) / DAY_MS); }
const pad2 = n => String(n).padStart(2, "0");
function fmtVenueTime(ms) { const p = venueParts(ms); return pad2(p.h) + ":" + pad2(p.mi); }
function fmtVenueDate(ms) { const p = venueParts(ms); return pad2(p.d) + "." + pad2(p.mo); }
// «27.11.2026 08:00», «27.11.26 8:00», «27.11 08:00» (year of `now`), «2026-11-27 08:00», optional «:ss».
// Returns a timestamp (ms) or null.
function parseStart(text, now) {
  const t = String(text == null ? "" : text).trim();
  if (!t) return null;
  let y, mo, d, h, mi, m;
  if ((m = t.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?[,\s]+(?:в\s+)?(\d{1,2})[:.](\d{2})(?:[:.]\d{2})?$/i))) {
    d = +m[1]; mo = +m[2]; y = m[3] ? +m[3] : venueParts(now).y; h = +m[4]; mi = +m[5];
    if (y < 100) y += 2000;
  } else if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[\sT]+(\d{1,2}):(\d{2})(?::\d{2})?$/))) {
    y = +m[1]; mo = +m[2]; d = +m[3]; h = +m[4]; mi = +m[5];
  } else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi) - VENUE.offsetMin * 60000;
  const back = venueParts(ms);
  return back.d === d && back.mo === mo ? ms : null;   // rejects 31.02
}

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
// A cell that is an apparatus name (used for start-group separator rows).
// Every word must be an apparatus word, so a surname like «Вольнов Иван» is never read as «Вольные».
// Tolerates case, extra/trailing spaces, «ё», trailing punctuation and the «упражения» typo.
const LABEL_MAIN = /^(вольные|конь|махи|кольца|прыжок|брусья|перекладина|бревно)$/;
const LABEL_WORD = /^(вольные|вольное|конь|махи|кольца|прыжок|опорный|брусья|параллельные|разновысокие|разной|высоты|перекладина|бревно|упр|упражн?е?н?ия|упражнение)$/;
function isApparatusLabel(text) {
  const t = norm(text).replace(/[.:;,!]+$/, "").replace(/\s*-\s*/g, " ");
  if (!t || t.length > 40) return false;
  const words = t.split(" ").map(w => w.replace(/\.$/, ""));
  return words.every(w => LABEL_WORD.test(w)) && words.some(w => LABEL_MAIN.test(w)) && apparatusFromText(t) != null;
}
// «Фамилия Имя»: at least two words, letters only — not a category label like «2018», «3 взрослый», «Юг»
function looksLikePerson(text) {
  const t = String(text || "").trim();
  return !/\d/.test(t) && t.split(/\s+/).filter(w => /\p{L}/u.test(w)).length >= 2;
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
    mode: col(/режим/), times: col(/время/), active: col(/экран|актив/), start: col(/^начал/),
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
      startText: get(r, "start"),
      start: parseStart(get(r, "start")),
    });
  });
  return out;
}

/* ---------- which stream is on now ----------
 * One rule for the board, the judges and the secretary, so they all switch at the same moment.
 *  1. «На экране = да» on any row wins (manual override — exactly the old behaviour).
 *  2. Otherwise «Начало»: the stream with the latest Начало ≤ now. It stays on (with its final
 *     results) until the next one starts.
 *  3. Before the first stream of a day (or of the competition): the upcoming one, status "upcoming".
 *  4. No «Начало» at all: the first stream.
 * gender (optional): judges only see streams of their gender; the «да» override still applies
 * to the whole sheet, so a judge behaves exactly as before while «да» is used.
 * Returns { stream, status: "manual" | "live" | "upcoming" | "default" | "none", next } —
 * next = the stream that starts after now (null if none); next.start = when to switch. */
function activeStream(settings, now, gender) {
  const t = toMs(now);
  const list = gender ? settings.filter(s => s.gender === gender) : settings.slice();
  if (!list.length) return { stream: null, status: "none", next: null };
  if (settings.some(s => s.active)) return { stream: list.find(s => s.active) || list[0], status: "manual", next: null };
  const timed = list.filter(s => s.start != null).sort((a, b) => a.start - b.start);
  if (!timed.length) return { stream: list[0], status: "default", next: null };
  let live = null;
  timed.forEach(s => { if (s.start <= t) live = s; });
  const next = timed.find(s => s.start > t) || null;
  if (!live || (next && venueDay(next.start) === venueDay(t) && venueDay(live.start) < venueDay(t))) {
    return { stream: next, status: "upcoming", next };
  }
  return { stream: live, status: "live", next };
}
// «Начало в 08:00» (today) / «Начало 27.11 в 08:00» for a stream that has not started yet
function startsLabel(st, now) {
  if (!st || st.start == null) return "";
  return "Начало " + (venueDay(st.start) === venueDay(now) ? "" : fmtVenueDate(st.start) + " ") + "в " + fmtVenueTime(st.start);
}
// For the check screen: every stream with its Начало, which one is on now / next, and problems.
function scheduleCheck(settings, now) {
  const pick = activeStream(settings, now);
  const manual = settings.filter(s => s.active);
  const anyStart = settings.some(s => s.start != null || s.startText);
  const notes = [];
  if (manual.length) notes.push(`«На экране = да» у «${manual.map(s => s.title).join("», «")}» — расписание «Начало» не действует`);
  if (manual.length > 1) notes.push("«да» стоит у нескольких потоков — показывается первый");
  if (!anyStart && !manual.length) notes.push("Не заполнено «Начало» — показывается первый поток");
  const rows = settings.map(s => {
    const problems = [];
    if (s.startText && s.start == null) problems.push(`Не понятно «Начало»: «${s.startText}» (нужно 27.11.2026 08:00)`);
    else if (!s.startText && anyStart) problems.push("Нет «Начало»");
    if (s.start != null) {
      const same = settings.filter(o => o !== s && o.start === s.start);
      if (same.length) problems.push(`То же «Начало», что у «${same.map(o => o.title).join("», «")}»`);
    }
    const tabs = settings.filter(o => o.tab === s.tab).length;
    if (tabs > 1) problems.push(`Вкладка «${s.tab}» указана у ${tabs} потоков`);
    let mark = "";
    if (s === pick.stream) mark = pick.status === "upcoming" ? "upcoming" : "live";
    else if (s === pick.next) mark = "next";
    return { stream: s, mark, when: s.start != null ? fmtVenueDate(s.start) + " " + fmtVenueTime(s.start) : "", problems };
  });
  return { rows, notes, status: pick.status };
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
    const hasData = (yearCol >= 0 && cells[yearCol]) || (clubCol >= 0 && cells[clubCol]) ||
      (startCol >= 0 && cells[startCol]) || Object.values(appCols).some(i => cells[i]);
    // separator row «Кольца» → everyone below starts on rings
    const label = !hasData && filled.length <= 2 ? filled.find(isApparatusLabel) : null;
    if (label) { section = apparatusFromText(label, gender); return; }
    // category rows («2018», «3 взрослый», «Юг») are skipped; a gymnast without year/club is kept
    if (!name || (!hasData && !looksLikePerson(name))) return;
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
  const m = venueMinutes(now);   // «Время ротаций» is Aktobe time, whatever the device's time zone
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

// Problems that would make a gymnast or an apparatus silently disappear from the screens
function streamWarnings(stream) {
  const w = [];
  const missing = ORDER[stream.gender].filter(a => !stream.apps.includes(a));
  if (missing.length) w.push("Нет колонки: " + missing.map(a => APPARATUS[a].short).join(", "));
  const placed = stream.gymnasts.filter(g => g.start).length;
  const loose = stream.gymnasts.length - placed;
  if (placed && loose) w.push(`Без стартового снаряда: ${loose} чел. — их нет на табло и у судей`);
  if (!placed && stream.gymnasts.length) w.push("Ни у кого не указан стартовый снаряд — все показаны на всех снарядах");
  const seen = {}, dup = new Set();
  stream.gymnasts.forEach(g => { const k = norm(g.name); if (seen[k]) dup.add(g.name); seen[k] = 1; });
  if (dup.size) w.push("Повторяется ФИО: " + [...dup].join(", "));
  return w;
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
// Reads give up after 20 s, so a hung request never blocks the next refresh (writes are not touched).
async function fetchRead(url) {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), 20000) : null;
  try { return await fetch(url, { cache: "no-store", signal: ctl ? ctl.signal : undefined }); }
  catch (e) { throw new Error(e && e.name === "AbortError" ? "Нет ответа от сервера" : "Нет связи"); }
  finally { if (t) clearTimeout(t); }
}
async function gvizText(tab) {
  const res = await fetchRead(gvizUrl(tab));
  if (!res.ok) throw new Error("Нет доступа к Google-таблице (" + res.status + ")");
  const text = await res.text();
  if (/^\s*</.test(text)) throw new Error("Google-таблица закрыта: включите доступ «Все, у кого есть ссылка»");
  return text;
}
async function gvizValues(tab) { return parseCSV(await gvizText(tab)); }

function scriptUrl() {
  // the deployed script address is built in; ?api=… only matters if it is ever cleared
  if (CONFIG.SCRIPT_URL) return CONFIG.SCRIPT_URL;
  const p = new URLSearchParams(location.search).get("api");
  if (p) { try { localStorage.setItem("artvin-api", p); } catch (e) {} return p; }
  try { return localStorage.getItem("artvin-api") || CONFIG.SCRIPT_URL; } catch (e) { return CONFIG.SCRIPT_URL; }
}
async function scriptGet(params) {
  const url = scriptUrl();
  if (!url) throw new Error("Не указан адрес скрипта (api)");
  const res = await fetchRead(url + "?" + new URLSearchParams(params));
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
  if (!j.ok) { const e = new Error(j.error || "Ошибка сервера"); e.conflict = !!j.conflict; e.current = j.current; throw e; }
  return j;
}

// Same comparison as the server: "9,3" == "9.300", "" only equals ""
function sameScore(a, b) {
  const x = String(a == null ? "" : a).trim(), y = String(b == null ? "" : b).trim();
  if (x === "" || y === "") return x === y;
  const nx = parseScore(x), ny = parseScore(y);
  return nx != null && ny != null ? Math.abs(nx - ny) < 1e-9 : x === y;
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
  const times = Array.from({ length: 6 }, (_, i) => fmtVenueTime(t0.getTime() + i * 120000)).join(" ");
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
// Does the stream's tab exist? Google's CSV export silently returns the FIRST sheet for an unknown
// tab name, so compare with a name that certainly does not exist.
async function tabExists(src, tab) {
  if (src === "demo") return !!demoInit().tabs[tab];
  if (src === "script") { try { await scriptGet({ action: "tab", tab }); return true; } catch (e) { return false; } }
  const [a, b] = await Promise.all([gvizText(tab), gvizText("__нет_такой_вкладки_" + Date.now())]);
  return a !== b;
}
async function loadStream(src, st) {
  if (src === "demo") return parseStream(demoInit().tabs[st.tab] || [], st.gender, 1);
  if (src === "script") return parseStream((await scriptGet({ action: "tab", tab: st.tab })).values, st.gender, 1);
  return parseStream(await gvizValues(st.tab), st.gender, null);
}

global.ArtVin = {
  CONFIG, APPARATUS, ORDER, ROT_MODES,
  norm, esc, parseScore, fmtScore, parseCSV, parseSettings, parseStream, parseGender, apparatusFromText,
  appAtRotation, autoRotation, timeRotation, currentRotation, groupsAt, rankList, hasScore, isFinished, rotationProgress,
  streamWarnings, isApparatusLabel, looksLikePerson, parseTimes,
  scriptGet, scriptPost, scriptUrl, sameScore,
  demoInit, demoSave, randomScore, DEMO_KEY,
  loadSettings, loadStream, tabExists,
  VENUE, venueParts, venueMinutes, venueDay, fmtVenueTime, fmtVenueDate, parseStart,
  activeStream, startsLabel, scheduleCheck,
};
})(window);
