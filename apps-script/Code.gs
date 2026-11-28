/**
 * ArtVin Cup — приём оценок от судей.
 *
 * Вставить в Google-таблицу: Расширения → Apps Script → заменить содержимое Code.gs этим файлом.
 * Затем: Начать развертывание → Новое развертывание → тип «Веб-приложение»,
 *        «Запуск от имени: Я», «Доступ: Все» → Развернуть.
 * После этого в таблице появится меню «ArtVin Cup» → «Коды судей».
 *
 * Защита: у каждого снаряда свой 8-значный код. Снаряд определяется только по коду на сервере —
 * страница судьи не может выбрать другой снаряд. Коды хранятся в свойствах скрипта, а не в таблице
 * (таблица открыта для просмотра). После неверного кода — пауза 1,5 с, чтобы коды нельзя было подобрать.
 */

var JUDGE_PAGE = "https://miner229.github.io/table-site/judge.html";
var SETTINGS_TAB = "Настройки";
var LOG_TAB = "Журнал";
var MAX_SCORE = 16;

var APPS = {
  floor:  "Вольные упражнения", pommel: "Конь-махи", rings: "Кольца", vault: "Опорный прыжок",
  pbars:  "Параллельные брусья", hbar: "Перекладина", ubars: "Брусья разной высоты", beam: "Бревно"
};
var ORDER = { M: ["floor", "pommel", "rings", "vault", "pbars", "hbar"], F: ["vault", "ubars", "beam", "floor"] };

