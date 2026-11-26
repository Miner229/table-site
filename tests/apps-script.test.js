// Tests for apps-script/Code.gs with an in-memory spreadsheet (no Google account needed).
// Run: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function setup() {
  const tabs = {
    "Настройки": [["Поток", "Лист", "Пол", "Ротация", "Режим", "Время ротаций", "На экране"],
      ["Пт 1", "Пятница 1", "М", "1", "авто", "", ""],
      ["Пт 2", "Пятница 2", "М", "1", "авто", "", ""],
      ["Вс 1", "Воскресенье 1", "Ж", "1", "ручной", "", ""]],
    "Пятница 1": [["№", "ФИО", "Год", "Клуб", "Старт", "Вольные", "Конь", "Кольца", "Прыжок", "Брусья", "Перекладина", "Сумма"],
      ["", "Вольные упражнения", "", "", "", "", "", "", "", "", "", ""],
      ["1", "Иванов Иван", "2017", "ArtVin", "", "", "", "", "", "", "", ""],
      ["2", "Петров Пётр", "2017", "ArtVin", "", "", "", "", "", "", "", ""]],
    "Пятница 2": [["№", "ФИО", "Год", "Клуб", "Старт", "Вольные", "Конь", "Кольца", "Прыжок", "Брусья", "Перекладина"],
      ["1", "Иванов Иван", "2016", "Gym", "Кольца", "", "", "", "", "", ""]],
    "Воскресенье 1": [["№", "ФИО", "Год", "Клуб", "Старт", "Прыжок", "Брусья", "Бревно", "Вольные"],
      ["1", "Петрова Анна", "2016", "ArtVin", "Прыжок", "", "", "", ""]],
  };
  const log = [];
  let props = {};
  let lockDepth = 0, maxLockDepth = 0, slept = 0;
  // knobs for failure tests, and a count of every Sheets call (each one costs time in Apps Script)
  const knobs = { lockBusy: false, logFails: false };
  const calls = { read: {}, cell: 0, write: 0, append: 0, flush: 0 };
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  const sheet = name => ({
    getDataRange: () => ({ getDisplayValues: () => { bump(calls.read, name); return tabs[name].map(r => r.map(String)); } }),
    getRange: (r, c) => ({
      getDisplayValue: () => { calls.cell++; return tabs[name][r - 1][c - 1] ?? ""; },
      setValue: v => { calls.write++; while (tabs[name].length < r) tabs[name].push([]); tabs[name][r - 1][c - 1] = String(v); },
      clearContent: () => { calls.write++; tabs[name][r - 1][c - 1] = ""; },
    }),
    appendRow: row => { if (knobs.logFails) throw new Error("Журнал защищён"); calls.append++; log.push(row); tabs[name].push(row.map(String)); },
    getLastColumn: () => Math.max(0, ...tabs[name].map(r => { let n = r.length; while (n && r[n - 1] === "") n--; return n; })),
    setFrozenRows: () => {},
  });
  const ctx = {
    SpreadsheetApp: {
      getActive: () => ({ getSheetByName: n => (tabs[n] ? sheet(n) : null), insertSheet: n => { tabs[n] = []; return sheet(n); } }),
      flush: () => { calls.flush++; },
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k], setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => {
      let held = false;
      return {
        tryLock: () => { if (knobs.lockBusy) return false; held = true; lockDepth++; maxLockDepth = Math.max(maxLockDepth, lockDepth); return true; },
        releaseLock: () => { if (held) { held = false; lockDepth = Math.max(0, lockDepth - 1); } },
      };
    } },
    Utilities: { sleep: ms => { slept += ms; } },
    ContentService: { createTextOutput: s => ({ setMimeType: () => JSON.parse(s) }), MimeType: { JSON: 1 } },
  };
  tabs["Журнал"] = [];
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "apps-script", "Code.gs"), "utf8"), ctx);
  const keys = ctx.makeKeys_();
  const key = {}; Object.keys(keys).forEach(k => { key[keys[k]] = k; });
  const post = b => ctx.doPost({ postData: { contents: JSON.stringify(Object.assign({ action: "score" }, b)) } });
  const get = p => JSON.parse(JSON.stringify(ctx.doGet({ parameter: p })));
  const resetCalls = () => { calls.read = {}; calls.cell = calls.write = calls.append = calls.flush = 0; };
  return { ctx, tabs, key, keys, post, get, log, knobs, calls, resetCalls, lock: () => ({ lockDepth, maxLockDepth }), slept: () => slept };
}
const IVANOV = { tab: "Пятница 1", row: 3, name: "Иванов Иван" };

