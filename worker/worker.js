/**
 * Food Roulette – Google Places relay with a hard monthly cap.
 *
 * Runs free on Cloudflare Workers. It:
 *   - keeps your Google API key secret (the website never sees it)
 *   - counts Google calls per calendar month and STOPS at MONTHLY_CAP,
 *     so you stay inside Google's free allowance (5,000 Nearby Search Pro / month)
 *   - asks Google only for the cheapest fields (no ratings, hours or reviews)
 *   - only answers your own website
 *   - /nearby        food places around a point (Nearby Search Pro, capped by MONTHLY_CAP)
 *   - /autocomplete  location suggestions while typing (Autocomplete; cap it in Google Cloud quotas)
 *   - /place         coordinates of a picked suggestion (Place Details Essentials, capped by PLACE_CAP)
 *   - /text          "what do you feel like" food search, e.g. dim sum (Text Search Pro, capped by TEXT_CAP)
 *
 * Settings (Cloudflare dashboard → your Worker → Settings → Variables):
 *   GOOGLE_KEY       (secret)  your Google Maps Platform API key
 *   ALLOWED_ORIGINS  (text)    e.g. https://yourname.github.io
 *   MONTHLY_CAP      (text)    default 4500 (leaves a safety margin under 5,000)
 *   IP_DAILY_LIMIT   (text)    optional, default 20 searches per connection per day
 *   EXTRA_SEARCHES   (text)    optional, 0-6, default 6: extra Google calls when an area has 20+ places
 *   TURNSTILE_SECRET (secret)  optional; only set it if you use Cloudflare Turnstile
 *   PLACE_CAP        (text)    optional, default 9000 place lookups a month (10,000 free)
 *   TEXT_CAP         (text)    optional, default 4500 food-search calls a month (Text Search Pro, 5,000 free)
 * Binding (Settings → Bindings → KV namespace):
 *   USAGE                      a KV namespace used for the monthly counter
 */

// Cheapest tier for Nearby Search (Pro). Adding rating, hours or reviews here
// would move every call to a pricier tier with a smaller free allowance.
const FIELD_MASK = [
  "places.id", "places.displayName", "places.location", "places.formattedAddress",
  "places.primaryType", "places.types", "places.googleMapsUri", "places.businessStatus",
].join(",");

const INCLUDED_TYPES = [
  "restaurant", "cafe", "coffee_shop", "fast_food_restaurant", "food_court", "bakery", "ice_cream_shop",
];


