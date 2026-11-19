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
    food_court: "Hawker / food court", ice_cream: "Dessert", stall: "Hawker stall",
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
  let places = [];               // base list on the wheel: Singapore data, or live OpenStreetMap elsewhere
  let sgPlaces = [];             // prebuilt Singapore data (data/places.json)
  let sgLoading = false;
  let country = store.get("fr_country", "SG");   // "" = any country
  const isSG = () => country === "SG";
  const SG_BOX = [1.15, 1.48, 103.59, 104.1];    // lat min/max, lon min/max
  const inSG = (lat, lon) => lat >= SG_BOX[0] && lat <= SG_BOX[1] && lon >= SG_BOX[2] && lon <= SG_BOX[3];
  const allGoogle = new Map();   // every Google place fetched this visit
  const osmById = new Map();     // live OpenStreetMap places fetched this visit (outside Singapore)
  const osmCache = new Map();    // areas already fetched from OpenStreetMap
  let liveLoading = 0;           // live lookups in progress
  let roads = null;             // loaded on demand
  let roadsPromise = null;
  let markDataReady;
  const dataReady = new Promise((r) => { markDataReady = r; });
  let googleExtra = [];             // Google places not already in our data (this session only)
  const googleUri = new Map();      // our place id -> Google Maps link, when Google knows it too
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
    locateBtn: $("locateBtn"), areaSelect: $("areaSelect"), locStatus: $("locStatus"), countrySelect: $("countrySelect"),
    roadInput: $("roadInput"), roadList: $("roadList"), roadClear: $("roadClear"),
    radius: $("radius"), radiusLabel: $("radiusLabel"), walkLabel: $("walkLabel"),
    halal: $("halal"), veg: $("veg"), noRepeat: $("noRepeat"), mixAll: $("mixAll"),
    filterCount: $("filterCount"),
    spinBtn: $("spinBtn"), shuffleBtn: $("shuffleBtn"), count: $("count"),
    sliceCount: $("sliceCount"), ticker: $("ticker"),
    result: $("result"), rName: $("rName"), rMeta: $("rMeta"), rAddr: $("rAddr"),
    rGo: $("rGo"), rFeat: $("rFeat"), rGoogle: $("rGoogle"), gNote: $("gNote"), rAgain: $("rAgain"), rClosed: $("rClosed"), updated: $("updated"),
  };

  // ---------- geometry ----------
  // Fast flat-earth distance; accurate to well under 1% over a few km, anywhere.
  const M_PER_DEG_LAT = 110574;
  function distanceM(lat1, lon1, lat2, lon2) {
    const dy = (lat2 - lat1) * M_PER_DEG_LAT;
    const dx = (lon2 - lon1) * 111320 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
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
    if (sgLoading) return;
    sgLoading = true;
    try {
      const res = await fetch("data/places.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(res.status);
      const json = await res.json();
      const idx = Object.fromEntries(json.fields.map((k, i) => [k, i]));
      const get = (r, k) => (idx[k] === undefined ? null : r[idx[k]]);
      sgPlaces = json.places.map((r) => ({
        id: get(r, "id"), name: get(r, "name"), type: get(r, "type"), cuisine: get(r, "cuisine"),
        lat: get(r, "lat"), lon: get(r, "lon"), halal: get(r, "halal"), veg: get(r, "veg"),
        street: get(r, "street"), postcode: get(r, "postcode"), hours: get(r, "hours"),
        cz: get(r, "cz") ? get(r, "cz").split(",") : [],
        cr: get(r, "cr") ? get(r, "cr").split(",") : [],
        mix: !!get(r, "mix"),
        addr: get(r, "addr"), stalls: get(r, "stalls"), f: get(r, "f") || [],
      }));
      if (json.updated) el.updated.textContent = `Data updated ${json.updated}.`;
      if (isSG()) { places = sgPlaces; mergeGoogle(); }
    } catch (e) {
      el.count.textContent = "Couldn't load the place list. Has the data refresh run yet?";
      console.error(e);
    }
    markDataReady();
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
    if (!origin || (isSG() && !sgPlaces.length)) return;
    const radius = +el.radius.value;
    const types = checkedValues("type");
    const wantCz = checkedValues("cz");
    const wantCr = checkedValues("cr");
    const mixOk = el.mixAll.checked;
    const cutoff = Date.now() - REPEAT_DAYS * 864e5;
    const yes = (v) => v === "yes" || v === "only";
    const overlaps = (list, want) => list.some((x) => want.has(x));

    const wantSrc = checkedValues("src");
    const srcCount = { osm: 0, nea: 0, google: 0, list: 0 };

    candidates = [];
    for (const p of googleExtra.length ? places.concat(googleExtra) : places) {
      // individual hawker stalls fall under the "Hawker & food courts" checkbox
      if (!types.has(p.type === "stall" ? "food_court" : p.type) || hidden.has(p.id)) continue;
      if (el.halal.checked && !yes(p.halal)) continue;
      if (el.veg.checked && !yes(p.veg)) continue;
      if (el.noRepeat.checked && recent[p.id] > cutoff) continue;
      if (wantCz.size && !(overlaps(p.cz, wantCz) || (p.mix && mixOk))) continue;
      if (wantCr.size && !(overlaps(p.cr, wantCr) || (p.mix && mixOk))) continue;
      const d = distanceToOrigin(p);
      if (d > radius) continue;
      const src = srcOf(p);
      srcCount[src]++;                      // counted even when that source is switched off
      if (wantSrc.has(src)) candidates.push({ ...p, dist: d });
    }
    for (const [k, n] of Object.entries(srcCount)) {
      const span = document.querySelector(`[data-src-count="${k}"]`);
      if (span) span.textContent = `(${n})`;
    }
    const where = origin.kind === "road" ? `along ${origin.label}` : `of ${origin.label}`;
    el.count.textContent = candidates.length
      ? `${candidates.length} place${candidates.length === 1 ? "" : "s"} within ${fmtDist(radius)} ${where}`
      : liveLoading ? "Loading places…"
      : `Nothing found within ${fmtDist(radius)} ${where}. Try a bigger radius or fewer filters.`;
    if (candidates.length && liveLoading) el.count.textContent += " · loading more…";
    const limit = sliceLimit();
    if (candidates.length > limit) el.count.textContent += ` · ${limit} on the wheel`;
    el.shuffleBtn.disabled = candidates.length <= limit;
    pickSlices();
  }

  const sliceLimit = () => (+el.sliceCount.value || Infinity);

  // Where a place came from, from its id: g: Google, h NEA (added), b your lists, else OpenStreetMap.
  // (NEA centres that matched an OpenStreetMap place keep the OpenStreetMap id.)
  function srcOf(p) {
    const id = String(p.id);
    if (id.startsWith("g:")) return "google";
    if (id[0] === "h") return "nea";
    if (id[0] === "b") return "list";
    return "osm";
  }

  function updateFilterBadge() {
    const n = checkedValues("cz").size + checkedValues("cr").size +
      (el.halal.checked ? 1 : 0) + (el.veg.checked ? 1 : 0) +
      (checkedValues("type").size < 4 || document.querySelector('input[name="type"][value="ice_cream"]').checked ? 1 : 0) +
      (checkedValues("src").size < 4 ? 1 : 0);
    el.filterCount.hidden = n === 0;
    el.filterCount.textContent = n;
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {              // Fisher–Yates shuffle
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  const fromGoogleList = (p) => p.google || googleUri.has(p.id);

  // Google's places get the wheel's slots first; other sources fill what's left.
  function pickSlices() {
    const top = shuffle(candidates.filter(fromGoogleList));
    const rest = shuffle(candidates.filter((p) => !fromGoogleList(p)));
    slices = shuffle(top.concat(rest).slice(0, sliceLimit()));
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
    const exact = p.uri || googleUri.get(p.id);   // Google's own link for this exact place
    if (exact) return exact;
    const area = isSG() ? "Singapore" : (origin && origin.context) || "";
    const where = p.addr || [p.street, p.postcode, area].filter(Boolean).join(" ") || area;
    const q = `${p.name} ${where}`;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  }

  let current = null;
  function showResult(p) {
    current = p;
    el.rName.textContent = p.name;
    const bits = [TYPE_LABEL[p.type] || "Food"];
    if (p.mix) bits.push(p.stalls ? `${p.stalls} stalls` : "Many stalls");
    else if (p.cz.length) bits.push(p.cz.map((c) => CUISINE_LABEL[c]).join(", "));
    else if (p.cuisine) bits.push(p.cuisine);
    const away = origin.kind === "road" ? "from the road" : "away";
    bits.push(`${fmtDist(p.dist)} ${away} · ~${walkMin(p.dist)} min walk`);
    el.rMeta.textContent = bits.join(" · ");
    const addr = p.addr || [p.street, p.postcode && `S(${p.postcode})`].filter(Boolean).join(" ");
    el.rAddr.textContent = [addr, p.hours && `Hours (from OSM): ${p.hours}`].filter(Boolean).join(" — ");
    el.rAddr.hidden = !el.rAddr.textContent;
    // "Featured on Eatbook (2026)" links back to the articles this place came from
    el.rFeat.replaceChildren();
    if (p.f.length) {
      el.rFeat.append("Featured on ");
      p.f.forEach(([site, url, year], i) => {
        if (i) el.rFeat.append(i === p.f.length - 1 ? " and " : ", ");
        const a = document.createElement("a");
        a.href = url; a.target = "_blank"; a.rel = "noopener";
        a.textContent = year ? `${site} (${year})` : site;
        el.rFeat.append(a);
      });
    }
    el.rFeat.hidden = !p.f.length;
    el.rGoogle.hidden = !p.google;          // Google requires attribution for its data
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

  // ---------- Google places (optional, via the capped relay) ----------
  // One search per location, kept in memory for this visit: re-spins and filter
  // changes never call Google again. If the relay says the monthly cap is reached,
  // the app simply carries on with the free data.
  const GOOGLE = ((window.FR_CONFIG || {}).googleProxy || "").replace(/\/$/, "");
  const googleCache = new Map();    // "lat,lon,radius" -> results
  let googleTimer = null;
  let googleCapped = false;
  let rules = null;                 // cuisine keyword rules from data/classify.json

  const G_CUISINE = {
    chinese_restaurant: "cn", indonesian_restaurant: "ml", indian_restaurant: "in", thai_restaurant: "th",
    japanese_restaurant: "jp", ramen_restaurant: "jp", sushi_restaurant: "jp", korean_restaurant: "kr",
    american_restaurant: "ws", hamburger_restaurant: "ws", pizza_restaurant: "ws", italian_restaurant: "ws",
    french_restaurant: "ws", steak_house: "ws", brunch_restaurant: "ws", sandwich_shop: "ws",
    vietnamese_restaurant: "ot", mexican_restaurant: "ot", middle_eastern_restaurant: "ot",
    turkish_restaurant: "ot", lebanese_restaurant: "ot", greek_restaurant: "ot", spanish_restaurant: "ot",
    mediterranean_restaurant: "ot", brazilian_restaurant: "ot", african_restaurant: "ot",
  };
  const G_CRAVING = {
    ramen_restaurant: "n", sushi_restaurant: "r", hamburger_restaurant: "b", pizza_restaurant: "b",
    sandwich_shop: "b", bakery: "b", steak_house: "l", barbecue_restaurant: "l", seafood_restaurant: "l",
  };
  const STOP = new Set(["the", "restaurant", "stall", "cafe", "café", "kitchen", "eating", "house", "food",
    "centre", "center", "market", "and", "&", "pte", "ltd", "singapore", "sg", "@"]);

  function nameKey(n) {
    const words = (n || "").toLowerCase().match(/[a-z0-9]+/g) || [];
    const kept = words.filter((w) => !STOP.has(w));
    return new Set(kept.length ? kept : words);
  }
  function similarNames(a, b) {
    const A = nameKey(a), B = nameKey(b);
    if (!A.size || !B.size) return false;
    const inter = [...A].filter((w) => B.has(w)).length;
    if (inter === A.size || inter === B.size) return true;
    return inter / (A.size + B.size - inter) >= 0.5;
  }

  async function loadRules() {
    if (rules) return rules;
    try {
      const r = await fetch("data/classify.json", { cache: "no-cache" });
      const j = await r.json();
      const compile = (o) => Object.entries(o).map(([k, v]) => [k, new RegExp(v)]);
      rules = { cuisine: compile(j.cuisine), craving: compile(j.craving), mixed: new RegExp(j.mixed),
                cuisineTags: j.cuisineTags || {}, cravingTags: j.cravingTags || {} };
    } catch { rules = { cuisine: [], craving: [], mixed: /$^/, cuisineTags: {}, cravingTags: {} }; }
    return rules;
  }

  function fromGoogle(g) {
    const types = new Set([g.type, ...(g.types || [])]);
    const lname = g.name.toLowerCase();
    const has = (...t) => t.some((x) => types.has(x));
    const mix = has("food_court") || rules.mixed.test(lname);
    const type = has("food_court") ? "food_court"
      : has("fast_food_restaurant", "hamburger_restaurant", "sandwich_shop") ? "fast_food"
      : has("ice_cream_shop", "dessert_shop") ? "ice_cream"
      : has("cafe", "coffee_shop", "bakery", "tea_house") && !has("restaurant") ? "cafe"
      : "restaurant";
    const cz = new Set([...types].map((t) => G_CUISINE[t]).filter(Boolean));
    if (!cz.size) for (const [k, rx] of rules.cuisine) if (rx.test(lname)) cz.add(k);
    const cr = new Set([...types].map((t) => G_CRAVING[t]).filter(Boolean));
    for (const [k, rx] of rules.craving) if (rx.test(lname)) cr.add(k);
    return {
      id: "g:" + g.gid, name: g.name, type, cuisine: null, lat: g.lat, lon: g.lon,
      halal: null, veg: has("vegetarian_restaurant", "vegan_restaurant") ? "yes" : null,
      street: null, postcode: null, hours: null, addr: g.addr, stalls: null, f: [],
      cz: [...cz], cr: [...cr], mix, uri: g.uri, google: true,
    };
  }

  // Where to search: the chosen point, or the middle of the chosen road.
  function googleQuery() {
    const pts = origin.points;
    const lat = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const lon = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const extent = Math.max(...pts.map((p) => distanceM(lat, lon, p[0], p[1])));
    const radius = Math.min(5000, Math.round(+el.radius.value + extent));
    return { lat, lon, radius };
  }

  function scheduleGoogle() {
    if (!GOOGLE || googleCapped || !origin) return;
    if (!checkedValues("src").has("google")) return;   // switched off: don't spend calls
    clearTimeout(googleTimer);
    googleTimer = setTimeout(fetchGoogle, 700);   // wait until the slider stops moving
  }

  // ---- human check (Cloudflare Turnstile): one fresh token per Google search ----
  const TS_KEY = (window.FR_CONFIG || {}).turnstileSiteKey || "";
  let tsWidget = null, tsLoading = null;

  function loadTurnstile() {
    if (!tsLoading) {
      tsLoading = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        s.async = true;
        s.onload = () => resolve(window.turnstile);
        s.onerror = reject;
        document.head.append(s);
      });
    }
    return tsLoading;
  }

  const log = (...a) => console.info("[Food Roulette]", ...a);
  let tsVisible = false;   // after a failed silent check, show the checkbox

  // A fresh widget per Google search (tokens are single-use).
  async function humanToken() {
    if (!TS_KEY) return "";                         // check not configured
    let ts;
    try { ts = await loadTurnstile(); } catch { log("human check: Turnstile script blocked"); return null; }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (t) => { if (!settled) { settled = true; resolve(t); } };
      if (tsWidget !== null) { try { ts.remove(tsWidget); } catch { /* ignore */ } tsWidget = null; }
      tsWidget = ts.render("#captcha", {
        sitekey: TS_KEY,
        appearance: tsVisible ? "always" : "interaction-only",
        callback: (t) => { log("human check: passed"); finish(t); },
        "error-callback": (code) => { log("human check: failed, code", code); finish(null); return true; },
        "timeout-callback": () => { log("human check: timed out"); finish(null); },
      });
      setTimeout(() => { if (!settled) log("human check: no answer after 60 s"); finish(null); }, 60000);
    });
  }

  function showVerifyPrompt() {
    tsVisible = true;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn ghost small-btn";
    btn.textContent = "✅ Verify to load more places nearby";
    btn.addEventListener("click", () => { el.gNote.hidden = true; fetchGoogle(); });
    el.gNote.replaceChildren(btn);
    el.gNote.hidden = false;
  }

  async function fetchGoogle() {
    const q = googleQuery();
    // reuse an earlier search that already covers this area
    for (const [key, res] of googleCache) {
      const [la, lo, ra] = key.split(",").map(Number);
      if (distanceM(la, lo, q.lat, q.lon) + q.radius <= ra + 150) { applyGoogle(res); return; }
    }
    const key = `${q.lat.toFixed(4)},${q.lon.toFixed(4)},${q.radius}`;
    try {
      await loadRules();
      const token = await humanToken();
      if (token === null) { showVerifyPrompt(); return; }   // free data still works meanwhile
      const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
      const r = await fetch(`${GOOGLE}/nearby?lat=${q.lat.toFixed(5)}&lon=${q.lon.toFixed(5)}&radius=${q.radius}${tokenParam}`);
      const j = await r.json();
      log("relay:", j.error ? `error "${j.error}"` : `${(j.places || []).length} places`,
          j.used ? `(${j.used}/${j.cap} this month)` : "");
      if (j.error && /captcha/.test(j.error)) { showVerifyPrompt(); return; }
      if (j.capped) {
        googleCapped = true;
        el.gNote.textContent = "Extra Google places are paused until next month.";
        el.gNote.hidden = false;
        return;
      }
      const res = (j.places || []).map(fromGoogle);
      googleCache.set(key, res);
      applyGoogle(res);
    } catch (e) {
      console.warn("Google places unavailable", e);   // keep going with free data
    }
  }

  async function applyGoogle(results) {
    for (const g of results) allGoogle.set(g.id, g);
    if (isSG()) await dataReady;     // compare against the full place list, never a half-loaded one
    mergeGoogle();
  }

  // Google places that match one already in the base list just lend it their exact Maps
  // link (and count as Google's); the rest are added.
  function mergeGoogle() {
    const extra = [];
    googleUri.clear();
    for (const g of allGoogle.values()) {
      const twin = places.find((p) => Math.abs(p.lat - g.lat) < 0.001 && Math.abs(p.lon - g.lon) < 0.001 &&
        distanceM(p.lat, p.lon, g.lat, g.lon) <= 80 && similarNames(p.name, g.name));
      if (twin) googleUri.set(twin.id, g.uri);
      else extra.push(g);
    }
    googleExtra = extra;
    refresh();
  }

  // ---------- live OpenStreetMap (outside Singapore) ----------
  const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
  let osmTimer = null;

  function scheduleOsm() {
    if (isSG() || !origin || !checkedValues("src").has("osm")) return;
    clearTimeout(osmTimer);
    osmTimer = setTimeout(fetchOsm, 700);
  }

  function fromOsm(e) {
    const t = e.tags || {};
    const name = (t["name:en"] || t.name || "").trim();
    const lat = e.lat ?? (e.center && e.center.lat), lon = e.lon ?? (e.center && e.center.lon);
    if (!name || lat == null || lon == null) return null;
    const lname = name.toLowerCase();
    const vals = new Set((t.cuisine || "").toLowerCase().split(";").map((s) => s.trim().replace(/ /g, "_")).filter(Boolean));
    const byTag = (map) => Object.entries(map).filter(([, list]) => list.some((v) => vals.has(v))).map(([k]) => k);
    let cz = byTag(rules.cuisineTags);
    if (!cz.length) cz = rules.cuisine.filter(([, rx]) => rx.test(lname)).map(([k]) => k);
    const cr = [...new Set([...byTag(rules.cravingTags), ...rules.craving.filter(([, rx]) => rx.test(lname)).map(([k]) => k)])];
    return {
      id: e.type[0] + e.id, name, type: t.amenity,
      cuisine: t.cuisine ? t.cuisine.replace(/_/g, " ").replace(/;/g, ", ") : null,
      lat, lon, halal: t["diet:halal"] || null, veg: t["diet:vegetarian"] || null,
      street: t["addr:street"] || null, postcode: t["addr:postcode"] || null, hours: t.opening_hours || null,
      cz, cr, mix: t.amenity === "food_court" || rules.mixed.test(lname), addr: null, stalls: null, f: [],
    };
  }

  async function fetchOsm() {
    const q = googleQuery();
    for (const key of osmCache.keys()) {           // already loaded for this area?
      const [la, lo, ra] = key.split(",").map(Number);
      if (distanceM(la, lo, q.lat, q.lon) + q.radius <= ra + 150) return;
    }
    const key = `${q.lat.toFixed(4)},${q.lon.toFixed(4)},${q.radius}`;
    const query = `[out:json][timeout:25];nwr["amenity"~"^(restaurant|fast_food|cafe|food_court|ice_cream)$"]["name"]` +
      `(around:${q.radius},${q.lat.toFixed(5)},${q.lon.toFixed(5)});out center tags;`;
    liveLoading++; refresh();
    try {
      await loadRules();
      for (const url of OVERPASS) {
        try {
          const r = await fetch(url, { method: "POST", body: new URLSearchParams({ data: query }) });
          if (!r.ok) throw new Error(r.status);
          const j = await r.json();
          for (const e of j.elements || []) { const p = fromOsm(e); if (p) osmById.set(p.id, p); }
          osmCache.set(key, true);
          log(`OpenStreetMap: ${(j.elements || []).length} places`);
          break;
        } catch (e) { log("OpenStreetMap server busy, trying the next one", e.message || e); }
      }
    } finally { liveLoading--; }
    if (!isSG()) { places = [...osmById.values()]; mergeGoogle(); }
  }

  // ---------- location: areas & GPS ----------
  function setOrigin(o) {
    origin = o;
    if (o.kind !== "gps") {
      store.set("fr_origin", { kind: o.kind, name: o.label, lat: o.points[0][0], lon: o.points[0][1], context: o.context || "" });
    }
    el.result.hidden = true;
    refresh();
    scheduleOsm();
    scheduleGoogle();
  }

  // ---------- country ----------
  const COUNTRY_CODES = ("AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR " +
    "BS BT BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET " +
    "FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IO IQ IR " +
    "IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML " +
    "MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR " +
    "PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ TK TL " +
    "TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW").split(" ");

  function initCountries() {
    let names = null;
    try { names = new Intl.DisplayNames(["en"], { type: "region" }); } catch { /* old browser: show codes */ }
    const label = (c) => { try { return names ? names.of(c) : c; } catch { return c; } };
    const add = (value, text) => {
      const o = document.createElement("option");
      o.value = value; o.textContent = text;
      el.countrySelect.append(o);
    };
    add("SG", "Singapore");
    add("", "🌍 Any country");
    COUNTRY_CODES.filter((c) => c !== "SG").map((c) => [c, label(c)])
      .sort((a, b) => a[1].localeCompare(b[1])).forEach(([c, n]) => add(c, n));
    el.countrySelect.value = country;
    if (el.countrySelect.value !== country) { country = "SG"; el.countrySelect.value = "SG"; }
  }

  function applyModeUI() {
    el.areaSelect.hidden = !isSG();
    el.roadInput.placeholder = isSG() ? "🔎 Or type a road, e.g. Amoy St, AMK Ave 3"
      : "🔎 Search a city, area or street, e.g. Dago, Bandung";
    for (const v of ["nea", "list"]) {
      const box = document.querySelector(`input[name="src"][value="${v}"]`);
      if (box) box.closest("label").hidden = !isSG();
    }
  }

  function setCountry(cc, keepOrigin) {
    country = cc;
    store.set("fr_country", cc);
    el.countrySelect.value = cc;
    applyModeUI();
    places = isSG() ? sgPlaces : [...osmById.values()];
    if (isSG() && !sgPlaces.length) loadData();
    if (keepOrigin) { mergeGoogle(); return; }
    origin = null;
    clearRoadInput();
    el.locStatus.textContent = "";
    el.result.hidden = true;
    candidates = []; slices = [];
    el.spinBtn.disabled = true; el.shuffleBtn.disabled = true;
    drawWheel();
    if (isSG()) useArea(AREAS[0][0]);
    else el.count.textContent = "Search for a city or area above, or tap “Use my location”.";
  }

  el.countrySelect.addEventListener("change", () => setCountry(el.countrySelect.value, false));

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
        const { latitude: la, longitude: lo } = pos.coords;
        el.locStatus.textContent = "Using your current location.";
        if (inSG(la, lo) && !isSG()) setCountry("SG", true);
        else if (!inSG(la, lo) && isSG()) setCountry("", true);
        el.areaSelect.value = "";
        clearRoadInput();
        setOrigin({ points: [[la, lo]], label: "you", kind: "gps", context: "" });
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

  // Outside Singapore: Google place suggestions (cities, areas, streets, malls).
  let acTimer = null, acSession = null, acSeq = 0;
  const newSession = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/[^A-Za-z0-9-]/g, "");

  function listMessage(text) {
    el.roadList.replaceChildren();
    const li = document.createElement("li");
    li.className = "empty"; li.textContent = text;
    el.roadList.append(li);
    openList();
  }

  function renderPlaceSuggestions() {
    const q = el.roadInput.value.trim();
    active = -1;
    if (q.length < 2) { suggestions = []; closeList(); return; }
    if (!GOOGLE) { listMessage("Place search needs the Google relay (see README)."); return; }
    clearTimeout(acTimer);
    acTimer = setTimeout(async () => {
      const seq = ++acSeq;
      acSession = acSession || newSession();
      const bias = origin ? `&lat=${origin.points[0][0].toFixed(4)}&lon=${origin.points[0][1].toFixed(4)}` : "";
      try {
        const r = await fetch(`${GOOGLE}/autocomplete?q=${encodeURIComponent(q)}&cc=${country}&session=${acSession}${bias}`);
        const j = await r.json();
        if (seq !== acSeq || el.roadInput.value.trim() !== q) return;    // user kept typing
        suggestions = (j.suggestions || []).map((s) => ({ ...s, name: s.main, google: true }));
        if (!suggestions.length) { listMessage(j.error ? "Search unavailable right now" : "No matching place"); return; }
        el.roadList.replaceChildren();
        suggestions.forEach((s, i) => {
          const li = document.createElement("li");
          li.id = `road-opt-${i}`;
          li.setAttribute("role", "option");
          li.setAttribute("aria-selected", "false");
          const main = document.createElement("strong"); main.textContent = s.main;
          li.append(main);
          if (s.sub) { const sub = document.createElement("span"); sub.className = "muted"; sub.textContent = ` ${s.sub}`; li.append(sub); }
          li.addEventListener("pointerdown", (e) => { e.preventDefault(); choosePlace(s); });
          el.roadList.append(li);
        });
        openList();
      } catch { listMessage("Search unavailable right now"); }
    }, 300);
  }

  async function choosePlace(s) {
    el.roadInput.value = s.sub ? `${s.main}, ${s.sub}` : s.main;
    el.roadClear.hidden = false;
    closeList();
    el.roadInput.blur();
    el.locStatus.textContent = `Finding ${s.main}…`;
    const session = acSession || "";
    acSession = null;                                    // a pick ends the search session
    try {
      const j = await (await fetch(`${GOOGLE}/place?id=${encodeURIComponent(s.id)}&session=${session}`)).json();
      if (j.capped) { el.locStatus.textContent = "Place search is paused until next month. Use your location instead."; return; }
      if (j.lat == null) { el.locStatus.textContent = "Couldn't find that place. Try another."; return; }
      if (inSG(j.lat, j.lon) && !isSG()) setCountry("SG", true);
      el.locStatus.textContent = `Searching around ${s.main}.`;
      setOrigin({ points: [[j.lat, j.lon]], label: s.main, kind: "place", context: s.sub || j.addr || "" });
    } catch { el.locStatus.textContent = "Place search unavailable right now. Try “Use my location”."; }
  }

  const choose = (pick) => (pick.google ? choosePlace(pick) : chooseRoad(pick));

  function renderSuggestions() {
    if (!isSG()) { renderPlaceSuggestions(); return; }
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

  el.roadInput.addEventListener("focus", () => { if (isSG()) loadRoads(); if (el.roadInput.value) renderSuggestions(); });
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
      if (pick && !el.roadList.hidden) choose(pick);
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
  el.radius.addEventListener("input", () => { updateRadiusLabel(); refresh(); scheduleOsm(); scheduleGoogle(); });
  document.querySelectorAll(".filters input").forEach((i) => i.addEventListener("change", refresh));

  // remember source choices; switching Google back on fetches for the current area
  const srcBoxes = [...document.querySelectorAll('input[name="src"]')];
  const savedSrc = store.get("fr_src", null);
  if (Array.isArray(savedSrc)) srcBoxes.forEach((b) => { b.checked = savedSrc.includes(b.value); });
  if (!GOOGLE) srcBoxes.find((b) => b.value === "google").closest("label").hidden = true;
  srcBoxes.forEach((b) => b.addEventListener("change", () => {
    store.set("fr_src", srcBoxes.filter((x) => x.checked).map((x) => x.value));
    if (b.value === "google" && b.checked) scheduleGoogle();
    if (b.value === "osm" && b.checked) scheduleOsm();
  }));

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
  initCountries();
  applyModeUI();
  initAreas();
  updateRadiusLabel();
  sizeCanvas();

  const saved = store.get("fr_origin", null);
  if (!isSG()) {
    markDataReady();
    if (saved && saved.kind === "place" && Number.isFinite(saved.lat)) {
      el.roadInput.value = saved.context ? `${saved.name}, ${saved.context}` : saved.name;
      el.roadClear.hidden = false;
      setOrigin({ points: [[saved.lat, saved.lon]], label: saved.name, kind: "place", context: saved.context });
    } else {
      el.count.textContent = "Search for a city or area above, or tap “Use my location”.";
    }
  } else if (saved && saved.kind === "road") {
    // restore last road once the road list arrives; fall back to the default area
    useArea(AREAS[0][0]);
    loadRoads().then(() => {
      const r = roads.find((x) => x.name === saved.name);
      if (r) chooseRoad(r);
    });
  } else {
    useArea(saved && saved.name);
  }
  if (isSG()) loadData();
})();
