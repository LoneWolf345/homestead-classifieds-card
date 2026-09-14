// smoke.mjs — node harness for homestead-classifieds-card (no browser, no framework)
import fs from "node:fs"; import vm from "node:vm";
const src = fs.readFileSync(new URL("./homestead-classifieds-card.js", import.meta.url), "utf8");
// the shadow root counts innerHTML assignments (`_sets`) so the render-dedupe check can see a swap that should not happen
class HTMLElement { constructor() { this._sr = null; this.style = {}; this._h = 300; this._sets = 0; } attachShadow() { const self = this; let html = ""; this._sr = { get innerHTML() { return html; }, set innerHTML(v) { html = v; self._sets++; }, querySelectorAll: () => [], querySelector: () => null }; return this._sr; } get shadowRoot() { return this._sr; } dispatchEvent() {} getBoundingClientRect() { return { height: this._h }; } }
const defs = {}; const store = new Map();
const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
const ctx = { HTMLElement, customElements: { define: (n, c) => (defs[n] = c), get: (n) => defs[n] }, document: { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } }, console, CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } }, setInterval: () => 0, clearInterval() {}, setTimeout, Date, localStorage, requestAnimationFrame: (f) => setTimeout(f, 0) };
ctx.window = ctx; vm.createContext(ctx); vm.runInContext(src, ctx);
const Card = defs["homestead-classifieds-card"];
let fails = 0;
const check = (name, cond) => { console.log((cond ? "ok  " : "FAIL") + " " + name); if (!cond) fails++; };
const mkHass = (states, callApi, callWS) => ({ states, callApi: callApi || (async () => []), callWS: callWS || (async () => ({ items: [] })) });
const tick = () => new Promise((r) => setTimeout(r, 20));
const today = new Date(); const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const T = ymd(today);

check("card registered", typeof Card === "function");
check("setConfig rejects missing mode", (() => { try { new Card().setConfig({}); return false; } catch (e) { return /mode/.test(e.message); } })());

// ---- calendar
{
  const el = new Card(); el.setConfig({ mode: "calendar", calendars: [{ entity: "calendar.james", name: "James" }, { entity: "calendar.henry", name: "Henry" }], milestones_entity: "calendar.celebrations" });
  const tomorrow = new Date(today.getTime() + 86400000); const T1 = ymd(tomorrow); const T2 = ymd(new Date(tomorrow.getTime() + 86400000));
  const ev = (summary, start, end, extra) => Object.assign({ summary, start, end }, extra);
  const api = async (m, url) => {
    if (url.startsWith("calendars/calendar.james")) return [ev("School Picture Day", { date: T1 }, { date: T2 }), ev("Cross Country Practice", { dateTime: `${T1}T06:00:00-07:00` }, { dateTime: `${T1}T07:00:00-07:00` })];
    if (url.startsWith("calendars/calendar.henry")) return [ev("School Picture Day", { date: T1 }, { date: T2 }), ev("Cub Scout Den Meeting", { dateTime: `${T1}T18:30:00-07:00` }, { dateTime: `${T1}T20:00:00-07:00` }, { location: "Copper Sky" })];
    if (url.startsWith("calendars/calendar.celebrations")) return [ev("Jim's Birthday", { date: T1 }, { date: T2 }, { description: "Born 1960" })];
    return [];
  };
  el.hass = mkHass({}, api); await tick(); await tick();
  const h = el.shadowRoot.innerHTML;
  check("calendar: kicker", h.includes("COMMUNITY CALENDAR"));
  check("calendar: today empty quip (fallback)", h.includes("Nothing on the docket"));
  check("calendar: dedupes picture day with joined byline", (h.match(/School Picture Day/g) || []).length === 1 && h.includes("James &amp; Henry"));
  check("calendar: location line", h.includes('class="loc">Copper Sky'));
  check("calendar: milestone age", h.includes(`Jim turns ${tomorrow.getFullYear() - 1960} tomorrow.`));
  check("calendar: footer counts calendars", h.includes("Compiled from 2 calendars"));
}