/* ---------------- helpers ---------------- */
function norm_(s) { return String(s == null ? "" : s).toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim(); }
function gender_(s) { return /^(ж|д|f|w)/.test(norm_(s)) ? "F" : "M"; }
function appFromText_(text, g) {
  var t = norm_(text);
  if (!t || t.length > 40) return null;
  if (/вольн/.test(t)) return "floor";
  if (/конь|махи/.test(t)) return "pommel";
  if (/кольц/.test(t)) return "rings";
  if (/прыж/.test(t)) return "vault";
  if (/брус/.test(t)) return g === "F" ? "ubars" : "pbars";
  if (/перекл/.test(t)) return "hbar";
  if (/бревн/.test(t)) return "beam";
  return null;
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function sheet_(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error("Нет вкладки «" + name + "»");
  return sh;
}
function keys_() {
  var raw = PropertiesService.getScriptProperties().getProperty("JUDGE_KEYS");
  return raw ? JSON.parse(raw) : {};
}
// Judge code: 8 digits, may be typed with spaces/dashes ("4827 1935").
function normKey_(key) { return String(key || "").replace(/[\s-]/g, ""); }
function judge_(key) {
  var v = keys_()[normKey_(key)];
  if (!v) {
    Utilities.sleep(1500);   // slows down guessing codes
    throw new Error("Неверный код судьи");
  }
  var p = v.split(":");
  return { gender: p[0], app: p[1] };
}
function settingsValues_() { return sheet_(SETTINGS_TAB).getDataRange().getDisplayValues(); }
// values: «Настройки» already read in this request (saves a second read of the tab)
function streams_(values) {
  values = values || settingsValues_();
  var hi = -1;
  for (var i = 0; i < values.length; i++) if (values[i].some(function (c) { return /лист/.test(norm_(c)); })) { hi = i; break; }
  if (hi < 0) throw new Error("Во вкладке «Настройки» нет колонки «Лист»");
  var h = values[hi].map(norm_);
  var tabCol = h.findIndex(function (c) { return /лист/.test(c); });
  var gCol = h.findIndex(function (c) { return /^пол/.test(c); });
  var aCol = h.findIndex(function (c) { return /экран|актив/.test(c); });
  var sCol = h.findIndex(function (c) { return /^начал/.test(c); });
  var out = {};
  values.slice(hi + 1).forEach(function (r) {
    var tab = String(r[tabCol] || "").trim();
    if (tab) out[tab] = { gender: gender_(gCol >= 0 ? r[gCol] : ""), active: aCol >= 0 && isYes_(r[aCol]),
                          start: sCol >= 0 ? startMs_(r[sCol]) : null };
  });
  return out;
}

/* ---------------- test scores are cleared when a stream starts ----------------
 * Scores typed into a stream BEFORE its «Начало» are tests. On the first request to this script
 * after «Начало» (judge pages ask every few seconds) the stream's score cells are cleared ONCE.
 * A judge's first real score is itself such a request, so the clear always happens before it.
 * Safety: if nothing reached the script within 45 min after «Начало», the stream is marked done
 * WITHOUT clearing — a late redeploy or an edited «Начало» can never wipe real results.
 * Only apparatus columns are cleared (not ФИО, Год, Клуб, «Сумма» formulas). Logged in «Журнал». */
var VENUE_OFFSET_MS = 5 * 3600000;          // Aktobe, UTC+5 all year — same as the site
var CLEAR_WINDOW_MS = 45 * 60000;
function now_() { return Date.now(); }
// «27.11.2026 8:00» / «27.11.2026 08:00:00» / «2026-11-27 08:00» (Aktobe time) → ms, or null
function startMs_(text) {
  var t = String(text == null ? "" : text).trim(), m;
  if ((m = t.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})[,\sT]+(\d{1,2})[:.](\d{2})/))) {
    var y = +m[3]; if (y < 100) y += 2000;
    return Date.UTC(y, +m[2] - 1, +m[1], +m[4], +m[5]) - VENUE_OFFSET_MS;
  }
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[\sT]+(\d{1,2}):(\d{2})/)))
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - VENUE_OFFSET_MS;
  return null;
}
function clearedAtStart_() {
  var raw = PropertiesService.getScriptProperties().getProperty("START_CLEARED");
  return raw ? JSON.parse(raw) : {};
}
// sv: «Настройки» values already read in this request. lock: the request's lock, or null (then one is taken here).
function autoClear_(sv, lock) {
  var all = streams_(sv), t = now_();
  var due = function (done) {
    return Object.keys(all).filter(function (tab) { var s = all[tab]; return s.start != null && s.start <= t && !done[tab]; });
  };
  if (!due(clearedAtStart_()).length) return;          // the usual case: nothing to do, no lock needed
  var own = !lock;
  if (own) { lock = LockService.getScriptLock(); if (!lock.tryLock(10000)) return; }   // busy: the next request does it
  else lock_(lock);                                     // the request's own lock (kept for its write that follows)
  try {
    var done = clearedAtStart_();                       // re-read under the lock: another request may have done it
    due(done).forEach(function (tab) {
      var s = all[tab];
      if (t - s.start > CLEAR_WINDOW_MS) { done[tab] = "не очищено (позже 45 мин)"; return; }
      var sh = SpreadsheetApp.getActive().getSheetByName(tab);
      if (!sh) { done[tab] = "нет вкладки"; return; }
      var values = sh.getDataRange().getDisplayValues();
      var hi = headerIndex_(values), head = values[hi], n = 0;
      var nameCol = head.findIndex(function (c) { return /^фио/.test(norm_(c)); });
      var startCol = head.findIndex(function (c) { return /старт/.test(norm_(c)); });
      head.forEach(function (h, c) {
        if (c === nameCol || c === startCol || !appFromText_(h, s.gender)) return;
        var filled = 0;
        for (var r = hi + 1; r < values.length; r++) if (String(values[r][c]).trim() !== "") filled++;
        if (!filled) return;
        sh.getRange(hi + 2, c + 1, values.length - hi - 1, 1).clearContent();
        n += filled;
      });
      done[tab] = new Date(t).toISOString();
      if (n) safeLog_([new Date(t), "Старт потока", tab, "", "Тестовые оценки удалены перед стартом", n + " шт.", "очищено"]);
    });
    PropertiesService.getScriptProperties().setProperty("START_CLEARED", JSON.stringify(done));
    SpreadsheetApp.flush();
  } finally {
    if (own) { try { lock.releaseLock(); } catch (x) {} }
  }
}
function isYes_(v) { return /^(да|yes|1|\+|x|х|✓)/.test(norm_(v)); }
// Stream chosen by the organiser («На экране» = да). While one is chosen, scores go ONLY there.
function chosenTab_(streams) {
  var t = Object.keys(streams).filter(function (k) { return streams[k].active; });
  return t.length ? t[0] : null;
}

