// Unit tests for demo/core.js (parsing, rotation, ranking, streams).
// Run: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadCore() {
  const store = {};
  const ctx = {
    window: {},
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    location: { search: "" },
    URLSearchParams, console, Date, Math, JSON, Number, String, Array, Object, Set, RegExp, Error,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "demo", "core.js"), "utf8"), ctx);
  return ctx.ArtVin;
}
const A = loadCore();
// core.js runs in its own VM context, so its arrays have a different prototype: compare as plain data
const plain = x => JSON.parse(JSON.stringify(x));
const deq = (a, b, msg) => assert.deepEqual(plain(a), plain(b), msg);
const M_HEAD = ["№", "ФИО", "Год", "Клуб", "Старт", "Вольные", "Конь", "Кольца", "Прыжок", "Брусья", "Перекладина", "Сумма"];
const F_HEAD = ["№", "ФИО", "Год", "Клуб", "Старт", "Прыжок", "Брусья", "Бревно", "Вольные", "Сумма"];

// build a stream tab: groups = [{ start: "Вольные", n: 10 }, …]
function tab(head, groups) {
  const rows = [head];
  let k = 0;
  groups.forEach(gr => {
    for (let i = 0; i < gr.n; i++) {
      k++;
      const r = new Array(head.length).fill("");
      r[0] = String(k); r[1] = `Фамилия${k} Имя${k}`; r[2] = "2017"; r[3] = "Клуб"; r[4] = gr.start;
      rows.push(r);
    }
  });
  return rows;
}
function fillRotation(values, stream, r, score = "9.000") {
  stream.gymnasts.forEach(g => {
    const a = A.appAtRotation(g.start, r, stream.gender);
    if (stream.appCols[a] != null) values[g.row - 1][stream.appCols[a]] = score;
  });
}
const SIX = ["Вольные", "Конь", "Кольца", "Прыжок", "Брусья", "Перекладина"];

/* ---------------- parsing ---------------- */
test("settings: any number of streams, modes, active flag", () => {
  const rows = [["Поток", "Лист", "Пол", "Ротация", "Режим", "Время ротаций", "На экране"]];
  for (let i = 1; i <= 14; i++) rows.push([`Поток ${i}`, `Лист ${i}`, i % 2 ? "М" : "Ж", "", i % 3 ? "авто" : "время", "08:00 08:30", i === 5 ? "да" : ""]);
  const s = A.parseSettings(rows);
  assert.equal(s.length, 14);
  assert.equal(s[0].gender, "M"); assert.equal(s[1].gender, "F");
  assert.equal(s[0].rotation, 1);
  assert.equal(s[2].mode, "time"); assert.equal(s[0].mode, "auto");
  deq(s.filter(x => x.active).map(x => x.tab), ["Лист 5"]);
  deq(s[0].times, [480, 510]);
});

test("stream: columns found by header, separator rows, category rows, gymnast without year/club kept", () => {
  const v = [
    ["№", "ФИО", "Год", "Клуб", "Вольные", "Конь", "Кольца", "Прыжок", "Брусья", "Перекладина"],
    ["", "Кольца"],
    ["1", "Вольнов Иван", "2017", "ArtVin"],      // surname looks like «Вольные» — must stay a gymnast
    ["", "2018"],                                  // category row — skipped
    ["2", "Сидоров Петя"],                         // no year/club yet — must not be dropped
    ["", "Юг"],
    ["3", "3 взрослый"],
    ["", "Вольные упражнения"],
    ["4", "Конев Олег", "", "", "9.1"],
  ];
  const s = A.parseStream(v, "M", 1);
  deq(s.gymnasts.map(g => [g.name, g.start, g.row]),
    [["Вольнов Иван", "rings", 3], ["Сидоров Петя", "rings", 5], ["Конев Олег", "floor", 9]]);
  assert.equal(s.gymnasts[2].scores.floor.num, 9.1);
});

test("stream: girls' «Брусья» is uneven bars, boys' is parallel bars", () => {
  deq(A.parseStream(tab(F_HEAD, [{ start: "Брусья", n: 1 }]), "F", 1).apps, ["vault", "ubars", "beam", "floor"]);
  assert.equal(A.parseStream(tab(F_HEAD, [{ start: "Брусья", n: 1 }]), "F", 1).gymnasts[0].start, "ubars");
  assert.equal(A.parseStream(tab(M_HEAD, [{ start: "Брусья", n: 1 }]), "M", 1).gymnasts[0].start, "pbars");
});