// ---- height memory (load-time layout shift guard)
{
  const el = new Card(); el.setConfig({ mode: "calendar", calendars: [{ entity: "calendar.x", name: "X" }] });
  el.hass = mkHass({}, () => new Promise(() => {})); // fetch never resolves
  const h = el.shadowRoot.innerHTML;
  check("hm: calendar shows kicker only while loading", h.includes("COMMUNITY CALENDAR") && !h.includes("Nothing on the docket") && !h.includes("TODAY<"));
  check("hm: pinned at current height during the swap", el.style.minHeight === "300px");
  await tick();
  check("hm: no reservation on first ever load (after the swap tick)", el.style.minHeight === "");
  store.set("hcc-h:calendar:calendar.x:", "480");
  const el2 = new Card(); el2.setConfig({ mode: "calendar", calendars: [{ entity: "calendar.x", name: "X" }] });
  el2.hass = mkHass({}, () => new Promise(() => {})); await tick();
  check("hm: reserves remembered height while loading", el2.style.minHeight === "480px");
  const el3 = new Card(); el3._h = 512; el3.setConfig({ mode: "calendar", calendars: [{ entity: "calendar.x", name: "X" }] });
  el3.hass = mkHass({}, async () => []); await tick(); await tick(); await new Promise((r) => setTimeout(r, 120));
  check("hm: releases reservation once loaded", el3.style.minHeight === "" && el3.shadowRoot.innerHTML.includes("Nothing on the docket"));
  check("hm: remembers rendered height", store.get("hcc-h:calendar:calendar.x:") === "512");
  const el4 = new Card(); el4.setConfig({ mode: "notices", todo_lists: ["todo.a"] });
  store.set("hcc-h:notices::todo.a", "388");
  el4.hass = mkHass({ "todo.a": { state: "0", attributes: {} } }, null, () => new Promise(() => {}));
  check("hm: notices reserves until to-dos answer", el4.style.minHeight === "388px" && el4.shadowRoot.innerHTML.includes("PUBLIC NOTICES"));
}

// ---- masthead / colophon
{
  const el = new Card(); el.setConfig({ mode: "masthead", title: "The Homestead Times", place: "Maricopa, Arizona", price: "Two bits", tagline_entity: "sensor.homestead_tagline", tagline_fallback: "Fallback line" });
  el.hass = mkHass({ "sensor.homestead_tagline": { state: "Opinions expressed are those of the automations", attributes: {} } });
  await tick(); const h = el.shadowRoot.innerHTML; const t0 = new Date(today); t0.setHours(0, 0, 0, 0); const doy = Math.round((t0 - new Date(t0.getFullYear(), 0, 0)) / 86400000);
  check("mast: title + vol/no + place + price", h.includes("The Homestead Times") && h.includes(`VOL. ${today.getFullYear() % 10}, No. ${doy} · MARICOPA, ARIZONA · PRICE: TWO BITS`));
  check("mast: tagline from sensor", h.includes("Opinions expressed are those of the automations"));
  check("mast: no reservation needed (sync)", el.style.minHeight === "");
  const el2 = new Card(); el2.setConfig({ mode: "masthead", tagline_entity: "sensor.homestead_tagline", tagline_fallback: "Fallback line" });
  el2.hass = mkHass({ "sensor.homestead_tagline": { state: "unknown", attributes: {} } });
  check("mast: fallback tagline when sensor unknown", el2.shadowRoot.innerHTML.includes("Fallback line"));
  const el3 = new Card(); el3.setConfig({ mode: "colophon", lead: "Published every minute by Home Assistant", text: "Set in Fraunces and Archivo" });
  el3.hass = mkHass({});
  check("colophon: lead + text", el3.shadowRoot.innerHTML.includes("<strong>Published every minute by Home Assistant</strong> — Set in Fraunces and Archivo"));
  check("mast: title uses its own class (no .mt collision with milestones)", h.includes('class="mh-t"') && !h.includes('class="mt"'));
  const css = h.slice(h.indexOf("<style>"), h.indexOf("</style>"));
  check("css: .mt is the milestone text only (12.5px, not the nameplate)", /\.mt, \.ft \{[^}]*12\.5/.test(css) && !/\.mt \{[^}]*clamp/.test(css));
}