function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
    const okOrigin = allowed.length === 0 || allowed.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": okOrigin && origin ? origin : allowed[0] || "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      Vary: "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!okOrigin) return json({ error: "origin not allowed" }, 403, cors);

    const url = new URL(request.url);
    if (url.pathname === "/autocomplete") return autocomplete(url, env, cors);
    if (url.pathname === "/place") return placeDetails(url, env, cors);
    if (url.pathname === "/text") return textSearch(request, url, env, cors);
    if (url.pathname !== "/nearby") return json({ error: "not found" }, 404, cors);

    const lat = parseFloat(url.searchParams.get("lat"));
    const lon = parseFloat(url.searchParams.get("lon"));
    let radius = parseFloat(url.searchParams.get("radius"));
    if (!(lat >= -85 && lat <= 85 && lon >= -180 && lon <= 180)) {
      return json({ error: "bad location" }, 400, cors);
    }
    radius = Math.min(5000, Math.max(100, Number.isFinite(radius) ? radius : 800));

    // ---- human check (Cloudflare Turnstile) -------------------------------------
    // Checked before the counter, so bots can't even use up the monthly allowance.
    if (env.TURNSTILE_SECRET) {
      const token = url.searchParams.get("token") || "";
      if (!token) return json({ places: [], error: "captcha required" }, 403, cors);
      let ok = false;
      try {
        const form = new FormData();
        form.append("secret", env.TURNSTILE_SECRET);
        form.append("response", token);
        const ip = request.headers.get("CF-Connecting-IP");
        if (ip) form.append("remoteip", ip);
        const v = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
        ok = (await v.json()).success === true;
      } catch { ok = false; }
      if (!ok) return json({ places: [], error: "captcha failed" }, 403, cors);
    }

    // ---- per-connection daily limit ----------------------------------------
    // Stops one person or bot from using up the month's allowance.
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const ipLimit = parseInt(env.IP_DAILY_LIMIT || "20", 10);
    const ipKey = `ip:${new Date().toISOString().slice(0, 10)}:${ip}`;
    let ipUsed = 0;
    try { ipUsed = parseInt((await env.USAGE.get(ipKey)) || "0", 10); } catch { /* treat as 0 */ }
    if (ipUsed >= ipLimit) return json({ places: [], limited: true }, 200, cors);

    // ---- hard monthly cap -------------------------------------------------
    const month = new Date().toISOString().slice(0, 7);           // e.g. 2026-11
    const cap = parseInt(env.MONTHLY_CAP || "4500", 10);
    const counterKey = `google-calls:${month}`;
    let used;
    try {
      used = parseInt((await env.USAGE.get(counterKey)) || "0", 10);
    } catch {
      return json({ places: [], capped: true, reason: "counter unavailable" }, 200, cors); // fail closed
    }
    if (used >= cap) return json({ places: [], capped: true, used, cap }, 200, cors);
    try {
      // count BEFORE calling Google; if we can't record it, don't call Google
      await env.USAGE.put(counterKey, String(used + 1), { expirationTtl: 60 * 60 * 24 * 45 });
      await env.USAGE.put(ipKey, String(ipUsed + 1), { expirationTtl: 60 * 60 * 48 });
    } catch {
      return json({ places: [], capped: true, reason: "counter unavailable" }, 200, cors);
    }

    // ---- Google searches -----------------------------------------------------
    // Google returns at most 20 places per search (the 20 closest). If the first
    // search comes back full, search 6 smaller circles around it to reach the rest.
    const search = async (cLat, cLon, r) => {
      const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": env.GOOGLE_KEY, "X-Goog-FieldMask": FIELD_MASK },
        body: JSON.stringify({
          includedTypes: INCLUDED_TYPES,
          maxResultCount: 20,
          rankPreference: "DISTANCE",
          locationRestriction: { circle: { center: { latitude: cLat, longitude: cLon }, radius: r } },
        }),
      });
      if (!res.ok) throw new Error(`google ${res.status}`);
      return (await res.json()).places || [];
    };

    let raw;
    try {
      raw = await search(lat, lon, radius);
    } catch (e) {
      return json({ places: [], error: String(e.message || "google unreachable") }, 200, cors);
    }

    let calls = 1;
    const extra = Math.min(6, parseInt(env.EXTRA_SEARCHES ?? "6", 10) || 0, cap - (used + 1));
    if (raw.length >= 20 && extra > 0) {
      try {
        await env.USAGE.put(counterKey, String(used + 1 + extra), { expirationTtl: 60 * 60 * 24 * 45 });
        const subR = Math.round(radius * 0.55);
        const ring = [];
        for (let i = 0; i < extra; i++) {
          const a = (Math.PI / 3) * i, d = radius * 0.87;
          ring.push(search(lat + (d * Math.cos(a)) / 110574,
                           lon + (d * Math.sin(a)) / (111320 * Math.cos((lat * Math.PI) / 180)), subR));
        }
        for (const r of await Promise.allSettled(ring)) if (r.status === "fulfilled") raw.push(...r.value);
        calls += extra;
      } catch { /* counter write failed: return what we have */ }
    }

    const seen = new Set();
    const places = raw
      .filter((p) => !p.businessStatus || p.businessStatus === "OPERATIONAL")   // skip closed places
      .filter((p) => p.location && p.displayName && p.displayName.text)
      .filter((p) => (seen.has(p.id) ? false : seen.add(p.id)))               // same place from two circles
      .map((p) => ({
        gid: p.id,
        name: p.displayName.text,
        lat: p.location.latitude,
        lon: p.location.longitude,
        addr: p.formattedAddress || null,
        type: p.primaryType || null,
        types: p.types || [],
        uri: p.googleMapsUri || null,
      }));
    return json({ places, used: used + calls, cap, calls }, 200, cors);
  },
};

