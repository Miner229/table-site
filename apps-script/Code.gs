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

var JUDGE_PAGE = "https://miner229.github.io/table-site/demo/judge.html";
var SETTINGS_TAB = "Настройки";
var LOG_TAB = "Журнал";
var MAX_SCORE = 10;

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
function streams_() {
  var values = sheet_(SETTINGS_TAB).getDataRange().getDisplayValues();
  var hi = -1;
  for (var i = 0; i < values.length; i++) if (values[i].some(function (c) { return /лист/.test(norm_(c)); })) { hi = i; break; }
  if (hi < 0) throw new Error("Во вкладке «Настройки» нет колонки «Лист»");
  var h = values[hi].map(norm_);
  var tabCol = h.findIndex(function (c) { return /лист/.test(c); });
  var gCol = h.findIndex(function (c) { return /^пол/.test(c); });
  var out = {};
  values.slice(hi + 1).forEach(function (r) {
    var tab = String(r[tabCol] || "").trim();
    if (tab) out[tab] = { gender: gender_(gCol >= 0 ? r[gCol] : "") };
  });
  return out;
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
    if (p.action === "settings") return json_({ ok: true, values: sheet_(SETTINGS_TAB).getDataRange().getDisplayValues() });
    if (p.action === "tab") {
      if (!streams_()[p.tab]) throw new Error("Поток не найден в «Настройках»");
      return json_({ ok: true, values: sheet_(p.tab).getDataRange().getDisplayValues() });
    }
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
    if (b.action !== "score") throw new Error("Неизвестное действие");
    var j = judge_(b.key);                      // apparatus comes ONLY from the key
    var st = streams_()[b.tab];
    if (!st) throw new Error("Поток не найден в «Настройках»");
    if (st.gender !== j.gender) throw new Error("Этот поток не для вашего снаряда");

    // value: "" (удалить) or number 0..MAX_SCORE with up to 3 decimals; 0 = «не выступал»
    var raw = String(b.value == null ? "" : b.value).trim().replace(",", ".");
    var value = "";
    if (raw !== "") {
      if (!/^\d{1,2}(\.\d{1,3})?$/.test(raw)) throw new Error("Неверный формат оценки");
      value = Number(raw);
      if (value < 0 || value > MAX_SCORE) throw new Error("Оценка должна быть от 0 до " + MAX_SCORE);
    }

    lock.waitLock(15000);
    var sh = sheet_(b.tab);
    var values = sh.getDataRange().getDisplayValues();
    var hi = headerIndex_(values);
    var head = values[hi];
    var nameCol = head.findIndex(function (c) { return /^фио/.test(norm_(c)); });
    var startCol = head.findIndex(function (c) { return /старт/.test(norm_(c)); });
    var col = -1;
    for (var c = 0; c < head.length; c++) {
      if (c === nameCol || c === startCol) continue;
      if (appFromText_(head[c], st.gender) === j.app) { col = c; break; }
    }
    if (col < 0) throw new Error("В потоке нет колонки «" + APPS[j.app] + "»");

    var row = Number(b.row);
    if (!(row - 1 > hi && row <= values.length)) throw new Error("Неверная строка");
    if (norm_(values[row - 1][nameCol]) !== norm_(b.name)) throw new Error("Список изменился — обновите страницу");

    var cell = sh.getRange(row, col + 1);
    var old = cell.getDisplayValue();
    // Two devices on the same apparatus: refuse to overwrite a score the judge has not seen.
    // b.expected = the value the judge's page showed before the change ("" = empty).
    if (b.expected !== undefined && !sameScore_(old, b.expected)) {
      return json_({ ok: false, conflict: true, current: old, error: "Оценку уже изменили на другом устройстве: " + (old || "пусто") });
    }
    if (sameScore_(old, value === "" ? "" : String(value))) return json_({ ok: true, unchanged: true });
    if (value === "") cell.clearContent(); else cell.setValue(value);
    SpreadsheetApp.flush();
    log_([new Date(), APPS[j.app] + (j.gender === "F" ? " (Ж)" : " (М)"), b.tab, row, b.name, old, value === "" ? "удалено" : value]);
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

function sameScore_(a, b) {
  var x = String(a == null ? "" : a).trim().replace(",", "."), y = String(b == null ? "" : b).trim().replace(",", ".");
  if (x === "" || y === "") return x === y;
  var nx = Number(x), ny = Number(y);
  return isFinite(nx) && isFinite(ny) ? Math.abs(nx - ny) < 1e-9 : x === y;
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