// ---- help_wanted
{
  const el = new Card(); el.setConfig({ mode: "help_wanted" });
  const st = {
    "sensor.chores_due": { state: "2", attributes: { due_list: ["vacuum", "dog_poop"] } },
    "input_select.chore_vacuum_turn": { state: "James" }, "input_text.chore_vacuum_last": { state: "Henry|2026-08-30T16:48" },
    "input_select.chore_dog_poop_turn": { state: "Henry" }, "input_text.chore_dog_poop_last": { state: `James|${T}T16:34` },
    "input_select.chore_dish_load_turn": { state: "James" }, "input_text.chore_dish_load_last": { state: `Henry|${T}T16:54` },
    "input_select.chore_mop_turn": { state: "James" }, "input_text.chore_mop_last": { state: "Henry|2026-08-24T17:01" },
    "sensor.homestead_classifieds": { state: T, attributes: { ad_vacuum: "AI body for vacuum.", help_wanted_footer: "AI footer." } },
  };
  el.hass = mkHass(st); const h = el.shadowRoot.innerHTML;
  check("hw: open ad uses AI copy", h.includes("AI body for vacuum."));
  check("hw: open meta", h.includes("Applications close 8:00 AM"));
  check("hw: due wins over today's stamp (dog_poop open, not struck)", /Yard,[\s\S]*?Open/.test(h) && !/Yard,[\s\S]*?Filled/.test(h));
  check("hw: filled ad struck with time", h.includes("Filled 4:54 PM") && h.includes('class="strike"'));
  check("hw: mid-week mop not listed", !h.includes("Mop,"));
  check("hw: groups by boy with counts", h.includes("James") && h.includes("1 OPEN · 0 FILLED") && h.includes("Henry") && h.includes("1 OPEN · 1 FILLED"));
  check("hw: AI footer", h.includes("AI footer."));
  const el2 = new Card(); el2.setConfig({ mode: "help_wanted", copy_entity: "" }); el2.hass = mkHass(st);
  check("hw: fallback copy without sensor", el2.shadowRoot.innerHTML.includes("Experience with dog hair a plus."));
}

// ---- notices
{
  const el = new Card(); el.setConfig({ mode: "notices", todo_lists: ["todo.chris_tasks"] });
  const ms = (name, obj, state, days, next, last) => ({ state, attributes: { friendly_name: name, maintenance_type: "task", parent_object: obj, days_until_due: days, next_due: next, last_performed: last } });
  const st = {
    "sensor.houseplants_watering": ms("Houseplants Watering", "Houseplants", "due_soon", 0, T, "2026-08-24"),
    "sensor.hvac_filters": ms("HVAC System Replace filters", "HVAC System", "overdue", -12, "2026-08-19", null),
    "sensor.pool_add_chlorine": ms("Pool Add chlorine", "Pool", "ok", 6, "2026-09-06", T),
    "sensor.lawn_mow": ms("Lawn Mow lawn", "Lawn", "ok", 6, "2026-09-06", "2026-08-30"),
    "input_boolean.maint_water_grass": { state: "on", attributes: { friendly_name: "Maint: Water backyard grass" } },
    "todo.chris_tasks": { state: "1", attributes: { friendly_name: "Chris's Tasks" }, last_updated: "x" },
    "sensor.homestead_classifieds": { state: T, attributes: { correction: "The pool was described as refreshing. It is 91°F." } },
  };
  const ws = async (m) => (m.type === "todo/item/list" ? { items: [{ summary: "Ethernet run to garage camera", status: "needs_action" }, { summary: "Old thing", status: "completed" }] } : {});
  el.hass = mkHass(st, null, ws); await tick(); await tick();
  const h = el.shadowRoot.innerHTML;
  check("nt: due today notice", h.includes("watering of the Houseplants falls due this day"));
  check("nt: overdue in arrears + late meta", h.includes("stands 12 days in arrears") && h.includes('class="late"'));
  check("nt: overdue sorts before due", h.indexOf("in arrears") < h.indexOf("falls due this day"));
  check("nt: performed today struck", h.includes("Performed today · Pool") && h.includes('class="strike"'));
  check("nt: flag as standing order", h.includes("by order of the house: water backyard grass."));
  check("nt: todo needs_action only", h.includes("Ethernet run") && !h.includes("Old thing"));
  check("nt: forthcoming line", h.includes("FORTHCOMING") && h.includes("mow lawn"));
  check("nt: correction from AI", h.includes("CORRECTION") && h.includes("It is 91°F."));
  check("nt: counts", h.includes("1 STANDING") && h.includes("2 DUE · 1 PERFORMED"));
}