test("a judge writes only the column of the apparatus in their link", () => {
  const { tabs, key, post } = setup();
  assert.equal(post({ ...IVANOV, key: key["M:rings"], value: "9.45", expected: "" }).ok, true);
  assert.equal(tabs["Пятница 1"][2][7], "9.45");                       // Кольца
  // a forged "app" field is ignored: still rings
  post({ ...IVANOV, key: key["M:rings"], app: "floor", value: "8", expected: "9.45" });
  assert.equal(tabs["Пятница 1"][2][5], "");                            // Вольные untouched
  assert.equal(tabs["Пятница 1"][2][7], "8");
});

test("wrong key, wrong gender, header row, renamed row and scores over 10 are rejected", () => {
  const { tabs, key, post } = setup();
  assert.match(post({ ...IVANOV, key: "12345678", value: "9" }).error, /Неверный код/);
  assert.match(post({ ...IVANOV, key: key["F:beam"], value: "9" }).error, /не для вашего снаряда/);
  assert.match(post({ tab: "Пятница 1", row: 1, name: "ФИО", key: key["M:floor"], value: "9" }).error, /Неверная строка/);
  assert.match(post({ ...IVANOV, name: "Сидоров", key: key["M:floor"], value: "9" }).error, /Список изменился/);
  assert.match(post({ ...IVANOV, key: key["M:floor"], value: "10.5" }).error, /от 0 до 10/);
  assert.match(post({ ...IVANOV, key: key["M:floor"], value: "abc" }).error, /формат/);
  assert.match(post({ tab: "Журнал", row: 2, name: "x", key: key["M:floor"], value: "9" }).error, /Поток не найден/);
  assert.ok(tabs["Пятница 1"].slice(1).every(r => r.slice(5).every(c => c === "")));
});

test("girls' bars judge writes the girls' «Брусья» column", () => {
  const { tabs, key, post } = setup();
  assert.equal(post({ tab: "Воскресенье 1", row: 2, name: "Петрова Анна", key: key["F:ubars"], value: "9,2", expected: "" }).ok, true);
  assert.equal(tabs["Воскресенье 1"][1][6], "9.2");
});

test("two devices on one apparatus: a stale page cannot overwrite a score it has not seen", () => {
  const { tabs, key, post } = setup();
  assert.equal(post({ ...IVANOV, key: key["M:vault"], value: "9.1", expected: "" }).ok, true);   // device A
  const b = post({ ...IVANOV, key: key["M:vault"], value: "9.6", expected: "" });                // device B, stale
  assert.equal(b.ok, false);
  assert.equal(b.conflict, true);
  assert.equal(b.current, "9.1");
  assert.equal(tabs["Пятница 1"][2][8], "9.1");
  // after seeing 9.1, B may correct it deliberately
  assert.equal(post({ ...IVANOV, key: key["M:vault"], value: "9.6", expected: "9,100" }).ok, true);
  assert.equal(tabs["Пятница 1"][2][8], "9.6");
});

