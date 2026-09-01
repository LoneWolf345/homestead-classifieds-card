/* homestead-classifieds-card — three newsprint cards for Home Assistant, companions to
 * almanac-weather-card / network-ledger-card.
 *   mode: calendar     — today & tomorrow's events + next milestone
 *   mode: help_wanted  — kids' chores as classified ads, grouped by whose turn
 *   mode: notices      — maintenance (Maintenance Supporter) + to-dos as public notices
 * Read-only: tapping a line opens more-info. Copy: attributes of `copy_entity`
 * (a daily AI sensor) with a built-in fallback for every line. */
const HCC_VERSION = "2026.8.4";
const INK = "#3a2d1f", PAPER = "#f3e7d3", TAN = "#a3876a", BROWN = "#7a6248",
  TERRA = "#c65f38", DOT = "#cfb894", RED = "#7e1d10", GRAPHITE = "#55504a";

const DEFAULT_CHORES = [
  { key: "dish_load",   name: "Load dishes",   lead: "Dishes,",         ad: "dirty, seeking transport to the dishwasher. Must lift five pounds." },
  { key: "dish_unload", name: "Unload dishes", lead: "Dishwasher,",     ad: "full, to be emptied. Clean plates seeking homes." },
  { key: "dog_water",   name: "Dog water",     lead: "Water bowl,",     ad: "refill as needed. Inquire with dog." },
  { key: "dog_feed",    name: "Feed dog",      lead: "Dog,",            ad: "hungry, seeks feeding at 5:30 PM. Will work for kibble." },
  { key: "vacuum",      name: "Vacuum",        lead: "Vacuum operator", ad: "wanted, ground floor. Experience with dog hair a plus." },
  { key: "mop",         name: "Mop",           lead: "Mop,",            ad: "weekly engagement. Water provided." },
  { key: "dog_poop",    name: "Dog poop",      lead: "Yard,",           ad: "requires inspection. Gloves recommended. No experience necessary; none possible." },
];
const FALLBACK = {
  calendar_empty: "Nothing on the docket. Staff remain on standby.",
  calendar_footer: "Compiled from {n} calendars. All events weather permitting, which it is.",
  help_wanted_empty: "No positions open. The household is, briefly, fully staffed.",
  help_wanted_footer: "Rates: 25¢ per word, payable in Wi-Fi. Service resumes upon fulfilment of all positions. An equal-opportunity employer. Opportunity is not optional.",
  notices_empty: "Nothing falls due. The house is, for now, in good standing.",
  wanted_empty: "No situations wanted. Applicants may relax.",
  notices_footer: "Notices remain in force until acted upon, which is rather the problem.",
};
const STRIKES = [
  "M6 9 C 120 4, 300 16, 452 11 L 10 27 C 160 33, 320 24, 448 29",
  "M8 10 C 140 5, 280 17, 456 12 L 12 26 C 150 34, 310 22, 450 30",
  "M6 11 C 130 6, 290 18, 454 10 L 9 27 C 170 32, 330 23, 447 28",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MON3 = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad2 = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const ordinal = (n) => n + ((n % 100 >= 11 && n % 100 <= 13) ? "th" : (["th", "st", "nd", "rd"][n % 10] || "th"));
const clock = (d) => { let h = d.getHours(); const m = pad2(d.getMinutes()); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return `${h}:${m} ${ap}`; };
const strike = (i) => `<svg class="strike" viewBox="0 0 520 40" preserveAspectRatio="none"><path d="${STRIKES[i % STRIKES.length]}"/></svg>`;
const bad = (s) => !s || s === "unknown" || s === "unavailable";

class HomesteadClassifiedsCard extends HTMLElement {
  static getStubConfig() { return { mode: "calendar", calendars: [{ entity: "calendar.family", name: "Family" }] }; }

  setConfig(config) {
    if (!config || !["calendar", "help_wanted", "notices"].includes(config.mode)) throw new Error("homestead-classifieds-card: set mode: calendar | help_wanted | notices");
    const c = Object.assign({
      title: "", subtitle: "", column_rule: false, copy_entity: "sensor.homestead_classifieds", footer: "",
      calendars: [], days: 2, milestones_entity: "", milestone_days: 14, show_location: true,
      chores: null, due_entity: "sensor.chores_due", close_time: "8:00 AM",
      maintenance: true, todo_lists: [], flags_prefix: "input_boolean.maint_", forthcoming_days: 7, correction: true,
    }, config);
    if (c.mode === "calendar" && !(c.calendars && c.calendars.length)) throw new Error("homestead-classifieds-card: calendars: [] is empty");
    c.chores = (c.chores && c.chores.length ? c.chores : DEFAULT_CHORES).map((ch) => Object.assign({
      name: ch.key, lead: (ch.name || ch.key) + ",", ad: "position open. Apply within.",
      turn_entity: `input_select.chore_${ch.key}_turn`, last_entity: `input_text.chore_${ch.key}_last`,
    }, ch));
    this._cfg = c;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._sig = null; this._events = []; this._miles = null; this._todos = [];
    this._fetchedAt = 0; this._fetchDay = ""; this._todoAt = 0; this._todoStamp = null;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._cfg.mode === "calendar") this._maybeFetchCalendars();
    if (this._cfg.mode === "notices" && this._cfg.todo_lists.length) this._maybeFetchTodos();
    this._render();
  }
  getCardSize() { return 6; }
  connectedCallback() { this._tick = setInterval(() => { this._sig = null; this._render(); }, 60000); }
  disconnectedCallback() { clearInterval(this._tick); }

  // ---------- copy: AI sensor attribute, else built-in ----------
  _copy(key, fb) {
    const id = this._cfg.copy_entity;
    const e = id && this._hass && this._hass.states[id];
    const v = e && !bad(e.state) ? e.attributes[key] : null;
    return typeof v === "string" && v.trim() ? v.trim() : fb;
  }

  // ---------- render plumbing ----------
  _render() {
    if (!this._cfg || !this._hass) return;
    // Height memory: until the mode's data has arrived, hold the last rendered height so a
    // page scrolled during load doesn't jump (WebKit has no scroll anchoring; Chrome's is
    // defeated by innerHTML re-renders). The calendar shows only its kicker while loading.
    const loaded = this._loaded();
    const reserve = loaded ? 0 : this._reserve();
    this.style.minHeight = reserve ? reserve + "px" : "";
    let out;
    try {
      if (!loaded && this._cfg.mode === "calendar") {
        out = { sig: "loading", html: this._shell("COMMUNITY CALENDAR", this._cfg.days === 2 ? "TODAY & TOMORROW" : `NEXT ${this._cfg.days} DAYS`, "", "") };
      } else {
        out = this._cfg.mode === "calendar" ? this._calendar() : this._cfg.mode === "help_wanted" ? this._helpWanted() : this._notices();
      }
    } catch (e) {
      out = { sig: "err:" + e.message, html: `<div style="padding:12px;color:#b00;font-family:sans-serif">${esc(e.message)}</div>` };
    }
    if (out.sig === this._sig) return;
    this._sig = out.sig;
    this.shadowRoot.innerHTML = out.html;
    this.shadowRoot.querySelectorAll("[data-entity]").forEach((el) => el.addEventListener("click", () => this._more(el.dataset.entity)));
    if (loaded) setTimeout(() => this._remember(), 60);
  }
  _loaded() {
    const c = this._cfg;
    if (c.mode === "calendar") return this._fetchedAt > 0;
    if (c.mode === "notices") return !c.todo_lists.length || this._todoAt > 0;
    return true;
  }
  _hkey() { const c = this._cfg; return "hcc-h:" + c.mode + ":" + (c.calendars || []).map((x) => x.entity).join(",") + ":" + (c.todo_lists || []).join(","); }
  _reserve() { try { const v = parseInt(localStorage.getItem(this._hkey()), 10); return v > 40 ? v : 0; } catch (e) { return 0; } }
  _remember() { try { const h = Math.round(this.getBoundingClientRect().height); if (h > 40) localStorage.setItem(this._hkey(), String(h)); } catch (e) { /* storage unavailable */ } }
  _more(entityId) {
    if (!entityId) return;
    this.dispatchEvent(new CustomEvent("hass-more-info", { bubbles: true, composed: true, detail: { entityId } }));
  }
  _shell(kicker, right, body, footer) {
    const c = this._cfg;
    return `<style>${this._css()}</style><div class="wrap"><div class="card">
      <div class="sect"><span>${esc(c.title || kicker)}</span><span class="sectr">${esc(c.subtitle || right)}</span></div>
      ${body}${footer ? `<div class="foot">${esc(footer)}</div>` : ""}
    </div></div>`;
  }

  // ---------- mode: calendar ----------
  async _maybeFetchCalendars() {
    const day = ymd(new Date());
    if (this._fetching || (Date.now() - this._fetchedAt < 300000 && this._fetchDay === day)) return;
    this._fetching = true;
    try {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const end = new Date(start.getTime() + this._cfg.days * 86400000);
      const q = (a, b) => `?start=${encodeURIComponent(a.toISOString())}&end=${encodeURIComponent(b.toISOString())}`;
      const lists = await Promise.all(this._cfg.calendars.map((c) =>
        this._hass.callApi("GET", `calendars/${c.entity}${q(start, end)}`).then((r) => r.map((ev) => this._norm(ev, c))).catch(() => null)));
      if (lists.some((l) => l)) {
        const merged = [];
        lists.forEach((l) => (l || []).forEach((ev) => {
          const dup = merged.find((m) => m.title === ev.title && m.start.getTime() === ev.start.getTime() && m.allDay === ev.allDay);
          if (dup) { if (!dup.who.includes(ev.who[0])) dup.who.push(ev.who[0]); } else merged.push(ev);
        }));
        this._events = merged;
      }
      if (this._cfg.milestones_entity) {
        const mend = new Date(start.getTime() + this._cfg.milestone_days * 86400000);
        const mc = { entity: this._cfg.milestones_entity, name: "Milestone" };
        this._miles = await this._hass.callApi("GET", `calendars/${mc.entity}${q(start, mend)}`)
          .then((r) => r.map((ev) => this._norm(ev, mc)).sort((a, b) => a.start - b.start)).catch(() => this._miles);
      }
      this._fetchedAt = Date.now(); this._fetchDay = day;
      this._sig = null; this._render();
    } finally { this._fetching = false; }
  }
  _norm(ev, c) {
    const allDay = !(ev.start && ev.start.dateTime);
    const s = ev.start.dateTime || ev.start.date, e = (ev.end && (ev.end.dateTime || ev.end.date)) || s;
    const parse = (v) => (allDay ? new Date(v + "T00:00:00") : new Date(v));
    return { title: ev.summary || "(untitled)", loc: ev.location || "", desc: ev.description || "", allDay, start: parse(s), end: parse(e), who: [c.name || c.entity], entity: c.entity };
  }
  _calendar() {
    const c = this._cfg, now = new Date(), today = new Date(now); today.setHours(0, 0, 0, 0);
    let body = "";
    for (let i = 0; i < c.days; i++) {
      const day = new Date(today.getTime() + i * 86400000), key = ymd(day), next = new Date(day.getTime() + 86400000);
      const tag = i === 0 ? "TODAY" : i === 1 ? "TOMORROW" : DAYS[day.getDay()].toUpperCase();
      const evs = this._events.filter((ev) => (ev.allDay ? ev.start < next && ev.end > day : ymd(ev.start) === key))
        .sort((a, b) => (a.allDay === b.allDay ? a.start - b.start : a.allDay ? -1 : 1));
      body += `<div class="day"><span class="dn">${DAYS[day.getDay()]}, ${MONTHS[day.getMonth()]} ${day.getDate()}</span><span class="dd">${tag}</span></div>`;
      if (!evs.length) { body += `<div class="empty">${esc(this._copy("calendar_empty", FALLBACK.calendar_empty))}</div>`; continue; }
      body += evs.map((ev) => {
        const live = !ev.allDay && ev.start <= now && ev.end > now, past = !ev.allDay && ev.end <= now;
        return `<div class="row${past ? " past" : ""}" data-entity="${esc(ev.entity)}">
          <span class="t">${ev.allDay ? "All day" : clock(ev.start)}</span>
          <span><span class="ti">${esc(ev.title)}</span>${live ? '<span class="now">NOW</span>' : ""}${c.show_location && ev.loc ? `<div class="loc">${esc(ev.loc)}</div>` : ""}</span>
          <span class="by">${esc(ev.who.join(" & "))}</span></div>`;
      }).join("");
    }
    const m = (this._miles || []).find((ev) => ev.end > today);
    if (m) {
      const yr = (m.desc.match(/\b(19|20)\d{2}\b/) || [])[0];
      const age = yr ? m.start.getFullYear() - parseInt(yr, 10) : null;
      const isBday = /birthday/i.test(m.title);
      const who = m.title.replace(/['’]s\s+birthday/i, "").replace(/\s*birthday\s*/i, "").trim();
      const when = ymd(m.start) === ymd(today) ? "today" : ymd(m.start) === ymd(new Date(today.getTime() + 86400000)) ? "tomorrow" : `on ${DAYS[m.start.getDay()]}, ${MON3[m.start.getMonth()]} ${m.start.getDate()}`;
      const text = isBday && age != null ? `${who} turns ${age} ${when}.` : age != null ? `${m.title}: ${age} years ${when}.` : `${m.title} ${when}.`;
      body += `<div class="mile" data-entity="${esc(m.entity)}"><span class="mk">MILESTONES</span><span class="mt">${esc(text)}</span></div>`;
    }
    const footer = c.footer || this._copy("calendar_footer", FALLBACK.calendar_footer).replace("{n}", c.calendars.length);
    const right = c.days === 2 ? "TODAY & TOMORROW" : `NEXT ${c.days} DAYS`;
    return { sig: body + footer, html: this._shell("COMMUNITY CALENDAR", right, body, footer) };
  }

  // ---------- mode: help_wanted ----------
  _helpWanted() {
    const c = this._cfg, st = this._hass.states, today = ymd(new Date());
    const dueE = st[c.due_entity];
    const due = dueE && Array.isArray(dueE.attributes.due_list) ? dueE.attributes.due_list : [];
    const groups = new Map(); let idx = 0;
    for (const ch of c.chores) {
      const turn = (st[ch.turn_entity] || {}).state, lastRaw = (st[ch.last_entity] || {}).state || "";
      const m = /^(.*?)\|(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(lastRaw);
      const open = due.includes(ch.key);
      const filled = !open && !!m && m[2] === today;
      if (!open && !filled) continue;
      const who = open ? (bad(turn) ? "Open" : turn) : (m[1] || (bad(turn) ? "Unknown" : turn));
      const at = filled ? clock(new Date(`${m[2]}T${m[3]}:${m[4]}:00`)) : "";
      if (!groups.has(who)) groups.set(who, []);
      groups.get(who).push({ ch, open, at, i: idx++ });
    }
    let body = "";
    if (!groups.size) body = `<div class="empty">${esc(this._copy("help_wanted_empty", FALLBACK.help_wanted_empty))}</div>`;
    for (const who of [...groups.keys()].sort()) {
      const ads = groups.get(who), nOpen = ads.filter((a) => a.open).length;
      body += `<div class="sub"><span class="subn">${esc(who)}</span><span class="subr">${nOpen} OPEN · ${ads.length - nOpen} FILLED</span></div>`;
      body += ads.map((a) => `<div class="ad${a.open ? "" : " done"}" data-entity="${esc(a.ch.turn_entity)}">
        <span class="lead">${esc(a.ch.lead)}</span> ${esc(this._copy("ad_" + a.ch.key, a.ch.ad))}
        <div class="meta">${a.open ? `<span class="open">Open</span> · Applications close ${esc(c.close_time)}` : `Filled ${esc(a.at)}`}</div>${a.open ? "" : strike(a.i)}</div>`).join("");
    }
    const footer = c.footer || this._copy("help_wanted_footer", FALLBACK.help_wanted_footer);
    return { sig: body + footer, html: this._shell("HELP WANTED", "APPLY WITHIN", body, footer) };
  }

  // ---------- mode: notices ----------
  async _maybeFetchTodos() {
    const stamp = this._cfg.todo_lists.map((l) => (this._hass.states[l] || {}).last_updated).join("|");
    if (this._todoFetching || (stamp === this._todoStamp && Date.now() - this._todoAt < 300000)) return;
    this._todoFetching = true;
    try {
      const all = [];
      for (const l of this._cfg.todo_lists) {
        try {
          const r = await this._hass.callWS({ type: "todo/item/list", entity_id: l });
          const name = ((this._hass.states[l] || {}).attributes || {}).friendly_name || l;
          (r.items || []).filter((it) => it.status === "needs_action").forEach((it) => all.push({ title: it.summary || "", list: name, entity: l, due: it.due || "" }));
        } catch (e) { /* that list stays as it was */ }
      }
      this._todos = all; this._todoStamp = stamp; this._todoAt = Date.now();
      this._sig = null; this._render();
    } finally { this._todoFetching = false; }
  }
  _notices() {
    const c = this._cfg, st = this._hass.states, today = ymd(new Date()), now = new Date();
    const items = [], forth = new Map();
    if (c.maintenance) for (const [id, s] of Object.entries(st)) {
      if (!id.startsWith("sensor.")) continue;
      const a = s.attributes || {};
      if (a.maintenance_type === undefined || !a.parent_object) continue;
      const obj = a.parent_object, days = a.days_until_due;
      let task = a.friendly_name || id;
      if (task.startsWith(obj)) task = task.slice(obj.length).trim();
      task = (task.replace(/^[-–:·\s]+/, "") || a.friendly_name || id).toLowerCase();
      const rank = { overdue: 0, triggered: 1, due_soon: 2 }[s.state];
      if (a.last_performed === today) {
        items.push({ kind: "done", entity: id, rank: 3, days: 0, text: `that ${task} of the ${obj} was performed this day.`, meta: `Performed today · ${obj}`, cls: "" });
      } else if (rank !== undefined) {
        let clause, lead, cls = "due";
        if (s.state === "triggered") { clause = "falls due, the sensor having borne witness"; lead = "Triggered"; }
        else if (s.state === "overdue" || (typeof days === "number" && days < 0)) { const n = Math.abs(days || 0); clause = n ? `stands ${n} day${n === 1 ? "" : "s"} in arrears` : "stands in arrears"; lead = n ? `${n} days overdue` : "Overdue"; cls = "late"; }
        else if (days === 0) { clause = `falls due this day, the ${ordinal(now.getDate())} of ${MONTHS[now.getMonth()]}`; lead = "Due today"; }
        else if (days === 1) { clause = "falls due tomorrow"; lead = "Due tomorrow"; }
        else { const d = a.next_due ? new Date(a.next_due + "T12:00:00") : null; clause = d ? `falls due on the ${DAYS[d.getDay()]} next` : `falls due in ${days} days`; lead = `${days} days`; cls = ""; }
        items.push({ kind: "due", entity: id, rank, days: typeof days === "number" ? days : 999, text: `that ${task} of the ${obj} ${clause}.`, meta: `${lead} · ${obj}`, cls });
      } else if (typeof days === "number" && days > 0 && days <= c.forthcoming_days && a.next_due) {
        const d = new Date(a.next_due + "T12:00:00"), k = DAYS[d.getDay()];
        if (!forth.has(k)) forth.set(k, { d, list: [] });
        forth.get(k).list.push(task);
      }
    }
    items.sort((x, y) => x.rank - y.rank || x.days - y.days);
    const flags = Object.entries(st).filter(([id, s]) => id.startsWith(c.flags_prefix) && s.state === "on")
      .map(([id, s]) => ({ entity: id, text: `by order of the house: ${((s.attributes || {}).friendly_name || id).replace(/^maint:\s*/i, "").toLowerCase()}.`, meta: "Standing order" }));
    const nDue = items.filter((i) => i.kind === "due").length, nDone = items.length - nDue;
    let idx = 0, body = `<div class="sub"><span class="subn">Maintenance</span><span class="subr">${nDue} DUE · ${nDone} PERFORMED</span></div>`;
    if (!items.length && !flags.length) body += `<div class="empty">${esc(this._copy("notices_empty", FALLBACK.notices_empty))}</div>`;
    const metaHtml = (it) => it.cls ? `<span class="${it.cls}">${esc(it.meta.split(" · ")[0])}</span> · ${esc(it.meta.split(" · ")[1] || "")}` : esc(it.meta);
    body += items.map((it) => `<div class="nt${it.kind === "done" ? " done" : ""}" data-entity="${esc(it.entity)}"><span class="lead">Notice is hereby given</span> ${esc(it.text)}<div class="meta">${metaHtml(it)}</div>${it.kind === "done" ? strike(idx++) : ""}</div>`).join("");
    body += flags.map((f) => `<div class="nt" data-entity="${esc(f.entity)}"><span class="lead">Notice is hereby given</span> ${esc(f.text)}<div class="meta">${esc(f.meta)}</div></div>`).join("");
    if (c.todo_lists.length) {
      body += `<div class="sub"><span class="subn">Wanted</span><span class="subr">${this._todos.length} STANDING</span></div>`;
      body += this._todos.length ? this._todos.map((t) => {
        const w = t.title.split(" "); const lead = w.slice(0, 2).join(" "), rest = w.slice(2).join(" ");
        return `<div class="nt" data-entity="${esc(t.entity)}"><span class="lead">${esc(lead)}</span> ${esc(rest)}<div class="meta">${esc(t.list)}${t.due ? " · by " + esc(t.due) : ""}</div></div>`;
      }).join("") : `<div class="empty">${esc(this._copy("wanted_empty", FALLBACK.wanted_empty))}</div>`;
    }
    if (forth.size) {
      const parts = [...forth.values()].sort((a, b) => a.d - b.d).map((g) => `${DAYS[g.d.getDay()]}: ${g.list.join(", ")}`);
      body += `<div class="forth"><span class="fk">FORTHCOMING</span><span class="ft">${esc(parts.join("; ") + ".")}</span></div>`;
    }
    const corr = c.correction ? this._copy("correction", "") : "";
    if (corr) body += `<div class="corr"><b>CORRECTION</b> — ${esc(corr)}</div>`;
    const footer = c.footer || this._copy("notices_footer", FALLBACK.notices_footer);
    const doy = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
    return { sig: body + footer, html: this._shell("PUBLIC NOTICES", `Nº ${doy}`, body, footer) };
  }

  // ---------- styles (almanac tokens) ----------
  _css() {
    const c = this._cfg;
    return `
  :host { display: block; }
  * { box-sizing: border-box; }
  .wrap { container-type: inline-size; position: relative; }
  .wrap::before { content: ""; position: absolute; top: 0; bottom: 0; left: calc(-1 * var(--almanac-gutter, 16px)); width: 1px; background: ${c.column_rule ? "var(--almanac-column-rule, #2b2118)" : "transparent"}; }
  .card { --px: max(0.5px, 0.1923cqw); background: var(--almanac-paper, ${PAPER}); color: ${INK};
    border-radius: var(--ha-card-border-radius, 14px); box-shadow: var(--ha-card-box-shadow, 0 4px 16px rgba(0,0,0,.18));
    overflow: hidden; font-family: Archivo, 'Segoe UI', sans-serif; padding: calc(22*var(--px)) calc(32*var(--px)) calc(20*var(--px)); }
  .sect { display: flex; justify-content: space-between; align-items: baseline; font-size: max(8px, calc(10*var(--px))); font-weight: 700; letter-spacing: calc(3*var(--px)); color: ${TAN}; border-bottom: 1.5px solid ${INK}; padding-bottom: calc(5*var(--px)); }
  .sectr { letter-spacing: calc(1*var(--px)); }
  .day { display: flex; align-items: baseline; gap: calc(10*var(--px)); margin-top: calc(14*var(--px)); padding-bottom: calc(4*var(--px)); border-bottom: 1px solid ${INK}; }
  .dn { font-family: Fraunces, Georgia, serif; font-size: max(11px, calc(15*var(--px))); font-weight: 700; }
  .dd { font-size: max(7px, calc(9*var(--px))); font-weight: 700; letter-spacing: calc(2*var(--px)); color: ${TAN}; }
  .row { display: grid; grid-template-columns: calc(64*var(--px)) minmax(0, 1fr) auto; column-gap: calc(10*var(--px)); align-items: baseline; padding: calc(7*var(--px)) 0; border-bottom: 1px dotted ${DOT}; cursor: pointer; }
  .row:last-child { border-bottom: none; }
  .t { font-size: max(8px, calc(10.5*var(--px))); font-weight: 700; letter-spacing: .5px; color: ${BROWN}; text-transform: uppercase; white-space: nowrap; }
  .ti { font-family: Fraunces, Georgia, serif; font-size: max(10px, calc(13.5*var(--px))); font-weight: 600; }
  .loc { font-family: Fraunces, Georgia, serif; font-style: italic; font-size: max(8px, calc(10.5*var(--px))); color: ${BROWN}; margin-top: 1px; }
  .by { font-size: max(7px, calc(9*var(--px))); font-weight: 700; letter-spacing: calc(1.5*var(--px)); color: ${TAN}; text-transform: uppercase; white-space: nowrap; }
  .past { opacity: .42; }
  .now { display: inline-block; vertical-align: 1px; font-family: Archivo, sans-serif; font-size: max(7px, calc(8*var(--px))); font-weight: 700; letter-spacing: 1.5px; color: ${PAPER}; background: ${TERRA}; padding: 2px 5px; margin-left: 6px; }
  .empty { font-family: Fraunces, Georgia, serif; font-style: italic; font-size: max(10px, calc(12.5*var(--px))); color: ${BROWN}; padding: calc(10*var(--px)) 0 calc(8*var(--px)); }
  .mile, .forth { display: flex; align-items: baseline; gap: 8px; margin-top: calc(14*var(--px)); padding-top: calc(8*var(--px)); border-top: 1.5px solid ${INK}; }
  .mile { cursor: pointer; }
  .mk, .fk { font-size: max(7px, calc(9*var(--px))); font-weight: 700; letter-spacing: 2px; color: ${TAN}; white-space: nowrap; }
  .mt, .ft { font-family: Fraunces, Georgia, serif; font-size: max(10px, calc(12.5*var(--px))); }
  .sub { display: flex; justify-content: space-between; align-items: baseline; margin-top: calc(14*var(--px)); padding-bottom: 3px; border-bottom: 1px solid ${INK}; }
  .subn { font-family: Fraunces, Georgia, serif; font-size: max(10px, calc(12.5*var(--px))); font-weight: 700; letter-spacing: 1px; text-transform: uppercase; }
  .subr { font-size: max(7px, calc(9*var(--px))); font-weight: 700; letter-spacing: 1.5px; color: ${TAN}; }
  .ad, .nt { position: relative; padding: calc(7*var(--px)) 0 calc(6*var(--px)); border-bottom: 1px dotted ${DOT}; font-family: Fraunces, Georgia, serif; font-size: max(10px, calc(12.5*var(--px))); line-height: 1.35; cursor: pointer; }
  .lead { font-weight: 700; text-transform: uppercase; letter-spacing: .3px; }
  .meta { font-family: Archivo, sans-serif; font-size: max(7px, calc(9*var(--px))); font-weight: 700; letter-spacing: 1.5px; color: ${TAN}; text-transform: uppercase; margin-top: 3px; }
  .meta .open, .meta .due { color: ${TERRA}; }
  .meta .late { color: ${RED}; }
  .done { color: ${BROWN}; }
  .strike { position: absolute; left: -4px; top: 3px; width: calc(100% + 8px); height: calc(100% - 24px); pointer-events: none; mix-blend-mode: multiply; }
  .strike path { fill: none; stroke: ${GRAPHITE}; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; opacity: .78; }
  .corr { margin-top: calc(10*var(--px)); font-family: Fraunces, Georgia, serif; font-style: italic; font-size: max(8px, calc(10.5*var(--px))); color: ${BROWN}; line-height: 1.4; }
  .corr b { font-style: normal; font-weight: 700; letter-spacing: .3px; }
  .foot { font-size: max(7px, calc(9*var(--px))); letter-spacing: .3px; color: ${TAN}; margin-top: calc(12*var(--px)); line-height: 1.5; }`;
  }
}

if (!document.getElementById("hcc-font")) {
  const l = document.createElement("link");
  l.id = "hcc-font"; l.rel = "stylesheet";
  l.href = "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700;1,9..144,400&family=Archivo:wght@400;600;700&display=swap";
  document.head.appendChild(l);
}
customElements.define("homestead-classifieds-card", HomesteadClassifiedsCard);
console.info(`%c HOMESTEAD-CLASSIFIEDS-CARD %c ${HCC_VERSION} `, "background:#3a2d1f;color:#f3e7d3;font-weight:700", "background:#c65f38;color:#fff;font-weight:700");
window.customCards = window.customCards || [];
window.customCards.push({
  type: "homestead-classifieds-card",
  name: "Homestead Classifieds Card",
  description: "Newsprint calendar, help-wanted chores and public notices — companion to the Almanac Weather Card.",
  preview: true,
  documentationURL: "https://github.com/LoneWolf345/homestead-classifieds-card",
});