// ---- hostile strings, unavailable entities, render dedupe, hass before setConfig, a config change mid-fetch, next_due with a time part
{
  const el = new Card(); el.setConfig({ mode: "calendar", calendars: [{ entity: "calendar.x", name: "X" }] });
  const api = async () => [{ summary: "<img src=x onerror=alert(1)>", start: { dateTime: `${T}T23:58:00` }, end: { dateTime: `${T}T23:59:00` }, location: "<img src=x onerror=alert(1)>" }];
  el.hass = mkHass({}, api); await tick(); await tick();
  const h = el.shadowRoot.innerHTML;
  check("hostile event summary/location print escaped, never raw", (h.match(/&lt;img src=x onerror=alert\(1\)&gt;/g) || []).length === 2 && !h.includes("<img src=x"));
}
{
  const el = new Card(); el.setConfig({ mode: "help_wanted" });
  const st = { "sensor.chores_due": { state: "unavailable", attributes: {} }, "sensor.homestead_classifieds": { state: "unavailable", attributes: { help_wanted_empty: "must not print" } } };
  let threw = false; try { el.hass = mkHass(st); } catch (e) { threw = true; }
  const h = el.shadowRoot.innerHTML;
  check("unavailable due/copy sensors: renders the fallback, no error shell, no NaN/undefined", !threw && h.includes("No positions open") && !h.includes("must not print") && !h.includes("color:#b00") && !/NaN|undefined/.test(h));
}
{
  const el = new Card(); el.setConfig({ mode: "help_wanted" });
  const hass = mkHass({ "sensor.chores_due": { state: "1", attributes: { due_list: ["vacuum"] } }, "input_select.chore_vacuum_turn": { state: "James" } });
  el.hass = hass; el.hass = hass; await tick();
  check("render dedupe: the same hass twice → exactly one innerHTML assignment", el._sets === 1 && el.shadowRoot.innerHTML.includes("HELP WANTED"));
}
check("hass before setConfig does not throw", (() => { try { new Card().hass = mkHass({}); return true; } catch (e) { return false; } })());
{
  let resolve; const pending = new Promise((r) => { resolve = r; });
  const el = new Card(); el.setConfig({ mode: "calendar", calendars: [{ entity: "calendar.old", name: "Old" }] });
  el.hass = mkHass({}, () => pending);
  el.setConfig({ mode: "calendar", calendars: [{ entity: "calendar.new", name: "New" }] });
  resolve([{ summary: "Stale event", start: { date: T }, end: { date: T } }]); await tick(); await tick();
  check("setConfig mid-fetch: the stale calendar result is discarded", el._events.length === 0 && el._fetchedAt === 0 && !el.shadowRoot.innerHTML.includes("Stale event"));
  el.hass = mkHass({}, async () => [{ summary: "Fresh event", start: { dateTime: `${T}T23:58:00` }, end: { dateTime: `${T}T23:59:00` } }]); await tick(); await tick();
  check("…and the next hass fetches afresh for the new config", el._fetchedAt > 0 && el.shadowRoot.innerHTML.includes("Fresh event"));
}
{
  const el = new Card(); el.setConfig({ mode: "notices" });
  const d4 = new Date(today); d4.setDate(today.getDate() + 4);
  const st = { "sensor.lawn_mow": { state: "ok", attributes: { friendly_name: "Lawn Mow lawn", maintenance_type: "task", parent_object: "Lawn", days_until_due: 4, next_due: ymd(d4) + "T00:00:00+00:00" } } };
  el.hass = mkHass(st); const h = el.shadowRoot.innerHTML;
  check("next_due with a time part: forthcoming line names the weekday, no undefined", new RegExp(`FORTHCOMING[\\s\\S]*?${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d4.getDay()]}: mow lawn`).test(h) && !/NaN|undefined/.test(h));
}
console.log(fails ? `\n${fails} FAILED` : "\nall passed"); process.exit(fails ? 1 : 0);