test("different judges on different apparatus / gymnasts never interfere; every write is locked and logged", () => {
  const { tabs, key, post, log, lock } = setup();
  const apps = ["M:floor", "M:pommel", "M:rings", "M:vault", "M:pbars", "M:hbar"];
  apps.forEach((k, i) => {
    assert.equal(post({ ...IVANOV, key: key[k], value: String(8 + i / 10), expected: "" }).ok, true);
    assert.equal(post({ tab: "Пятница 1", row: 4, name: "Петров Пётр", key: key[k], value: "7.5", expected: "" }).ok, true);
  });
  assert.deepEqual(tabs["Пятница 1"][2].slice(5, 11), ["8", "8.1", "8.2", "8.3", "8.4", "8.5"]);
  assert.deepEqual(tabs["Пятница 1"][3].slice(5, 11), ["7.5", "7.5", "7.5", "7.5", "7.5", "7.5"]);
  assert.equal(log.length, 12);
  assert.equal(lock().lockDepth, 0, "lock released after every request");
});

test("same apparatus judge across streams: scores land in the right stream", () => {
  const { tabs, key, post } = setup();
  post({ tab: "Пятница 2", row: 2, name: "Иванов Иван", key: key["M:rings"], value: "9", expected: "" });
  assert.equal(tabs["Пятница 2"][1][7], "9");
  assert.equal(tabs["Пятница 1"][2][7], "", "same name in another stream untouched");
});

test("clearing a score and re-sending the same value", () => {
  const { tabs, key, post, log } = setup();
  post({ ...IVANOV, key: key["M:hbar"], value: "9", expected: "" });
  assert.equal(post({ ...IVANOV, key: key["M:hbar"], value: "9.000", expected: "9" }).unchanged, true);
  assert.equal(post({ ...IVANOV, key: key["M:hbar"], value: "", expected: "9" }).ok, true);
  assert.equal(tabs["Пятница 1"][2][10], "");
  assert.equal(log.length, 2, "unchanged re-send is not logged");
});

test("read API: settings, stream tabs, whoami", () => {
  const { ctx, key } = setup();
  assert.equal(ctx.doGet({ parameter: { action: "settings" } }).values.length, 4);
  assert.equal(ctx.doGet({ parameter: { action: "tab", tab: "Пятница 2" } }).values.length, 2);
  assert.equal(ctx.doGet({ parameter: { action: "tab", tab: "Журнал" } }).ok, false);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.doGet({ parameter: { action: "whoami", key: key["F:beam"] } }))), { ok: true, gender: "F", app: "beam", name: "Бревно" });
});

test("judge codes: 10 unique 8-digit codes, one per apparatus; spaces allowed; wrong code is slowed down", () => {
  const { ctx, keys, key, post, tabs, slept } = setup();
  const codes = Object.keys(keys);
  assert.equal(codes.length, 10);
  assert.ok(codes.every(c => /^[1-9]\d{7}$/.test(c)));
  assert.equal(new Set(Object.values(keys)).size, 10);
  const spaced = key["M:pbars"].slice(0, 4) + " " + key["M:pbars"].slice(4);
  assert.equal(ctx.doGet({ parameter: { action: "whoami", key: spaced } }).app, "pbars");
  assert.equal(post({ ...IVANOV, key: spaced, value: "8.8", expected: "" }).ok, true);
  assert.equal(tabs["Пятница 1"][2][9], "8.8");                         // Брусья
  const before = slept();
  assert.equal(ctx.doGet({ parameter: { action: "whoami", key: "0000 0000" } }).ok, false);
  assert.ok(slept() - before >= 1000, "wrong code waits before answering");
});

test("every code opens exactly one apparatus column and no other", () => {
  const { tabs, key, post } = setup();
  const cols = { floor: 5, pommel: 6, rings: 7, vault: 8, pbars: 9, hbar: 10 };
  Object.entries(cols).forEach(([app, col]) => {
    const row = tabs["Пятница 1"][2].slice();
    assert.equal(post({ ...IVANOV, key: key["M:" + app], value: "7", expected: row[col] }).ok, true);
    const after = tabs["Пятница 1"][2];
    after.forEach((c, i) => { if (i !== col) assert.equal(c, row[i], `${app} code changed column ${i}`); });
  });
});

