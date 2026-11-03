/* Food Roulette — runs entirely in the browser. No server, no API keys. */
(() => {
  "use strict";

  const LABEL_LIMIT = 24;      // above this many slices, names go in the ticker instead
  const WALK_M_PER_MIN = 80;
  const REPEAT_DAYS = 7;
  const MAX_SUGGESTIONS = 8;

  // Starting points if the user doesn't share their location.
  const AREAS = [
    ["Raffles Place", 1.2840, 103.8514], ["Tanjong Pagar", 1.2765, 103.8458],
    ["Chinatown", 1.2836, 103.8443], ["Bugis", 1.3008, 103.8556],
    ["Orchard", 1.3040, 103.8318], ["Little India", 1.3066, 103.8496],
    ["Paya Lebar", 1.3180, 103.8930], ["Katong", 1.3050, 103.9050],
    ["Holland Village", 1.3112, 103.7958], ["one-north", 1.2995, 103.7872],
    ["Clementi", 1.3151, 103.7652], ["Jurong East", 1.3331, 103.7422],
    ["Bishan", 1.3508, 103.8484], ["Toa Payoh", 1.3327, 103.8474],
    ["Ang Mo Kio", 1.3696, 103.8495], ["Serangoon", 1.3500, 103.8735],
    ["Tampines", 1.3532, 103.9452], ["Punggol", 1.4051, 103.9024],
    ["Woodlands", 1.4370, 103.7865], ["Yishun", 1.4294, 103.8350],
  ];

  const TYPE_LABEL = {
    restaurant: "Restaurant", fast_food: "Fast food", cafe: "Café",
    food_court: "Hawker / food court", ice_cream: "Dessert",
  };
  const CUISINE_LABEL = {
    cn: "Chinese", ml: "Malay & Indonesian", in: "Indian", th: "Thai",
    jp: "Japanese", kr: "Korean", ws: "Western", ot: "Others",
  };

  // Short forms people type -> what OpenStreetMap spells out.
  const ABBR = {
    ave: "avenue", av: "avenue", rd: "road", st: "street", jln: "jalan", dr: "drive",
    cres: "crescent", ctrl: "central", ctr: "centre", nth: "north", sth: "south",
    upp: "upper", upr: "upper", lor: "lorong", lr: "lorong", bt: "bukit", kg: "kampong",
    tg: "tanjong", pk: "park", cl: "close", ln: "lane", pl: "place", hts: "heights",
    gdns: "gardens", gdn: "garden", sq: "square", tce: "terrace", ter: "terrace",
    wk: "walk", blvd: "boulevard", hwy: "highway", ind: "industrial", amk: "ang mo kio",
    cck: "choa chu kang", tpy: "toa payoh", hg: "hougang", bb: "bukit batok",
    bp: "bukit panjang", jw: "jurong west", je: "jurong east", sk: "sengkang",
  };

  // ---------- tiny storage helpers (storage can be blocked; never crash) ----------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
      catch { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ } },
  };

  // ---------- state ----------
  let places = [];
  let roads = null;             // loaded on demand
  let roadsPromise = null;
  let origin = null;            // {points: [[lat, lon], ...], label, kind}
  let candidates = [];
  let slices = [];
  let rotation = 0;
  let spinning = false;
  const hidden = new Set(store.get("fr_hidden", []));
  const recent = store.get("fr_recent", {}); // id -> timestamp

  // ---------- elements ----------
  const $ = (id) => document.getElementById(id);
  const canvas = $("wheel");
  const ctx = canvas.getContext("2d");
  const el = {
    locateBtn: $("locateBtn"), areaSelect: $("areaSelect"), locStatus: $("locStatus"),
    roadInput: $("roadInput"), roadList: $("roadList"), roadClear: $("roadClear"),
    radius: $("radius"), radiusLabel: $("radiusLabel"), walkLabel: $("walkLabel"),
    halal: $("halal"), veg: $("veg"), noRepeat: $("noRepeat"), mixAll: $("mixAll"),
    filterCount: $("filterCount"),
    spinBtn: $("spinBtn"), shuffleBtn: $("shuffleBtn"), count: $("count"),
    sliceCount: $("sliceCount"), ticker: $("ticker"),
    result: $("result"), rName: $("rName"), rMeta: $("rMeta"), rAddr: $("rAddr"),
    rGo: $("rGo"), rAgain: $("rAgain"), rClosed: $("rClosed"), updated: $("updated"),
  };

  // ---------- geometry ----------
  // Fast flat-earth distance; accurate to well under 1% across Singapore.
  const M_PER_DEG_LAT = 110574;
  const M_PER_DEG_LON = 111320 * Math.cos(1.35 * Math.PI / 180);
  function distanceM(lat1, lon1, lat2, lon2) {
    const dy = (lat2 - lat1) * M_PER_DEG_LAT;
    const dx = (lon2 - lon1) * M_PER_DEG_LON;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function distanceToOrigin(p) {
    let best = Infinity;
    for (const [lat, lon] of origin.points) {
      const d = distanceM(lat, lon, p.lat, p.lon);
      if (d < best) best = d;
    }
    return best;
  }
  const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
  const walkMin = (m) => Math.max(1, Math.round(m / WALK_M_PER_MIN));

  // ---------- data ----------
  async function loadData() {
    try {
      const res = await fetch("data/places.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(res.status);
      const json = await res.json();
      const idx = Object.fromEntries(json.fields.map((k, i) => [k, i]));
      const get = (r, k) => (idx[k] === undefined ? null : r[idx[k]]);
      places = json.places.map((r) => ({
        id: get(r, "id"), name: get(r, "name"), type: get(r, "type"), cuisine: get(r, "cuisine"),
        lat: get(r, "lat"), lon: get(r, "lon"), halal: get(r, "halal"), veg: get(r, "veg"),
        street: get(r, "street"), postcode: get(r, "postcode"), hours: get(r, "hours"),
        cz: get(r, "cz") ? get(r, "cz").split(",") : [],
        cr: get(r, "cr") ? get(r, "cr").split(",") : [],
        mix: !!get(r, "mix"),
      }));
      if (json.updated) el.updated.textContent = `Data updated ${json.updated}.`;
      refresh();
    } catch (e) {
      el.count.textContent = "Couldn't load the place list. Has the data refresh run yet?";
      console.error(e);
    }
  }

  function loadRoads() {
    if (!roadsPromise) {
      roadsPromise = fetch("data/roads.json", { cache: "no-cache" })
        .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then((json) => {
          roads = json.roads.map(([name, flat]) => {
            const points = [];
            for (let i = 0; i < flat.length; i += 2) points.push([flat[i], flat[i + 1]]);
            const norm = name.toLowerCase();
            return { name, norm, words: norm.split(/[\s\-/]+/), points };
          });
          return roads;
        })
        .catch((e) => { console.error(e); roads = []; roadsPromise = null; return roads; });
    }
    return roadsPromise;
  }

  // ---------- filtering ----------
  const checkedValues = (name) =>
    new Set([...document.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value));

  function refresh() {
    updateFilterBadge();
    if (!origin || !places.length) return;
    const radius = +el.radius.value;
    const types = checkedValues("type");
    const wantCz = checkedValues("cz");
    const wantCr = checkedValues("cr");
    const mixOk = el.mixAll.checked;
    const cutoff = Date.now() - REPEAT_DAYS * 864e5;
    const yes = (v) => v === "yes" || v === "only";
    const overlaps = (list, want) => list.some((x) => want.has(x));

    candidates = [];
    for (const p of places) {
      if (!types.has(p.type) || hidden.has(p.id)) continue;
      if (el.halal.checked && !yes(p.halal)) continue;
      if (el.veg.checked && !yes(p.veg)) continue;
      if (el.noRepeat.checked && recent[p.id] > cutoff) continue;
      if (wantCz.size && !(overlaps(p.cz, wantCz) || (p.mix && mixOk))) continue;
      if (wantCr.size && !(overlaps(p.cr, wantCr) || (p.mix && mixOk))) continue;
      const d = distanceToOrigin(p);
      if (d <= radius) candidates.push({ ...p, dist: d });
    }
    const where = origin.kind === "road" ? `along ${origin.label}` : `of ${origin.label}`;
    el.count.textContent = candidates.length
      ? `${candidates.length} place${candidates.length === 1 ? "" : "s"} within ${fmtDist(radius)} ${where}`
      : `Nothing found within ${fmtDist(radius)} ${where}. Try a bigger radius or fewer filters.`;
    const limit = sliceLimit();
    if (candidates.length > limit) el.count.textContent += ` · ${limit} on the wheel`;
    el.shuffleBtn.disabled = candidates.length <= limit;
    pickSlices();
  }

  const sliceLimit = () => (+el.sliceCount.value || Infinity);

  function updateFilterBadge() {
    const n = checkedValues("cz").size + checkedValues("cr").size +
      (el.halal.checked ? 1 : 0) + (el.veg.checked ? 1 : 0) +
      (checkedValues("type").size < 4 || document.querySelector('input[name="type"][value="ice_cream"]').checked ? 1 : 0);
    el.filterCount.hidden = n === 0;
    el.filterCount.textContent = n;
  }

  function pickSlices() {
    const pool = candidates.slice();
    for (let i = pool.length - 1; i > 0; i--) {           // Fisher–Yates shuffle
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    slices = pool.slice(0, sliceLimit());
    el.spinBtn.disabled = slices.length === 0;
    el.ticker.textContent = "";
    drawWheel();
  }

  // ---------- wheel drawing ----------
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const size = canvas.clientWidth || 360;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    drawWheel();
  }

  function truncate(text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
    return t.trimEnd() + "…";
  }

  function drawWheel() {
    const W = canvas.width, r = W / 2;
    ctx.clearRect(0, 0, W, W);
    const colors = [cssVar("--s1"), cssVar("--s2"), cssVar("--s3"), cssVar("--s4")];
    // pick dark or light text per slice from the slice colour's brightness
    const darkInk = colors.map((hex) => {
      const m = hex.replace("#", "").match(/../g) || ["0", "0", "0"];
      const [R, G, B] = m.map((x) => parseInt(x, 16) / 255);
      return 0.2126 * R + 0.7152 * G + 0.0722 * B > 0.55;
    });
    const surface = cssVar("--surface");

    if (!slices.length) {
      ctx.fillStyle = cssVar("--line");
      ctx.beginPath(); ctx.arc(r, r, r, 0, Math.PI * 2); ctx.fill();
      return;
    }

    const n = slices.length;
    const arc = (Math.PI * 2) / n;
    ctx.save();
    ctx.translate(r, r);
    ctx.rotate(rotation);

    for (let i = 0; i < n; i++) {
      // with an odd count, avoid the last slice matching the first
      let c = i % colors.length;
      if (i === n - 1 && n > 1 && c === 0) c = 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r, i * arc, (i + 1) * arc);
      ctx.closePath();
      ctx.fillStyle = colors[c];
      ctx.fill();
      if (n <= 90) {                      // dividers vanish into mush beyond this
        ctx.strokeStyle = surface;
        ctx.lineWidth = Math.max(1, W / (n > 30 ? 400 : 180));
        ctx.stroke();
      }

      if (n > LABEL_LIMIT) continue;      // too thin for text; the ticker shows names
      ctx.save();
      ctx.rotate((i + 0.5) * arc);
      ctx.fillStyle = darkInk[c] ? cssVar("--slice-ink-dark") : cssVar("--slice-ink-light");
      const fontPx = Math.round(W * (n > 16 ? 0.028 : n > 8 ? 0.036 : 0.042));
      ctx.font = `600 ${fontPx}px Inter, system-ui, sans-serif`;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(truncate(slices[i].name, r * 0.6), r * 0.92, 0);
      ctx.restore();
    }
    ctx.restore();

    // outer ring
    ctx.beginPath();
    ctx.arc(r, r, r - ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.strokeStyle = surface;
    ctx.lineWidth = Math.max(4, W / 70);
    ctx.stroke();
  }

  // ---------- spinning ----------
  function spin() {
    if (spinning || !slices.length) return;
    spinning = true;
    el.spinBtn.disabled = true;
    el.result.hidden = true;

    const n = slices.length;
    const arc = (Math.PI * 2) / n;
    const winner = Math.floor(Math.random() * n);
    const jitter = (Math.random() - 0.5) * arc * 0.7;
    // pointer is at the top (-90°); land the winner's centre there
    const target = -Math.PI / 2 - (winner + 0.5) * arc + jitter;
    const TAU = Math.PI * 2;
    const delta = (((target - rotation) % TAU) + TAU) % TAU;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const turns = reduce ? 1 : 5 + Math.floor(Math.random() * 3);
    const start = rotation;
    const end = rotation + turns * TAU + delta;
    const duration = reduce ? 600 : 4200;
    const t0 = performance.now();

    const ease = (t) => 1 - Math.pow(1 - t, 4); // fast start, slow finish

    function frame(now) {
      const t = Math.min(1, (now - t0) / duration);
      rotation = start + (end - start) * ease(t);
      drawWheel();
      // show the name currently under the pointer
      const under = Math.floor((((-Math.PI / 2 - rotation) % TAU) + TAU) % TAU / arc) % n;
      if (el.ticker.textContent !== slices[under].name) el.ticker.textContent = slices[under].name;
      if (t < 1) requestAnimationFrame(frame);
      else {
        rotation = end % TAU;
        spinning = false;
        el.spinBtn.disabled = false;
        if (navigator.vibrate) { try { navigator.vibrate(30); } catch { /* ignore */ } }
        showResult(slices[winner]);
      }
    }
    requestAnimationFrame(frame);
  }

  // ---------- result ----------
  function mapsUrl(p) {
    const q = [p.name, p.street, p.postcode, "Singapore"].filter(Boolean).join(" ");
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  }

  let current = null;
  function showResult(p) {
    current = p;
    el.rName.textContent = p.name;
    const bits = [TYPE_LABEL[p.type] || "Food"];
    if (p.mix) bits.push("Many stalls");
    else if (p.cz.length) bits.push(p.cz.map((c) => CUISINE_LABEL[c]).join(", "));
    else if (p.cuisine) bits.push(p.cuisine);
    const away = origin.kind === "road" ? "from the road" : "away";
    bits.push(`${fmtDist(p.dist)} ${away} · ~${walkMin(p.dist)} min walk`);
    el.rMeta.textContent = bits.join(" · ");
    const addr = [p.street, p.postcode && `S(${p.postcode})`].filter(Boolean).join(" ");
    el.rAddr.textContent = [addr, p.hours && `Hours (from OSM): ${p.hours}`].filter(Boolean).join(" — ");
    el.rAddr.hidden = !el.rAddr.textContent;
    el.rGo.href = mapsUrl(p);
    el.result.hidden = false;
    el.result.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  el.rGo.addEventListener("click", () => {
    if (!current) return;
    recent[current.id] = Date.now();
    const cutoff = Date.now() - REPEAT_DAYS * 864e5;   // drop old entries
    for (const k of Object.keys(recent)) if (recent[k] < cutoff) delete recent[k];
    store.set("fr_recent", recent);
  });

  el.rAgain.addEventListener("click", () => { el.result.hidden = true; spin(); });

  el.rClosed.addEventListener("click", () => {
    if (!current) return;
    hidden.add(current.id);
    store.set("fr_hidden", [...hidden]);
    el.result.hidden = true;
    refresh();
  });

  // ---------- location: areas & GPS ----------
  function setOrigin(o) {
    origin = o;
    if (o.kind !== "gps") store.set("fr_origin", { kind: o.kind, name: o.label });
    el.result.hidden = true;
    refresh();
  }

  function useArea(name) {
    const a = AREAS.find((x) => x[0] === name) || AREAS[0];
    el.areaSelect.value = a[0];
    setOrigin({ points: [[a[1], a[2]]], label: a[0], kind: "area" });
  }

  function initAreas() {
    const ph = document.createElement("option");
    ph.value = ""; ph.textContent = "Pick an area"; ph.disabled = true;
    el.areaSelect.append(ph);
    for (const [name] of AREAS) {
      const o = document.createElement("option");
      o.value = name; o.textContent = name;
      el.areaSelect.append(o);
    }
  }

  el.areaSelect.addEventListener("change", () => {
    el.locStatus.textContent = "";
    clearRoadInput();
    useArea(el.areaSelect.value);
  });

  el.locateBtn.addEventListener("click", () => {
    if (!("geolocation" in navigator)) {
      el.locStatus.textContent = "Your browser can't share location. Pick an area or type a road.";
      return;
    }
    el.locStatus.textContent = "Finding you…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        el.locStatus.textContent = "Using your current location.";
        el.areaSelect.value = "";
        clearRoadInput();
        setOrigin({ points: [[pos.coords.latitude, pos.coords.longitude]], label: "you", kind: "gps" });
      },
      () => { el.locStatus.textContent = "Couldn't get your location. Pick an area or type a road."; },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });

  // ---------- location: road search with autocomplete ----------
  let suggestions = [];
  let active = -1;

  function normalizeQuery(q) {
    return q.toLowerCase().replace(/[.,]/g, " ").split(/[\s\-/]+/).filter(Boolean)
      .flatMap((t) => (ABBR[t] || t).split(" "));
  }

  function searchRoads(q) {
    const tokens = normalizeQuery(q);
    if (!tokens.length || !roads) return [];
    const phrase = tokens.join(" ");
    const out = [];
    for (const r of roads) {
      // every typed word must be the start of some word in the road name
      if (!tokens.every((t) => r.words.some((w) => w.startsWith(t)))) continue;
      const score = (r.norm.startsWith(phrase) ? 0 : r.norm.includes(phrase) ? 1 : 2) * 1000 + r.name.length;
      out.push([score, r]);
    }
    out.sort((a, b) => a[0] - b[0]);
    return out.slice(0, MAX_SUGGESTIONS).map((x) => x[1]);
  }

  function highlight(name, tokens) {
    // bold the typed word-starts; build with DOM nodes (no innerHTML)
    const frag = document.createDocumentFragment();
    const parts = name.split(/(\s+)/);
    for (const part of parts) {
      const lower = part.toLowerCase();
      const t = tokens.find((tok) => tok && lower.startsWith(tok));
      if (t) {
        const m = document.createElement("mark");
        m.textContent = part.slice(0, t.length);
        frag.append(m, part.slice(t.length));
      } else frag.append(part);
    }
    return frag;
  }

  function renderSuggestions() {
    const q = el.roadInput.value.trim();
    el.roadList.replaceChildren();
    active = -1;
    el.roadInput.removeAttribute("aria-activedescendant");
    if (!q) { closeList(); return; }
    if (!roads) {
      const li = document.createElement("li");
      li.className = "empty"; li.textContent = "Loading road names…";
      el.roadList.append(li);
      openList();
      loadRoads().then(() => { if (el.roadInput.value.trim() === q) renderSuggestions(); });
      return;
    }
    suggestions = searchRoads(q);
    const tokens = normalizeQuery(q);
    if (!suggestions.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = roads.length ? "No matching road" : "Road list unavailable right now";
      el.roadList.append(li);
    }
    suggestions.forEach((r, i) => {
      const li = document.createElement("li");
      li.id = `road-opt-${i}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");
      li.append(highlight(r.name, tokens));
      // pointerdown fires before the input loses focus
      li.addEventListener("pointerdown", (e) => { e.preventDefault(); chooseRoad(r); });
      el.roadList.append(li);
    });
    openList();
  }

  function openList() { el.roadList.hidden = false; el.roadInput.setAttribute("aria-expanded", "true"); }
  function closeList() { el.roadList.hidden = true; el.roadInput.setAttribute("aria-expanded", "false"); }

  function setActive(i) {
    const items = el.roadList.querySelectorAll('[role="option"]');
    if (!items.length) return;
    active = (i + items.length) % items.length;
    items.forEach((li, j) => li.setAttribute("aria-selected", String(j === active)));
    el.roadInput.setAttribute("aria-activedescendant", items[active].id);
    items[active].scrollIntoView({ block: "nearest" });
  }

  function chooseRoad(r) {
    el.roadInput.value = r.name;
    el.roadClear.hidden = false;
    closeList();
    el.roadInput.blur();
    el.areaSelect.value = "";
    el.locStatus.textContent = `Searching along ${r.name}.`;
    setOrigin({ points: r.points, label: r.name, kind: "road" });
  }

  function clearRoadInput() {
    el.roadInput.value = "";
    el.roadClear.hidden = true;
    closeList();
  }

  el.roadInput.addEventListener("focus", () => { loadRoads(); if (el.roadInput.value) renderSuggestions(); });
  el.roadInput.addEventListener("input", () => {
    el.roadClear.hidden = !el.roadInput.value;
    renderSuggestions();
  });
  el.roadInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (el.roadList.hidden) renderSuggestions(); setActive(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const pick = suggestions[active >= 0 ? active : 0];
      if (pick && !el.roadList.hidden) chooseRoad(pick);
    } else if (e.key === "Escape") closeList();
  });
  el.roadInput.addEventListener("blur", () => setTimeout(closeList, 100));
  el.roadClear.addEventListener("click", () => {
    clearRoadInput();
    el.locStatus.textContent = "";
    el.roadInput.focus();
  });

  // ---------- filters ----------
  function updateRadiusLabel() {
    const m = +el.radius.value;
    el.radiusLabel.textContent = fmtDist(m);
    el.walkLabel.textContent = `(~${walkMin(m)} min walk)`;
  }
  el.radius.addEventListener("input", () => { updateRadiusLabel(); refresh(); });
  document.querySelectorAll(".filters input").forEach((i) => i.addEventListener("change", refresh));

  el.sliceCount.value = String(store.get("fr_slices", 10));
  if (!el.sliceCount.value) el.sliceCount.value = "10";
  el.sliceCount.addEventListener("change", () => {
    store.set("fr_slices", +el.sliceCount.value);
    el.result.hidden = true;
    refresh();
  });

  el.spinBtn.addEventListener("click", spin);
  el.shuffleBtn.addEventListener("click", () => { el.result.hidden = true; pickSlices(); });

  window.addEventListener("resize", sizeCanvas);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", drawWheel);

  // ---------- go ----------
  initAreas();
  updateRadiusLabel();
  sizeCanvas();

  const saved = store.get("fr_origin", null);
  if (saved && saved.kind === "road") {
    // restore last road once the road list arrives; fall back to the default area
    useArea(AREAS[0][0]);
    loadRoads().then(() => {
      const r = roads.find((x) => x.name === saved.name);
      if (r) chooseRoad(r);
    });
  } else {
    useArea(saved && saved.name);
  }
  loadData();
})();