// ---------------------------------------------------------------- location search
const SESSION_RE = /^[A-Za-z0-9-]{8,64}$/;

async function autocomplete(url, env, cors) {
  const q = (url.searchParams.get("q") || "").trim().slice(0, 80);
  const cc = (url.searchParams.get("cc") || "").toUpperCase();
  const session = url.searchParams.get("session") || "";
  if (q.length < 2) return json({ suggestions: [] }, 200, cors);
  const body = { input: q };
  if (/^[A-Z]{2}$/.test(cc)) body.includedRegionCodes = [cc];
  if (SESSION_RE.test(session)) body.sessionToken = session;   // makes the typing free when a pick follows
  const lat = parseFloat(url.searchParams.get("lat")), lon = parseFloat(url.searchParams.get("lon"));
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    body.locationBias = { circle: { center: { latitude: lat, longitude: lon }, radius: 50000 } };
  }
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": env.GOOGLE_KEY },
      body: JSON.stringify(body),
    });
    if (!res.ok) return json({ suggestions: [], error: `google ${res.status}` }, 200, cors);
    const data = await res.json();
    const suggestions = (data.suggestions || []).filter((s) => s.placePrediction).slice(0, 8).map((s) => {
      const p = s.placePrediction, f = p.structuredFormat || {};
      return { id: p.placeId, main: (f.mainText || p.text || {}).text || "", sub: (f.secondaryText || {}).text || "" };
    });
    return json({ suggestions }, 200, cors);
  } catch {
    return json({ suggestions: [], error: "google unreachable" }, 200, cors);
  }
}

async function placeDetails(url, env, cors) {
  const id = url.searchParams.get("id") || "";
  const session = url.searchParams.get("session") || "";
  if (!/^[A-Za-z0-9_-]{10,300}$/.test(id)) return json({ error: "bad id" }, 400, cors);

  const month = new Date().toISOString().slice(0, 7);
  const key = `place-calls:${month}`;
  const cap = parseInt(env.PLACE_CAP || "9000", 10);
  let used;
  try { used = parseInt((await env.USAGE.get(key)) || "0", 10); } catch { return json({ capped: true }, 200, cors); }
  if (used >= cap) return json({ capped: true }, 200, cors);
  try { await env.USAGE.put(key, String(used + 1), { expirationTtl: 60 * 60 * 24 * 45 }); }
  catch { return json({ capped: true }, 200, cors); }

  // Essentials fields only (cheapest tier, 10,000 free a month).
  const qs = SESSION_RE.test(session) ? `?sessionToken=${session}` : "";
  try {
    const res = await fetch(`https://places.googleapis.com/v1/places/${id}${qs}`, {
      headers: { "X-Goog-Api-Key": env.GOOGLE_KEY, "X-Goog-FieldMask": "location,formattedAddress,addressComponents" },
    });
    if (!res.ok) return json({ error: `google ${res.status}` }, 200, cors);
    const d = await res.json();
    if (!d.location) return json({ error: "no location" }, 200, cors);
    const country = (d.addressComponents || []).find((c) => (c.types || []).includes("country"));
    return json({ lat: d.location.latitude, lon: d.location.longitude, addr: d.formattedAddress || null,
                  cc: country ? country.shortText : null }, 200, cors);
  } catch {
    return json({ error: "google unreachable" }, 200, cors);
  }
}