/* ---------------- organiser code (switches the stream for judges and screens) ---------------- */
function adminKey_() {
  var props = PropertiesService.getScriptProperties();
  var k = props.getProperty("ADMIN_KEY");
  if (!k) { k = randomKey_(); props.setProperty("ADMIN_KEY", k); }
  return k;
}
function checkAdmin_(code) {
  if (normKey_(code) !== adminKey_()) {
    Utilities.sleep(1500);
    throw new Error("Неверный код организатора");
  }
}

/* ---------------- secretary code (the only way to change or delete a score once it is entered) ---------------- */
function secretaryKey_() {
  var props = PropertiesService.getScriptProperties();
  var k = props.getProperty("SECRETARY_KEY");
  if (!k) {
    var taken = keys_(), admin = props.getProperty("ADMIN_KEY");
    do { k = randomKey_(); } while (taken[k] || k === admin);
    props.setProperty("SECRETARY_KEY", k);
  }
  return k;
}
function checkSecretary_(code) {
  if (!normKey_(code) || normKey_(code) !== secretaryKey_()) {
    Utilities.sleep(1500);
    throw new Error("Неверный код секретаря");
  }
}
// tab = stream to show and judge; "" = back to the «Начало» schedule
function setStream_(tab) {
  var sh = sheet_(SETTINGS_TAB);
  var values = sh.getDataRange().getDisplayValues();
  var hi = -1;
  for (var i = 0; i < values.length; i++) if (values[i].some(function (c) { return /лист/.test(norm_(c)); })) { hi = i; break; }
  if (hi < 0) throw new Error("Во вкладке «Настройки» нет колонки «Лист»");
  var h = values[hi].map(norm_);
  var tabCol = h.findIndex(function (c) { return /лист/.test(c); });
  var aCol = h.findIndex(function (c) { return /экран|актив/.test(c); });
  if (aCol < 0) {   // no «На экране» column yet → add it after the last header
    aCol = values[hi].length;
    sh.getRange(hi + 1, aCol + 1).setValue("На экране");
  }
  var found = !tab;
  for (var r = hi + 1; r < values.length; r++) {
    var t = String(values[r][tabCol] || "").trim();
    if (!t) continue;
    var want = tab && t === tab ? "да" : "";
    if (want) found = true;
    if (String(values[r][aCol] || "") !== want) sh.getRange(r + 1, aCol + 1).setValue(want);
  }
  if (!found) throw new Error("Поток «" + tab + "» не найден в «Настройках»");
}
function headerIndex_(values) {
  for (var i = 0; i < values.length; i++)
    if (values[i].some(function (c) { return /^фио/.test(norm_(c)); })) return i;
  throw new Error("Во вкладке нет строки заголовков с «ФИО»");
}