test("«Подготовить вкладки потоков»: adds missing score columns + Сумма, never touches existing cells", () => {
  const { ctx, tabs, key, post } = setup();
  const imported = () => [
    ["№", "ФИО", "Год", "Разряд", "Регион/Клуб"],
    ["", "Вольные упражения", "", "", ""],
    ["1", "Вольнов Иван", "2017", "3 юн", "Актобе"],
    ["2", "Брусилов Артём", "2017", "3 юн", "Актау"],
  ];
  tabs["Импорт М"] = imported();
  tabs["Импорт Ж"] = imported();
  tabs["Настройки"].push(["Сб 1", "Импорт М", "М", "1", "авто", "", ""], ["Сб 2", "Импорт Ж", "Ж", "1", "авто", "", ""],
    ["Вс 9", "Нет такой", "М", "1", "авто", "", ""]);
  const before = JSON.stringify(tabs);
  const report = ctx.prepareStreamTabs_();

  assert.deepEqual(tabs["Импорт М"][0], ["№", "ФИО", "Год", "Разряд", "Регион/Клуб", "Вольные", "Конь", "Кольца", "Прыжок", "Брусья", "Перекладина", "Сумма"]);
  assert.deepEqual(tabs["Импорт Ж"][0], ["№", "ФИО", "Год", "Разряд", "Регион/Клуб", "Прыжок", "Брусья", "Бревно", "Вольные", "Сумма"]);
  // existing cells unchanged
  const old = JSON.parse(before);
  ["Импорт М", "Импорт Ж"].forEach(t => old[t].forEach((r, i) => r.forEach((c, j) => assert.equal(tabs[t][i][j], c))));
  assert.deepEqual(tabs["Пятница 1"], old["Пятница 1"], "a complete tab is left alone");
  // only Сумма was missing in «Пятница 2»
  assert.deepEqual(tabs["Пятница 2"][0].slice(-2), ["Перекладина", "Сумма"]);
  assert.ok(report.some(r => /«Нет такой»: вкладки нет/.test(r)));
  assert.ok(report.some(r => /«Пятница 1»: всё на месте/.test(r)));

  // running it again adds nothing
  const once = JSON.stringify(tabs);
  ctx.prepareStreamTabs_();
  assert.equal(JSON.stringify(tabs), once);

  // the new columns work for judges right away
  assert.equal(post({ tab: "Импорт М", row: 3, name: "Вольнов Иван", key: key["M:rings"], value: "9.1", expected: "" }).ok, true);
  assert.equal(tabs["Импорт М"][2][7], "9.1");
  assert.equal(post({ tab: "Импорт Ж", row: 4, name: "Брусилов Артём", key: key["F:beam"], value: "8.4", expected: "" }).ok, true);
  assert.equal(tabs["Импорт Ж"][3][7], "8.4");
});

test("organiser code switches the stream: «да» only on the chosen one, '' = back to schedule", () => {
  const { ctx, tabs, post } = setup();
  const admin = ctx.adminKey_();
  assert.match(admin, /^[1-9]\d{7}$/);
  const yes = () => tabs["Настройки"].slice(1).map(r => r[1] + "=" + r[6]).join(" ");
  assert.equal(post({ action: "setStream", admin: admin.slice(0, 4) + " " + admin.slice(4), tab: "Пятница 2" }).ok, true);
  assert.equal(yes(), "Пятница 1= Пятница 2=да Воскресенье 1=");
  assert.equal(post({ action: "setStream", admin, tab: "Пятница 1" }).ok, true);
  assert.equal(yes(), "Пятница 1=да Пятница 2= Воскресенье 1=");
  assert.equal(post({ action: "setStream", admin, tab: "" }).ok, true);
  assert.equal(yes(), "Пятница 1= Пятница 2= Воскресенье 1=");
  assert.match(post({ action: "setStream", admin, tab: "Нет такого" }).error, /не найден/);
});