test("scores: comma decimals, 0 = did not compete", () => {
  assert.equal(A.parseScore("9,450"), 9.45);
  assert.equal(A.parseScore(""), null);
  assert.equal(A.fmtScore(9.45), "9,450");
  assert.ok(A.sameScore("9,3", "9.300"));
  assert.ok(!A.sameScore("", "0"));
  assert.ok(A.sameScore("", ""));
});

/* ---------------- rotation ---------------- */
test("rotation: 6 groups × 10 — everyone on exactly one apparatus each rotation, each apparatus exactly once overall", () => {
  const s = A.parseStream(tab(M_HEAD, SIX.map(start => ({ start, n: 10 }))), "M", 1);
  const visits = new Map(s.gymnasts.map(g => [g.name, []]));
  for (let r = 1; r <= 6; r++) {
    const groups = A.groupsAt(s, r);
    const seen = Object.values(groups).flat().map(g => g.name);
    assert.equal(seen.length, 60, `rotation ${r}: nobody skipped or duplicated`);
    assert.equal(new Set(seen).size, 60);
    Object.entries(groups).forEach(([a, list]) => { assert.equal(list.length, 10); list.forEach(g => visits.get(g.name).push(a)); });
  }
  visits.forEach(v => deq([...v].sort(), [...A.ORDER.M].sort()));
});

test("rotation: groups move in Olympic order (floor → pommel → rings → vault → pbars → hbar)", () => {
  deq([1, 2, 3, 4, 5, 6].map(r => A.appAtRotation("floor", r, "M")), A.ORDER.M);
  deq([1, 2, 3, 4, 5, 6].map(r => A.appAtRotation("hbar", r, "M")), ["hbar", "floor", "pommel", "rings", "vault", "pbars"]);
  deq([1, 2, 3, 4].map(r => A.appAtRotation("beam", r, "F")), ["beam", "floor", "vault", "ubars"]);
});

test("rotation: fewer groups than apparatus (bye) and uneven group sizes", () => {
  const s = A.parseStream(tab(M_HEAD, [{ start: "Вольные", n: 7 }, { start: "Кольца", n: 12 }, { start: "Брусья", n: 3 }]), "M", 1);
  for (let r = 1; r <= 6; r++) {
    const seen = Object.values(A.groupsAt(s, r)).flat();
    assert.equal(seen.length, 22);
    assert.equal(new Set(seen.map(g => g.name)).size, 22);
  }
  const g1 = A.groupsAt(s, 1);
  assert.equal(g1.pommel.length, 0);
  assert.equal(g1.rings.length, 12);
});

test("auto rotation: advances only when every apparatus has finished; then the next group arrives", () => {
  const v = tab(M_HEAD, SIX.map(start => ({ start, n: 10 })));
  let s = A.parseStream(v, "M", 1);
  const st = { rotation: 1, mode: "auto", times: [] };
  assert.equal(A.currentRotation(s, st).rotation, 1);
  // all but one score of rotation 1
  fillRotation(v, s, 1);
  v[s.gymnasts[59].row - 1][s.appCols[A.appAtRotation(s.gymnasts[59].start, 1, "M")]] = "";
  s = A.parseStream(v, "M", 1);
  assert.equal(A.currentRotation(s, st).rotation, 1, "one missing score blocks the rotation");
  deq(A.rotationProgress(s, 1).hbar, { done: 9, total: 10 });
  fillRotation(v, s, 1);
  s = A.parseStream(v, "M", 1);
  const info = A.currentRotation(s, st);
  assert.equal(info.rotation, 2);
  assert.equal(info.finished, false);
  // rotation 2: rings now shows the group that started on pommel, with no rings scores yet ("reset" on screen)
  const rings = A.rankList(A.groupsAt(s, 2).rings, "rings");
  assert.ok(rings.every(i => i.g.start === "pommel" && i.status === "wait"));
  // their pommel scores are still stored
  assert.ok(A.groupsAt(s, 2).rings.every(g => g.scores.pommel.num === 9));
});