/* ---------------- web app ---------------- */
function doGet(e) {
  try {
    var p = e.parameter || {};
    if (p.action === "settings") { var sv0 = settingsValues_(); autoClear_(sv0, null); return json_({ ok: true, values: sv0 }); }
    // Judges poll this: settings + the stream they are on, in ONE call (every call costs ~1.5 s).
    // «Настройки» is read once and also used to check that the tab is a stream.
    if (p.action === "state") {
      var sv = settingsValues_();
      autoClear_(sv, null);                               // before reading the tab: the judge sees the cleared stream
      var out = { ok: true, settings: sv };
      if (p.tab && streams_(sv)[p.tab]) {
        var tsh = SpreadsheetApp.getActive().getSheetByName(p.tab);
        if (tsh) { out.tab = p.tab; out.values = tsh.getDataRange().getDisplayValues(); }
      }
      return json_(out);
    }
    if (p.action === "tab") {
      var sv1 = settingsValues_();
      if (!streams_(sv1)[p.tab]) throw new Error("Поток не найден в «Настройках»");
      autoClear_(sv1, null);
      return json_({ ok: true, values: sheet_(p.tab).getDataRange().getDisplayValues() });
    }
    if (p.action === "adminCheck") { checkAdmin_(p.key); return json_({ ok: true }); }
    if (p.action === "secretaryCheck") { checkSecretary_(p.key); return json_({ ok: true }); }
    if (p.action === "whoami") { var j = judge_(p.key); return json_({ ok: true, gender: j.gender, app: j.app, name: APPS[j.app] }); }
    return json_({ ok: true, service: "ArtVin Cup scores" });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var b = JSON.parse(e.postData.contents);
    if (b.action === "setStream") {
      checkAdmin_(b.admin);
      lock_(lock);
      var tab = String(b.tab || "").trim();
      setStream_(tab);
      SpreadsheetApp.flush();
      safeLog_([new Date(), "Организатор", tab || "по расписанию", "", "Поток для судей и табло", "", tab ? "да" : "расписание"]);
      return json_({ ok: true, tab: tab });
    }
    if (b.action === "score") {
      // Judge: the apparatus comes ONLY from the key. A score can be entered ONCE.
      var j = judge_(b.key);
      var sv = settingsValues_();
      var all = streams_(sv);
      autoClear_(sv, lock);                               // a first real score after «Начало» clears the tests first
      var st = all[b.tab];
      if (!st) throw new Error("Поток не найден в «Настройках»");
      if (st.gender !== j.gender) throw new Error("Этот поток не для вашего снаряда");
      var chosen = chosenTab_(all);
      if (chosen && chosen !== b.tab) throw new Error("Сейчас оценки принимаются только в поток «" + chosen + "»");
      return json_(writeScore_(lock, b, st.gender, j.app, "judge"));
    }
    if (b.action === "fix") {
      // Secretary: corrects or clears any score in any stream, with the secretary code.
      checkSecretary_(b.secret);
      var ssv = settingsValues_();
      autoClear_(ssv, lock);
      var sst = streams_(ssv)[b.tab];
      if (!sst) throw new Error("Поток не найден в «Настройках»");
      if (ORDER[sst.gender].indexOf(b.app) < 0) throw new Error("Нет такого снаряда в этом потоке");
      return json_(writeScore_(lock, b, sst.gender, b.app, "secretary"));
    }
    throw new Error("Неизвестное действие");
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

// One write path for judges and the secretary — same checks, only the overwrite rule differs.
// b: { tab, row, name, value, expected } · who: "judge" | "secretary"
function writeScore_(lock, b, gender, app, who) {
  // value: "" (удалить), «н/я» (не явился) or number 0..MAX_SCORE with up to 3 decimals.
  // «н/я» is stored as the number 0 with the number format "н/я" (score columns stay numeric, the sum is
  // unchanged, the sheet and the site show «н/я»). A real 0 is a plain 0. Pages from before 28.11 sent
  // 0 for «н/я»; new pages mark a real zero with zero: true — so a bare 0 still means «н/я».
  var raw = String(b.value == null ? "" : b.value).trim().replace(",", ".");
  var value = "", dns = false;
  if (isDns_(raw)) { value = 0; dns = true; }
  else if (raw !== "") {
    if (!/^\d{1,2}(\.\d{1,3})?$/.test(raw)) throw new Error("Неверный формат оценки");
    value = Number(raw);
    if (value < 0 || value > MAX_SCORE) throw new Error("Оценка должна быть от 0 до " + MAX_SCORE);
    if (value === 0 && !(b.zero === true || b.zero === 1 || b.zero === "1")) dns = true;
  }
  if (who === "judge" && value === "") throw new Error("Удалить оценку может только секретарь");

  lock_(lock);
  var sh = sheet_(b.tab);
  var values = sh.getDataRange().getDisplayValues();
  var hi = headerIndex_(values);
  var head = values[hi];
  var nameCol = head.findIndex(function (c) { return /^фио/.test(norm_(c)); });
  var startCol = head.findIndex(function (c) { return /старт/.test(norm_(c)); });
  var col = -1;
  for (var c = 0; c < head.length; c++) {
    if (c === nameCol || c === startCol) continue;
    if (appFromText_(head[c], gender) === app) { col = c; break; }
  }
  if (col < 0) throw new Error("В потоке нет колонки «" + APPS[app] + "»");

  var row = Number(b.row);
  if (!(row - 1 > hi && row <= values.length)) throw new Error("Неверная строка");
  if (norm_(values[row - 1][nameCol]) !== norm_(b.name)) throw new Error("Список изменился — обновите страницу");

  var cell = sh.getRange(row, col + 1);
  var old = cell.getDisplayValue();
  // The same value again (e.g. the answer to the first try was lost on a bad network): nothing to do.
  var shownNew = value === "" ? "" : dns ? "н/я" : String(value);
  if (sameScore_(old, shownNew)) return { ok: true, unchanged: true };
  // Judges: once a score is in the cell, only the secretary can change it.
  if (who === "judge" && old !== "") {
    return { ok: false, locked: true, current: old, error: "Оценка уже выставлена: " + old + ". Исправить может только секретарь" };
  }
  // Refuse to overwrite a value the page has not seen (two devices / secretary and a judge at once).
  // b.expected = the value the page showed before the change ("" = empty).
  if (b.expected !== undefined && !sameScore_(old, b.expected)) {
    return { ok: false, conflict: true, current: old, error: "Оценку уже изменили на другом устройстве: " + (old || "пусто") };
  }
  if (value === "") cell.clearContent();
  else {
    cell.setValue(value);
    if (dns) cell.setNumberFormat(DNS_FORMAT);
    // a cell that once held «н/я» keeps that format after a clear: give it back the column's number format
    else if (cell.getNumberFormat() === DNS_FORMAT) cell.setNumberFormat(plainFormat_(sh, hi, col, values.length));
  }
  SpreadsheetApp.flush();
  var label = APPS[app] + (gender === "F" ? " (Ж)" : " (М)");
  safeLog_([new Date(), who === "secretary" ? "Секретарь · " + label : label, b.tab, row, b.name, old, value === "" ? "удалено" : dns ? "н/я" : value]);
  return { ok: true };
}

var DNS_FORMAT = '"н/я"';
function isDns_(s) { return /^н\s*\/?\s*я$/.test(norm_(s)); }
// the number format of the other score cells in the column (not «н/я»)
function plainFormat_(sh, hi, col, rows) {
  var n = Math.max(1, rows - hi - 1);
  var f = sh.getRange(hi + 2, col + 1, n, 1).getNumberFormats().map(function (r) { return r[0]; })
    .filter(function (x) { return x && x !== DNS_FORMAT && x !== "@"; });
  return f.length ? f[0] : "0.###############";
}
// One-off, run once from the editor on 28.11: zeros entered before this version meant «н/я».
// Only the number format of those cells changes («н/я»); the values (0) stay as they are.
function markOldZerosAsDns() {
  var all = streams_(), out = [];
  Object.keys(all).forEach(function (tab) {
    var sh = SpreadsheetApp.getActive().getSheetByName(tab);
    if (!sh) return;
    var values = sh.getDataRange().getDisplayValues();
    var hi = headerIndex_(values), head = values[hi];
    var nameCol = head.findIndex(function (c) { return /^фио/.test(norm_(c)); });
    var startCol = head.findIndex(function (c) { return /старт/.test(norm_(c)); });
    var cells = [];
    head.forEach(function (h, c) {
      if (c === nameCol || c === startCol || !appFromText_(h, all[tab].gender)) return;
      for (var r = hi + 1; r < values.length; r++) if (String(values[r][c]).trim() === "0") cells.push(String.fromCharCode(65 + c) + (r + 1));
    });
    if (cells.length) { sh.getRangeList(cells).setNumberFormat(DNS_FORMAT); out.push(tab + ": " + cells.join(", ")); }
  });
  SpreadsheetApp.flush();
  safeLog_([new Date(), "Секретарь", "", "", "Старые 0 = н/я (только формат)", out.join(" · "), "н/я"]);
  Logger.log(out.join("\n") || "нулей нет");
  return out;
}

function sameScore_(a, b) {
  var x = String(a == null ? "" : a).trim().replace(",", "."), y = String(b == null ? "" : b).trim().replace(",", ".");
  if (x === "" || y === "") return x === y;
  var nx = Number(x), ny = Number(y);
  return isFinite(nx) && isFinite(ny) ? Math.abs(nx - ny) < 1e-9 : x === y;
}

// Many judges save at the same moment: wait up to 15 s for the others, then say so in Russian.
function lock_(lock) {
  if (!lock.tryLock(15000)) throw new Error("Сервер занят — нажмите ✓ ещё раз");
}
// The score is already written when we log it: a problem with «Журнал» must not turn a saved
// score into «Не сохранено» (the judge would retry and get a false «conflict»).
function safeLog_(row) {
  try { log_(row); } catch (e) { console.error("Журнал: " + e); }
}
function log_(row) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(LOG_TAB);
  if (!sh) {
    sh = ss.insertSheet(LOG_TAB);
    sh.appendRow(["Время", "Снаряд", "Поток", "Строка", "ФИО", "Было", "Стало"]);
    sh.setFrozenRows(1);
  }
  sh.appendRow(row);
}

/* ---------------- menu for the organiser ---------------- */
function onOpen() {
  SpreadsheetApp.getUi().createMenu("ArtVin Cup")
    .addItem("Коды судей", "showJudgeLinks")
    .addItem("Создать новые коды (старые перестанут работать)", "resetKeys")
    .addSeparator()
    .addItem("Подготовить вкладку «Настройки»", "setupSettings")
    .addItem("Подготовить вкладки потоков", "prepareStreamTabs")
    .addToUi();
}

/* Freshly imported start lists have only № | ФИО | Год | Разряд | Регион/Клуб.
 * For every tab listed in «Настройки» this appends the missing score columns (by the stream's Пол)
 * and «Сумма» to the right of the last used column. Existing cells are never changed. */
var SCORE_HEADERS = {
  M: ["Вольные", "Конь", "Кольца", "Прыжок", "Брусья", "Перекладина"],
  F: ["Прыжок", "Брусья", "Бревно", "Вольные"]
};
function prepareStreamTabs_() {
  var ss = SpreadsheetApp.getActive();
  var st = streams_();
  var report = [];
  Object.keys(st).forEach(function (tab) {
    var g = st[tab].gender;
    var sh = ss.getSheetByName(tab);
    if (!sh) { report.push("«" + tab + "»: вкладки нет"); return; }
    var values = sh.getDataRange().getDisplayValues();
    var hi;
    try { hi = headerIndex_(values); } catch (e) { report.push("«" + tab + "»: нет строки заголовков с «ФИО»"); return; }
    var head = values[hi];
    var nameCol = head.findIndex(function (c) { return /^фио/.test(norm_(c)); });
    var startCol = head.findIndex(function (c) { return /старт/.test(norm_(c)); });
    var have = {}, hasSum = false;
    head.forEach(function (c, i) {
      if (/^сумм/.test(norm_(c))) { hasSum = true; return; }
      if (i === nameCol || i === startCol) return;
      var a = appFromText_(c, g);
      if (a) have[a] = true;
    });
    var add = [];
    SCORE_HEADERS[g].forEach(function (name) { if (!have[appFromText_(name, g)]) add.push(name); });
    if (!hasSum) add.push("Сумма");
    if (!add.length) { report.push("«" + tab + "»: всё на месте"); return; }
    var col = Math.max(sh.getLastColumn(), values.length ? values[0].length : 0) + 1;   // first empty column
    add.forEach(function (name, k) { sh.getRange(hi + 1, col + k).setValue(name); });
    report.push("«" + tab + "» (" + (g === "F" ? "Ж" : "М") + "): добавлено " + add.join(", "));
  });
  return report;
}
function prepareStreamTabs() {
  var report = prepareStreamTabs_();
  SpreadsheetApp.getUi().alert("Вкладки потоков", report.length ? report.join("\n") : "В «Настройках» нет потоков.", SpreadsheetApp.getUi().ButtonSet.OK);
}

function randomKey_() {
  var s = "";
  for (var i = 0; i < 8; i++) s += Math.floor(Math.random() * 10);
  return s.charAt(0) === "0" ? "1" + s.slice(1) : s;
}
function fmtKey_(k) { return k.slice(0, 4) + " " + k.slice(4); }
function makeKeys_() {
  var k = {};
  ["M", "F"].forEach(function (g) { ORDER[g].forEach(function (a) {
    var key; do { key = randomKey_(); } while (k[key]);
    k[key] = g + ":" + a;
  }); });
  PropertiesService.getScriptProperties().setProperty("JUDGE_KEYS", JSON.stringify(k));
  var a; do { a = randomKey_(); } while (k[a]);
  PropertiesService.getScriptProperties().setProperty("ADMIN_KEY", a);
  var s; do { s = randomKey_(); } while (k[s] || s === a);
  PropertiesService.getScriptProperties().setProperty("SECRETARY_KEY", s);
  return k;
}
function resetKeys() {
  var ui = SpreadsheetApp.getUi();
  if (ui.alert("Создать новые коды?", "Все старые коды и ссылки судей перестанут работать.", ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  makeKeys_();
  showJudgeLinks();
}
function showJudgeLinks() {
  var api = ScriptApp.getService().getUrl();
  if (!api) {
    SpreadsheetApp.getUi().alert("Сначала разверните скрипт: Начать развертывание → Новое развертывание → Веб-приложение (Запуск от имени: Я, Доступ: Все).");
    return;
  }
  var k = keys_();
  if (!Object.keys(k).length || !/^\d{8}$/.test(Object.keys(k)[0])) k = makeKeys_();
  var common = JUDGE_PAGE + "?api=" + encodeURIComponent(api);
  var rows = Object.keys(k).map(function (key) {
    var p = k[key].split(":");
    return { g: p[0], app: p[1], key: key };
  }).sort(function (a, b) { return a.g === b.g ? ORDER[a.g].indexOf(a.app) - ORDER[b.g].indexOf(b.app) : (a.g === "M" ? -1 : 1); });
  var html = "<style>body{font-family:Arial;font-size:13px}td{padding:6px 8px;border-bottom:1px solid #eee}" +
    ".code{font:bold 18px monospace;letter-spacing:2px}input{width:100%;font-size:11px}</style>" +
    "<p style='background:#fff8e6;padding:8px 10px;border-radius:6px'><b>Организатор.</b> Код для переключения потока: " +
    "<span class='code'>" + fmtKey_(adminKey_()) + "</span><br>Страница секретаря → «Поток для всех» → этот код. " +
    "Экран в зале открывайте по этой ссылке (с настройками); родителям — ссылку без «?screen=1»:" +
    "<input readonly onclick='this.select()' value='" + JUDGE_PAGE.replace(/judge\.html$/, "") + "?screen=1'></p>" +
    "<p style='background:#eef6ff;padding:8px 10px;border-radius:6px'><b>Секретарь.</b> Код для исправления оценок: " +
    "<span class='code'>" + fmtKey_(secretaryKey_()) + "</span><br>Судья ставит оценку только один раз. Исправить или удалить её " +
    "может только секретарь: страница протокола → «Исправить оценки» → этот код → нажать на оценку." +
    "<input readonly onclick='this.select()' value='" + JUDGE_PAGE.replace(/judge\.html$/, "secretary.html") + "'></p>" +
    "<p><b>1. Ссылка для всех судей</b> (одна и та же):</p><input readonly onclick='this.select()' value='" + common + "'>" +
    "<p><b>2. Каждому судье — только код его снаряда.</b> Судья открывает ссылку, выбирает снаряд и вводит код " +
    "(или сразу ссылку своего снаряда из последней колонки). Код открывает только свой снаряд.</p><table>" +
    rows.map(function (r) {
      var link = common + "&g=" + r.g + "&app=" + r.app;   // opens the code screen of this apparatus
      return "<tr><td><b>" + (r.g === "M" ? "Мальчики" : "Девочки") + "</b></td><td>" + APPS[r.app] + "</td><td class='code'>" + fmtKey_(r.key) +
        "</td><td><input readonly onclick='this.select()' value='" + link + "'></td></tr>";
    }).join("") + "</table><p style='color:#777'>Если код попал не тому — меню ArtVin Cup → «Создать новые коды».</p>";
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(820).setHeight(620), "Коды судей");
}
function setupSettings() {
  var ss = SpreadsheetApp.getActive();
  if (ss.getSheetByName(SETTINGS_TAB)) { SpreadsheetApp.getUi().alert("Вкладка «Настройки» уже есть."); return; }
  var sh = ss.insertSheet(SETTINGS_TAB, 0);
  sh.getRange(1, 1, 1, 8).setValues([["Поток", "Лист", "Пол", "Ротация", "Режим", "Время ротаций", "На экране", "Начало"]]).setFontWeight("bold");
  sh.getRange(2, 1, 1, 8).setValues([["Пятница · Поток 1", "Пятница 1", "М", 1, "ручной", "", "", "27.11.2026 08:00"]]);
  sh.setFrozenRows(1);
}