test("wrong organiser code is refused and slowed down; judge codes don't work as organiser code", () => {
  const { ctx, tabs, key, post, slept } = setup();
  const before = slept();
  assert.match(post({ action: "setStream", admin: "11112222", tab: "Пятница 2" }).error, /Неверный код организатора/);
  assert.match(post({ action: "setStream", admin: key["M:rings"], tab: "Пятница 2" }).error, /Неверный код организатора/);
  assert.ok(slept() - before >= 3000);
  assert.ok(tabs["Настройки"].slice(1).every(r => r[6] === "" || r[1] === "Пятница 1"));
  assert.equal(ctx.doGet({ parameter: { action: "adminCheck", key: ctx.adminKey_() } }).ok, true);
  assert.equal(ctx.doGet({ parameter: { action: "adminCheck", key: "11112222" } }).ok, false);
});

test("while a stream is chosen, judges can score only in that stream", () => {
  const { ctx, tabs, key, post } = setup();
  post({ action: "setStream", admin: ctx.adminKey_(), tab: "Пятница 1" });
  assert.equal(post({ ...IVANOV, key: key["M:rings"], value: "9", expected: "" }).ok, true);
  const other = post({ tab: "Пятница 2", row: 2, name: "Иванов Иван", key: key["M:rings"], value: "9", expected: "" });
  assert.match(other.error, /только в поток «Пятница 1»/);
  assert.equal(tabs["Пятница 2"][1][7], "");
  // back to the schedule → no lock (as before)
  post({ action: "setStream", admin: ctx.adminKey_(), tab: "" });
  assert.equal(post({ tab: "Пятница 2", row: 2, name: "Иванов Иван", key: key["M:rings"], value: "9", expected: "" }).ok, true);
});

test("new codes also renew the organiser code", () => {
  const { ctx } = setup();
  const a = ctx.adminKey_();
  ctx.makeKeys_();
  assert.notEqual(ctx.adminKey_(), a);
});

/* ================= CRUD of every operation, failures, and cost (Sheets calls) ================= */

test("score CRUD: create → read → update → delete, each step logged with old → new value", () => {
  const { tabs, key, post, get, log } = setup();
  const k = key["M:rings"], col = 7;
  const cell = () => tabs["Пятница 1"][2][col];
  const readBack = () => get({ action: "state", tab: "Пятница 1" }).values[2][col];

  assert.equal(post({ ...IVANOV, key: k, value: "9.25", expected: "" }).ok, true);          // C
  assert.equal(cell(), "9.25");
  assert.equal(readBack(), "9.25");                                                         // R
  assert.equal(post({ ...IVANOV, key: k, value: "9,4", expected: "9.25" }).ok, true);       // U (comma accepted)
  assert.equal(cell(), "9.4");
  assert.equal(post({ ...IVANOV, key: k, value: "", expected: "9.4" }).ok, true);           // D
  assert.equal(cell(), "");
  assert.equal(readBack(), "");
  assert.deepEqual(log.map(r => [r[5], r[6]]), [["", 9.25], ["9.25", 9.4], ["9.4", "удалено"]]);
  // deleting an empty cell again: nothing to do, nothing logged
  assert.equal(post({ ...IVANOV, key: k, value: "", expected: "" }).unchanged, true);
  assert.equal(log.length, 3);
});

test("score «0» = did not compete is stored as 0, not as empty", () => {
  const { tabs, key, post } = setup();
  assert.equal(post({ ...IVANOV, key: key["M:floor"], value: "0", expected: "" }).ok, true);
  assert.equal(tabs["Пятница 1"][2][5], "0");
});

