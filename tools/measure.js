// Read-only latency measurement of the live data paths (no writes).
// usage: node tools/measure.js [rounds]   (read-only: never writes to the sheet)
const core = require("path").join(__dirname, "..", "core.js"), N = +process.argv[2] || 6;
global.window = {}; global.localStorage = { getItem: () => null, setItem() {} }; global.location = { search: "" };
require(core);
const A = window.ArtVin;
const ID = A.CONFIG.SHEET_ID, API = A.CONFIG.SCRIPT_URL;
const gviz = s => `https://docs.google.com/spreadsheets/d/${ID}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(s)}&_=${Date.now()}`;

async function time(label, url) {
  const ms = [];
  let bytes = 0, err = null;
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    try {
      const r = await fetch(url(), { redirect: "follow" });
      const txt = await r.text();
      bytes = txt.length;
      if (!r.ok) err = r.status;
      if (url().includes("script.google") && !/"ok":true/.test(txt)) err = txt.slice(0, 80);
    } catch (e) { err = e.message; }
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  const p = q => Math.round(ms[Math.min(ms.length - 1, Math.floor(q * ms.length))]);
  console.log(`${label.padEnd(38)} n=${N} min=${p(0)} med=${p(0.5)} max=${p(1)} ms  ${bytes} B${err ? "  ERR " + err : ""}`);
}

(async () => {
  await time("gviz  Настройки", () => gviz("Настройки"));
  await time("gviz  Суббота 1 (64 чел.)", () => gviz("Суббота 1"));
  await time("script GET ping (no sheet access)", () => API + "?_=" + Math.random());
  await time("script GET settings", () => API + "?action=settings&_=" + Math.random());
  await time("script GET tab Суббота 1", () => API + "?action=tab&tab=" + encodeURIComponent("Суббота 1") + "&_=" + Math.random());

  // client-side CPU: parse + rank, the work done on every refresh
  const values = A.parseCSV(await (await fetch(gviz("Суббота 1"))).text());
  const settings = A.parseSettings(A.parseCSV(await (await fetch(gviz("Настройки"))).text()));
  const st = settings.find(s => s.tab === "Суббота 1");
  let t = performance.now(), K = 2000;
  for (let i = 0; i < K; i++) {
    const s = A.parseStream(values, st.gender, null);
    const g = A.groupsAt(s, 1);
    s.apps.forEach(a => A.rankList(g[a], a));
    A.currentRotation(s, st, null);
  }
  console.log(`client parse+rank one refresh (64 чел.)        ${((performance.now() - t) / K).toFixed(3)} ms`);
  t = performance.now();
  for (let i = 0; i < K; i++) A.activeStream(settings, Date.now());
  console.log(`activeStream                                     ${((performance.now() - t) / K * 1000).toFixed(1)} µs`);
})();