test("auto rotation: «н/я» (0) counts as done; full stream ends finished at rotation 6", () => {
  const v = tab(M_HEAD, SIX.map(start => ({ start, n: 10 })));
  let s = A.parseStream(v, "M", 1);
  for (let r = 1; r <= 6; r++) { fillRotation(v, s, r, r === 3 ? "0" : "8.5"); s = A.parseStream(v, "M", 1); }
  const info = A.currentRotation(s, { rotation: 1, mode: "auto", times: [] });
  assert.equal(info.rotation, 6);
  assert.equal(info.finished, true);
  assert.ok(s.gymnasts.every(g => s.apps.every(a => A.hasScore(g, a))));
});

test("manual and time modes", () => {
  const s = A.parseStream(tab(M_HEAD, SIX.map(start => ({ start, n: 2 }))), "M", 1);
  assert.equal(A.currentRotation(s, { rotation: 4, mode: "manual", times: [] }).rotation, 4);
  assert.equal(A.currentRotation(s, { rotation: 99, mode: "manual", times: [] }).rotation, 6, "clamped");
  assert.equal(A.currentRotation(s, { rotation: 3, mode: "auto", times: [] }).rotation, 3, "manual cell is a minimum in auto");
  const times = A.parseTimes("08:00 08:30 09:00 09:30 10:00 10:30");
  const at = (h, m) => { const d = new Date(2026, 10, 27, h, m); return A.currentRotation(s, { rotation: 1, mode: "time", times }, null, d).rotation; };
  assert.equal(at(7, 30), 1);
  assert.equal(at(8, 29), 1);
  assert.equal(at(8, 30), 2);
  assert.equal(at(12, 0), 6);
});

test("missing apparatus column does not block auto rotation and is reported", () => {
  const head = M_HEAD.filter(h => h !== "Конь");
  const v = tab(head, SIX.map(start => ({ start, n: 2 })));
  let s = A.parseStream(v, "M", 1);
  assert.ok(A.streamWarnings(s).some(w => /Нет колонки: Конь/.test(w)));
  fillRotation(v, s, 1); s = A.parseStream(v, "M", 1);
  assert.equal(A.autoRotation(s), 2);
});

test("warnings: gymnasts without a start apparatus are reported, not silently dropped", () => {
  const v = tab(M_HEAD, [{ start: "Вольные", n: 3 }, { start: "", n: 2 }]);
  const s = A.parseStream(v, "M", 1);
  assert.equal(s.gymnasts.length, 5);
  assert.ok(A.streamWarnings(s).some(w => /Без стартового снаряда: 2/.test(w)));
});

/* ---------------- ranking ---------------- */
test("ranking: highest first, ties share the place, waiting and «н/я» at the bottom", () => {
  const v = tab(M_HEAD, [{ start: "Вольные", n: 5 }]);
  const col = 5;
  v[1][col] = "8.900"; v[2][col] = "9.300"; v[3][col] = "9.300"; v[4][col] = "0"; /* v[5] waiting */
  const s = A.parseStream(v, "M", 1);
  const r = A.rankList(s.gymnasts, "floor");
  deq(r.map(i => [i.g.name.split(" ")[0], i.status, i.place]), [
    ["Фамилия2", "scored", 1], ["Фамилия3", "scored", 1], ["Фамилия1", "scored", 3],
    ["Фамилия5", "wait", undefined], ["Фамилия4", "dns", undefined],
  ]);
});

/* ---------------- streams ---------------- */
test("streams are independent: same names, different tabs, different rotations", () => {
  const v1 = tab(M_HEAD, SIX.map(start => ({ start, n: 10 })));
  const v2 = tab(M_HEAD, SIX.map(start => ({ start, n: 10 })));
  let s1 = A.parseStream(v1, "M", 1);
  fillRotation(v1, s1, 1); s1 = A.parseStream(v1, "M", 1);
  const s2 = A.parseStream(v2, "M", 1);
  assert.equal(A.autoRotation(s1), 2);
  assert.equal(A.autoRotation(s2), 1);
  assert.equal(s2.gymnasts.filter(g => A.hasScore(g, "floor")).length, 0);
});

test("demo data: 10 gymnasts per apparatus, unique names", () => {
  const d = A.demoInit(true);
  const m = A.parseStream(d.tabs["Демо М"], "M", 1);
  const f = A.parseStream(d.tabs["Демо Ж"], "F", 1);
  assert.equal(new Set(m.gymnasts.map(g => g.name)).size, 60);
  assert.ok(Object.values(A.groupsAt(m, 1)).every(l => l.length === 10));
  assert.ok(Object.values(A.groupsAt(f, 1)).every(l => l.length === 10));
  deq(A.streamWarnings(m), []);
});