test("every rejected request leaves the sheet and the log untouched", () => {
  const { tabs, key, post, ctx, log } = setup();
  const k = key["M:floor"];
  const bad = [
    [{ ...IVANOV, key: k, value: "abc" }, /формат/],
    [{ ...IVANOV, key: k, value: "10.5" }, /от 0 до 10/],
    [{ ...IVANOV, key: k, value: "-1" }, /формат/],
    [{ ...IVANOV, key: k, value: "1e1" }, /формат/],
    [{ ...IVANOV, key: k, value: "9.1234" }, /формат/],
    [{ ...IVANOV, key: k, value: "100" }, /формат/],
    [{ ...IVANOV, row: 0, key: k, value: "9" }, /Неверная строка/],
    [{ ...IVANOV, row: 999, key: k, value: "9" }, /Неверная строка/],
    [{ ...IVANOV, row: "3; DROP", key: k, value: "9" }, /Неверная строка/],
    [{ ...IVANOV, name: "Другой Человек", key: k, value: "9" }, /Список изменился/],
    [{ ...IVANOV, tab: "Нет такого", key: k, value: "9" }, /Поток не найден/],
    [{ tab: "Воскресенье 1", row: 2, name: "Петрова Анна", key: k, value: "9" }, /не для вашего снаряда/],
    [{ ...IVANOV, key: "", value: "9" }, /Неверный код/],
    [{ ...IVANOV, key: k, value: "9.5", expected: "9" }, /изменили на другом устройстве/],
  ];
  const before = JSON.stringify(tabs);
  bad.forEach(([body, re]) => {
    const r = post(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.match(r.error, re, JSON.stringify(body));
  });
  assert.match(ctx.doPost({ postData: { contents: "{not json" } }).error, /JSON|Unexpected|Expected/);
  assert.match(ctx.doPost({ postData: { contents: JSON.stringify({ action: "drop" }) } }).error, /Неизвестное действие/);
  assert.equal(JSON.stringify(tabs), before);
  assert.equal(log.length, 0);
});

test("«Журнал» is created with a header on the first write", () => {
  const { tabs, key, post } = setup();
  delete tabs["Журнал"];
  assert.equal(post({ ...IVANOV, key: key["M:hbar"], value: "8", expected: "" }).ok, true);
  assert.deepEqual([...tabs["Журнал"][0]], ["Время", "Снаряд", "Поток", "Строка", "ФИО", "Было", "Стало"]);
  assert.equal(tabs["Журнал"].length, 2);
});

test("a broken «Журнал» never turns a saved score into an error", () => {
  const { tabs, key, post, knobs } = setup();
  knobs.logFails = true;
  const r = post({ ...IVANOV, key: key["M:vault"], value: "9.1", expected: "" });
  assert.equal(r.ok, true, "the judge must see «Сохранено» — the score IS in the sheet");
  assert.equal(tabs["Пятница 1"][2][8], "9.1");
  // a retry by the judge is harmless (same value → unchanged), not a false conflict
  assert.equal(post({ ...IVANOV, key: key["M:vault"], value: "9.1", expected: "9.1" }).unchanged, true);
});

test("server busy: clear Russian message, nothing written, lock not left held", () => {
  const { tabs, key, post, knobs, lock, log } = setup();
  knobs.lockBusy = true;
  const r = post({ ...IVANOV, key: key["M:pommel"], value: "9", expected: "" });
  assert.equal(r.ok, false);
  assert.match(r.error, /Сервер занят/);
  assert.equal(tabs["Пятница 1"][2][6], "");
  assert.equal(log.length, 0);
  knobs.lockBusy = false;
  assert.equal(post({ ...IVANOV, key: key["M:pommel"], value: "9", expected: "" }).ok, true);
  assert.equal(lock().lockDepth, 0);
});

test("stream switch CRUD: set «да», move it, back to schedule; adds «На экране» if the column is missing", () => {
  const { tabs, ctx } = setup();
  tabs["Настройки"] = tabs["Настройки"].map(r => r.slice(0, 6));   // no «На экране» column at all
  const admin = ctx.adminKey_();
  const set = tab => ctx.doPost({ postData: { contents: JSON.stringify({ action: "setStream", admin, tab }) } });
  const yes = () => tabs["Настройки"].slice(1).map(r => r[6] || "");
  assert.equal(set("Пятница 2").ok, true);
  assert.equal(tabs["Настройки"][0][6], "На экране");
  assert.deepEqual(yes(), ["", "да", ""]);
  assert.equal(set("Воскресенье 1").ok, true);
  assert.deepEqual(yes(), ["", "", "да"]);
  assert.equal(set("").ok, true);
  assert.deepEqual(yes(), ["", "", ""]);
  assert.match(set("Нет такого").error, /не найден/);
  assert.deepEqual(yes(), ["", "", ""], "a failed switch changes nothing");
});

test("«state» read: settings + stream in one call; never leaks tabs that are not streams", () => {
  const { get, tabs } = setup();
  const s = get({ action: "state", tab: "Пятница 2" });
  assert.equal(s.ok, true);
  assert.equal(s.settings.length, 4);
  assert.equal(s.tab, "Пятница 2");
  assert.equal(s.values.length, 2);
  const first = get({ action: "state" });                       // first load: no tab yet
  assert.equal(first.settings.length, 4);
  assert.equal(first.values, undefined);
  assert.equal(get({ action: "state", tab: "Журнал" }).values, undefined, "only tabs listed in «Настройки»");
  tabs["Настройки"].push(["Пропал", "Удалённая вкладка", "М", "1", "авто", "", ""]);
  const gone = get({ action: "state", tab: "Удалённая вкладка" });
  assert.equal(gone.ok, true, "a deleted stream tab must not break the judges' settings read");
  assert.equal(gone.values, undefined);
});

test("cost: Sheets calls per operation (each call is time inside Apps Script)", () => {
  const { key, post, get, calls, resetCalls } = setup();
  const reads = () => Object.values(calls.read).reduce((a, b) => a + b, 0);

  // judge poll, new way: ONE request that reads «Настройки» once and the stream once
  resetCalls(); get({ action: "state", tab: "Пятница 1" });
  assert.deepEqual(calls.read, { "Настройки": 1, "Пятница 1": 1 });

  // judge poll, old way: TWO requests, «Настройки» read twice
  resetCalls(); get({ action: "settings" }); get({ action: "tab", tab: "Пятница 1" });
  assert.deepEqual(calls.read, { "Настройки": 2, "Пятница 1": 1 });

  // one score write: settings 1×, stream 1×, one cell read, one write, one flush, one log row
  resetCalls(); post({ ...IVANOV, key: key["M:rings"], value: "9", expected: "" });
  assert.equal(reads(), 2);
  assert.deepEqual([calls.cell, calls.write, calls.flush, calls.append], [1, 1, 1, 1]);

  // a rejected write stops before touching the stream tab
  resetCalls(); post({ ...IVANOV, key: key["M:rings"], value: "abc" });
  assert.equal(calls.read["Пятница 1"] || 0, 0);
  assert.equal(calls.write + calls.append, 0);
});

test("scale: a 500-gymnast stream costs the same number of Sheets calls and stays fast", () => {
  const { tabs, key, post, calls, resetCalls } = setup();
  const head = tabs["Пятница 1"][0];
  for (let i = 0; i < 500; i++) tabs["Пятница 1"].push([String(i + 3), `Фамилия${i} Имя${i}`, "2017", "Клуб", ""].concat(new Array(head.length - 5).fill("")));
  resetCalls();
  const t = process.hrtime.bigint();
  for (let i = 0; i < 50; i++) assert.equal(post({ tab: "Пятница 1", row: 5 + i, name: `Фамилия${i} Имя${i}`, key: key["M:floor"], value: "9", expected: "" }).ok, true);
  const msPerWrite = Number(process.hrtime.bigint() - t) / 1e6 / 50;
  assert.equal(calls.read["Пятница 1"], 50, "one read of the stream per write, whatever its size");
  assert.ok(msPerWrite < 20, `script-side work per write: ${msPerWrite.toFixed(2)} ms`);
});