// ---------------------------------------------------------------- food text search
// "dim sum" within the radius. Up to 3 pages of 20 (3 calls) from Google's Text Search,
// a separate free allowance from Nearby Search.
async function textSearch(request, url, env, cors) {
  const q = (url.searchParams.get("q") || "").trim().slice(0, 60);
  const lat = parseFloat(url.searchParams.get("lat")), lon = parseFloat(url.searchParams.get("lon"));
  let radius = parseFloat(url.searchParams.get("radius"));
  if (q.length < 2 || !(lat >= -85 && lat <= 85 && lon >= -180 && lon <= 180)) return json({ error: "bad request" }, 400, cors);
  radius = Math.min(5000, Math.max(100, Number.isFinite(radius) ? radius : 800));

  // shares the per-connection daily limit with /nearby
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipLimit = parseInt(env.IP_DAILY_LIMIT || "20", 10);
  const ipKey = `ip:${new Date().toISOString().slice(0, 10)}:${ip}`;
  let ipUsed = 0;
  try { ipUsed = parseInt((await env.USAGE.get(ipKey)) || "0", 10); } catch { /* treat as 0 */ }
  if (ipUsed >= ipLimit) return json({ places: [], limited: true }, 200, cors);

  const key = `text-calls:${new Date().toISOString().slice(0, 7)}`;
  const cap = parseInt(env.TEXT_CAP || "4500", 10);
  let used;
  try { used = parseInt((await env.USAGE.get(key)) || "0", 10); } catch { return json({ places: [], capped: true }, 200, cors); }
  const pages = Math.min(3, cap - used);
  if (pages <= 0) return json({ places: [], capped: true, used, cap }, 200, cors);
  try {
    await env.USAGE.put(key, String(used + pages), { expirationTtl: 60 * 60 * 24 * 45 });   // count first
    await env.USAGE.put(ipKey, String(ipUsed + 1), { expirationTtl: 60 * 60 * 48 });
  } catch { return json({ places: [], capped: true }, 200, cors); }

  // Text Search can only be *restricted* to a rectangle: use the box around the circle,
  // then drop anything outside the circle.
  const dLat = radius / 110574, dLon = radius / (111320 * Math.cos((lat * Math.PI) / 180));
  const body = {
    textQuery: q, pageSize: 20,
    locationRestriction: { rectangle: { low: { latitude: lat - dLat, longitude: lon - dLon },
                                        high: { latitude: lat + dLat, longitude: lon + dLon } } },
  };
  const raw = [];
  let calls = 0;
  try {
    for (let page = 0; page < pages; page++) {
      const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": env.GOOGLE_KEY,
                   "X-Goog-FieldMask": FIELD_MASK + ",nextPageToken" },
        body: JSON.stringify(body),
      });
      calls++;
      if (!res.ok) { if (!raw.length) return json({ places: [], error: `google ${res.status}` }, 200, cors); break; }
      const d = await res.json();
      raw.push(...(d.places || []));
      if (!d.nextPageToken) break;
      body.pageToken = d.nextPageToken;
    }
  } catch { if (!raw.length) return json({ places: [], error: "google unreachable" }, 200, cors); }

  // give back calls we reserved but didn't need
  if (calls < pages) { try { await env.USAGE.put(key, String(used + calls), { expirationTtl: 60 * 60 * 24 * 45 }); } catch { /* keep the safe count */ } }

  const mLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const seen = new Set();
  const places = raw
    .filter((p) => !p.businessStatus || p.businessStatus === "OPERATIONAL")
    .filter((p) => p.location && p.displayName && p.displayName.text)
    .filter((p) => Math.hypot((p.location.latitude - lat) * 110574, (p.location.longitude - lon) * mLon) <= radius)
    .filter((p) => (seen.has(p.id) ? false : seen.add(p.id)))
    .map((p) => ({ gid: p.id, name: p.displayName.text, lat: p.location.latitude, lon: p.location.longitude,
                   addr: p.formattedAddress || null, type: p.primaryType || null, types: p.types || [],
                   uri: p.googleMapsUri || null }));
  return json({ places, used: used + calls, cap, calls }, 200, cors);
}
