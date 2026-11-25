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
  const sheet = name => ({
    getDataRange: () => ({ getDisplayValues: () => tabs[name].map(r => r.map(String)) }),
    getRange: (r, c) => ({
      getDisplayValue: () => (tabs[name][r - 1][c - 1] ?? ""),
      setValue: v => { while (tabs[name].length < r) tabs[name].push([]); tabs[name][r - 1][c - 1] = String(v); },
      clearContent: () => { tabs[name][r - 1][c - 1] = ""; },
    }),
    appendRow: row => log.push(row),
    getLastColumn: () => Math.max(0, ...tabs[name].map(r => { let n = r.length; while (n && r[n - 1] === "") n--; return n; })),
    setFrozenRows: () => {},
  });
  const ctx = {
    SpreadsheetApp: {
      getActive: () => ({ getSheetByName: n => (tabs[n] || n === "Журнал" ? sheet(n) : null), insertSheet: n => { tabs[n] = []; return sheet(n); } }),
      flush: () => {},
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k], setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({
      waitLock: () => { lockDepth++; maxLockDepth = Math.max(maxLockDepth, lockDepth); },
      releaseLock: () => { lockDepth = Math.max(0, lockDepth - 1); },
    }) },
    Utilities: { sleep: ms => { slept += ms; } },
    ContentService: { createTextOutput: s => ({ setMimeType: () => JSON.parse(s) }), MimeType: { JSON: 1 } },
  };
  tabs["Журнал"] = [];
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "apps-script", "Code.gs"), "utf8"), ctx);
  const keys = ctx.makeKeys_();
  const key = {}; Object.keys(keys).forEach(k => { key[keys[k]] = k; });
  const post = b => ctx.doPost({ postData: { contents: JSON.stringify(Object.assign({ action: "score" }, b)) } });
  return { ctx, tabs, key, keys, post, log, lock: () => ({ lockDepth, maxLockDepth }), slept: () => slept };
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
