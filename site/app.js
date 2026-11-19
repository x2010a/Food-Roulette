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
  let food = "";                 // "what do you feel like" text, e.g. "dim sum"
  const textHits = new Map();    // food text -> Set of Google ids that Google says match
  const twinGids = new Map();    // base place id -> Google ids of the same place
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
    sliceCount: $("sliceCount"), ticker: $("ticker"), foodInput: $("foodInput"), foodClear: $("foodClear"),
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
      if (food && !matchesFood(p)) continue;
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
    const what = food ? `“${el.foodInput.value.trim()}” ` : "";
    el.count.textContent = candidates.length
      ? `${candidates.length} ${what}place${candidates.length === 1 ? "" : "s"} within ${fmtDist(radius)} ${where}`
      : liveLoading ? "Loading places…"
      : `No ${what}places found within ${fmtDist(radius)} ${where}. Try a bigger radius or fewer filters.`;
    const limit = sliceLimit();
    const extra = [];
    if (candidates.length > limit) extra.push(`${limit} on the wheel`);
    if (candidates.length && liveLoading) extra.push("Loading more…");
    if (food && GOOGLE && !liveLoading && !textHits.has(food) && checkedValues("src").has("google")) {
      if (candidates.length) extra.push("Press Enter to search Google for more");
      else el.count.textContent = `Press Enter to search for “${el.foodInput.value.trim()}” nearby.`;
    }
    if (candidates.length && extra.length) el.count.textContent += `. ${extra.join(". ")}.`;
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
  // Game-show wheel: gold rim with chasing bulbs, pegs between slices, glossy candy slices.
  const SLICE = [                       // [fill, label ink]
    ["#ff5d4f", "#ffffff"], ["#ffb23e", "#2b1d05"], ["#2fc9a3", "#06281f"],
    ["#4aa8ff", "#071d3a"], ["#9b7bff", "#ffffff"],
  ];
  const BULBS = 24;
  const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let bulbPhase = 0;

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

  function shade(hex, amt) {             // amt < 0 darker, > 0 lighter
    const n = parseInt(hex.slice(1), 16);
    const f = (c) => Math.max(0, Math.min(255, Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt)));
    return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }

  function sliceColor(i, n) {
    let c = i % SLICE.length;
    if (i === n - 1 && n > 1 && c === 0) c = 2;    // last slice never matches the first
    return SLICE[c];
  }

  function drawWheel() {
    const W = canvas.width, r = W / 2;
    const rimIn = r * 0.86;                // slices end here; the gold rim is outside
    ctx.clearRect(0, 0, W, W);
    ctx.save();
    ctx.translate(r, r);

    // gold rim
    const rim = ctx.createLinearGradient(0, -r, 0, r);
    rim.addColorStop(0, "#ffe9a3"); rim.addColorStop(0.45, "#ffc94a"); rim.addColorStop(1, "#b07812");
    ctx.beginPath(); ctx.arc(0, 0, r * 0.995, 0, Math.PI * 2); ctx.fillStyle = rim; ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, rimIn + r * 0.012, 0, Math.PI * 2); ctx.fillStyle = "#5a3d07"; ctx.fill();

    // bulbs around the rim
    for (let b = 0; b < BULBS; b++) {
      const a = (b / BULBS) * Math.PI * 2;
      const x = Math.cos(a) * r * 0.93, y = Math.sin(a) * r * 0.93;
      const lit = (b + bulbPhase) % 2 === 0;
      ctx.beginPath(); ctx.arc(x, y, r * 0.03, 0, Math.PI * 2);
      if (lit) {
        const g = ctx.createRadialGradient(x, y, 0, x, y, r * 0.06);
        g.addColorStop(0, "rgba(255,248,214,1)"); g.addColorStop(0.45, "rgba(255,233,160,.9)"); g.addColorStop(1, "rgba(255,201,74,0)");
        ctx.save(); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 0.06, 0, Math.PI * 2); ctx.fill(); ctx.restore();
        ctx.beginPath(); ctx.arc(x, y, r * 0.028, 0, Math.PI * 2); ctx.fillStyle = "#fffbe8";
      } else {
        ctx.fillStyle = "#8a5f12";
      }
      ctx.fill();
    }

    if (!slices.length) {
      ctx.beginPath(); ctx.arc(0, 0, rimIn, 0, Math.PI * 2); ctx.fillStyle = "#2a2152"; ctx.fill();
      ctx.restore();
      return;
    }

    const n = slices.length;
    const arc = (Math.PI * 2) / n;
    ctx.save();
    ctx.rotate(rotation);
    for (let i = 0; i < n; i++) {
      const [fill] = sliceColor(i, n);
      const g = ctx.createRadialGradient(0, 0, rimIn * 0.2, 0, 0, rimIn);
      g.addColorStop(0, shade(fill, -0.28)); g.addColorStop(0.55, fill); g.addColorStop(1, shade(fill, 0.12));
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, rimIn, i * arc, (i + 1) * arc); ctx.closePath();
      ctx.fillStyle = g; ctx.fill();
      if (n <= 90) {
        ctx.strokeStyle = "rgba(28,20,56,.55)";
        ctx.lineWidth = Math.max(1, W / (n > 30 ? 500 : 220));
        ctx.stroke();
      }
    }
    // pegs on the slice borders
    if (n <= 48) {
      for (let i = 0; i < n; i++) {
        const a = i * arc, x = Math.cos(a) * rimIn * 0.965, y = Math.sin(a) * rimIn * 0.965;
        ctx.beginPath(); ctx.arc(x, y, r * 0.018, 0, Math.PI * 2);
        ctx.fillStyle = "#fff3c9"; ctx.fill();
        ctx.lineWidth = Math.max(1, W / 500); ctx.strokeStyle = "#8a5f12"; ctx.stroke();
      }
    }
    // labels
    if (n <= LABEL_LIMIT) {
      const fontPx = Math.round(W * (n > 16 ? 0.03 : n > 8 ? 0.037 : 0.044));
      ctx.font = `600 ${fontPx}px Fredoka, Figtree, system-ui, sans-serif`;
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      for (let i = 0; i < n; i++) {
        const [, ink] = sliceColor(i, n);
        ctx.save();
        ctx.rotate((i + 0.5) * arc);
        ctx.fillStyle = ink;
        ctx.fillText(truncate(slices[i].name, rimIn * 0.56), rimIn * 0.9, 0);
        ctx.restore();
      }
    }
    ctx.restore();

    // depth and a fixed gloss highlight (doesn't spin)
    const depth = ctx.createRadialGradient(0, 0, rimIn * 0.6, 0, 0, rimIn);
    depth.addColorStop(0, "rgba(0,0,0,0)"); depth.addColorStop(1, "rgba(10,4,30,.28)");
    ctx.beginPath(); ctx.arc(0, 0, rimIn, 0, Math.PI * 2); ctx.fillStyle = depth; ctx.fill();
    const gloss = ctx.createLinearGradient(-rimIn, -rimIn, rimIn * 0.2, rimIn * 0.4);
    gloss.addColorStop(0, "rgba(255,255,255,.22)"); gloss.addColorStop(0.5, "rgba(255,255,255,0)");
    ctx.beginPath(); ctx.arc(0, 0, rimIn, 0, Math.PI * 2); ctx.fillStyle = gloss; ctx.fill();

    // hub ring behind the Spin button
    ctx.beginPath(); ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2); ctx.fillStyle = "#1c1438"; ctx.fill();
    ctx.restore();
  }

  // idle bulb chase
  setInterval(() => {
    if (spinning || reduceMotion() || document.hidden) return;
    bulbPhase++;
    drawWheel();
  }, 500);

  // ---------- sound (no files: tiny synthesized ticks and a chime) ----------
  let audio = null;
  let muted = !!store.get("fr_mute", false);
  const muteBtn = $("muteBtn");
  function syncMute() {
    muteBtn.setAttribute("aria-pressed", String(muted));
    muteBtn.setAttribute("aria-label", muted ? "Sound off" : "Sound on");
  }
  syncMute();
  muteBtn.addEventListener("click", () => { muted = !muted; store.set("fr_mute", muted); syncMute(); if (!muted) tickSound(); });

  function audioCtx() {
    if (!audio) { try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
    if (audio.state === "suspended") audio.resume();
    return audio;
  }
  function tone(freq, start, dur, type, vol, endFreq) {
    const a = audio, o = a.createOscillator(), g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, start);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, start + dur);
    g.gain.setValueAtTime(vol, start);
    g.gain.exponentialRampToValueAtTime(0.0008, start + dur);
    o.connect(g).connect(a.destination);
    o.start(start); o.stop(start + dur + 0.02);
  }
  function tickSound() {
    if (muted || !audioCtx()) return;
    tone(1700, audio.currentTime, 0.04, "triangle", 0.16, 700);
  }
  function winSound() {
    if (muted || !audioCtx()) return;
    const t0 = audio.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, t0 + i * 0.09, 0.42, "triangle", 0.2));
  }

  // ---------- confetti ----------
  const confettiCanvas = $("confetti");
  function confetti() {
    if (reduceMotion()) return;
    const c = confettiCanvas, x = c.getContext("2d"), dpr = window.devicePixelRatio || 1;
    c.width = innerWidth * dpr; c.height = innerHeight * dpr;
    const box = canvas.getBoundingClientRect();
    const ox = (box.left + box.width / 2) * dpr, oy = (box.top + box.height / 2) * dpr;
    const colors = ["#ff5d4f", "#ffb23e", "#2fc9a3", "#4aa8ff", "#9b7bff", "#ffc94a", "#ffffff"];
    const bits = Array.from({ length: 150 }, () => {
      const a = Math.random() * Math.PI * 2, v = (6 + Math.random() * 10) * dpr;
      return { x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 6 * dpr, w: (5 + Math.random() * 6) * dpr,
               h: (8 + Math.random() * 8) * dpr, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
               c: colors[(Math.random() * colors.length) | 0] };
    });
    const t0 = performance.now();
    (function step(now) {
      const k = (now - t0) / 1800;
      x.clearRect(0, 0, c.width, c.height);
      if (k >= 1) return;
      x.globalAlpha = Math.min(1, (1 - k) * 2.2);
      for (const b of bits) {
        b.vy += 0.38 * dpr; b.vx *= 0.985; b.x += b.vx; b.y += b.vy; b.r += b.vr;
        x.save(); x.translate(b.x, b.y); x.rotate(b.r); x.fillStyle = b.c; x.fillRect(-b.w / 2, -b.h / 2, b.w, b.h * Math.abs(Math.cos(b.r * 1.7))); x.restore();
      }
      requestAnimationFrame(step);
    })(t0);
  }

  // ---------- spinning ----------
  const pointerEl = $("pointer");
  function flick() {
    pointerEl.classList.remove("tick");
    void pointerEl.offsetWidth;            // restart the animation
    pointerEl.classList.add("tick");
  }

  function spin() {
    if (spinning || !slices.length) return;
    audioCtx();                            // browsers only allow sound after a tap
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
    const reduce = reduceMotion();
    let lastUnder = -1, lastTick = 0;
    const turns = reduce ? 1 : 5 + Math.floor(Math.random() * 3);
    const start = rotation;
    const end = rotation + turns * TAU + delta;
    const duration = reduce ? 600 : 4200;
    const t0 = performance.now();

    const ease = (t) => 1 - Math.pow(1 - t, 4); // fast start, slow finish

    function frame(now) {
      const t = Math.min(1, (now - t0) / duration);
      rotation = start + (end - start) * ease(t);
      if (!reduce) bulbPhase = Math.floor(now / 110);
      drawWheel();
      // show the name currently under the pointer; tick when a peg passes
      const under = Math.floor((((-Math.PI / 2 - rotation) % TAU) + TAU) % TAU / arc) % n;
      if (under !== lastUnder) {
        if (lastUnder !== -1 && now - lastTick > 40) { tickSound(); if (!reduce) flick(); lastTick = now; }
        lastUnder = under;
        el.ticker.textContent = slices[under].name;
      }
      if (t < 1) requestAnimationFrame(frame);
      else {
        rotation = end % TAU;
        spinning = false;
        el.spinBtn.disabled = false;
        if (navigator.vibrate) { try { navigator.vibrate([30, 50, 60]); } catch { /* ignore */ } }
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
    bits.push(`${fmtDist(p.dist)} ${away}`, `~${walkMin(p.dist)} min walk`);
    el.rMeta.replaceChildren(...bits.map((b) => { const s = document.createElement("span"); s.textContent = b; return s; }));
    const addr = p.addr || [p.street, isSG() && p.postcode ? `S(${p.postcode})` : p.postcode].filter(Boolean).join(" ");
    el.rAddr.textContent = [addr, p.hours && `Opening hours: ${p.hours}`].filter(Boolean).join(". ");
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
    winSound();
    confetti();
    el.rGo.focus({ preventScroll: true });
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
    twinGids.clear();
    for (const g of allGoogle.values()) {
      const twin = places.find((p) => Math.abs(p.lat - g.lat) < 0.001 && Math.abs(p.lon - g.lon) < 0.001 &&
        distanceM(p.lat, p.lon, g.lat, g.lon) <= 80 && similarNames(p.name, g.name));
      if (twin) {
        googleUri.set(twin.id, g.uri);
        twinGids.set(twin.id, (twinGids.get(twin.id) || []).concat(g.id));
      } else extra.push(g);
    }
    googleExtra = extra;
    refresh();
  }

  // ---------- "what do you feel like" food search ----------
  // Free part: names and cuisine tags that contain the words ("Dim Sum Den", cuisine=dim_sum).
  // Google part: a text search for the words within the radius (up to 3 calls, own allowance),
  // which also finds places whose names don't say it.
  const compact = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  let textTimer = null;
  const textCache = new Map();   // "food|lat,lon,radius" -> true

  function setFood(value) {
    food = compact(value);
    if (food.length > 4 && food.endsWith("s")) food = food.slice(0, -1);   // "noodles" -> "noodle"
    el.foodClear.hidden = !value;
    el.result.hidden = true;
    refresh();
  }

  function matchesFood(p) {
    if (compact(p.name).includes(food) || compact(p.cuisine).includes(food)) return true;
    const hits = textHits.get(food);
    if (!hits) return false;
    if (p.google) return hits.has(p.id);
    return (twinGids.get(p.id) || []).some((g) => hits.has(g));
  }

  function scheduleText() {
    if (!GOOGLE || !food || !origin || !checkedValues("src").has("google")) return;
    clearTimeout(textTimer);
    textTimer = setTimeout(fetchText, 400);
  }

  async function fetchText() {
    const q = googleQuery(), what = food, words = el.foodInput.value.trim();
    for (const key of textCache.keys()) {           // already searched this food here?
      const [f, area] = key.split("|");
      const [la, lo, ra] = area.split(",").map(Number);
      if (f === what && distanceM(la, lo, q.lat, q.lon) + q.radius <= ra + 150) return;
    }
    liveLoading++; refresh();
    try {
      await loadRules();
      const r = await fetch(`${GOOGLE}/text?q=${encodeURIComponent(words)}&lat=${q.lat.toFixed(5)}&lon=${q.lon.toFixed(5)}&radius=${q.radius}`);
      const j = await r.json();
      log("food search:", j.error ? `error "${j.error}"` : `${(j.places || []).length} “${words}” places`,
          j.used ? `(${j.used}/${j.cap} this month)` : "");
      if (j.capped) {
        el.gNote.textContent = "Google food search is paused until next month; matching by name only.";
        el.gNote.hidden = false;
      } else if (!j.error && !j.limited) {
        textCache.set(`${what}|${q.lat.toFixed(4)},${q.lon.toFixed(4)},${q.radius}`, true);
        const res = (j.places || []).map(fromGoogle);
        const hits = textHits.get(what) || new Set();
        res.forEach((g) => hits.add(g.id));
        textHits.set(what, hits);
        await applyGoogle(res);
      }
    } catch (e) {
      console.warn("Google food search unavailable", e);
    } finally { liveLoading--; refresh(); }
  }

  el.foodInput.addEventListener("input", () => setFood(el.foodInput.value));   // free name matching as you type
  el.foodInput.addEventListener("change", () => { setFood(el.foodInput.value); scheduleText(); });  // Enter or leaving the box
  el.foodInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); el.foodInput.blur(); } });
  el.foodClear.addEventListener("click", () => { el.foodInput.value = ""; setFood(""); el.foodInput.focus(); });

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
    scheduleText();
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
    el.roadInput.placeholder = isSG() ? "Search a road or area, e.g. Amoy St"
      : "Search a city, area or street, e.g. Dago, Bandung";
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
  el.radius.addEventListener("input", () => { updateRadiusLabel(); refresh(); scheduleOsm(); scheduleGoogle(); scheduleText(); });
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

  // ---------- sheets ----------
  const filterSheet = $("filterSheet"), filterBtn = $("filterBtn");
  filterBtn.addEventListener("click", () => { filterSheet.hidden = false; $("filterDone").focus(); });
  $("filterDone").addEventListener("click", () => { filterSheet.hidden = true; filterBtn.focus(); });
  for (const sheet of [filterSheet, el.result]) {
    sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.hidden = true; });   // tap outside
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!filterSheet.hidden) { filterSheet.hidden = true; filterBtn.focus(); }
    else if (!el.result.hidden) { el.result.hidden = true; el.spinBtn.focus(); }
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
