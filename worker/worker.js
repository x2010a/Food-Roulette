/**
 * Food Roulette – Google Places relay with a hard monthly cap.
 *
 * Runs free on Cloudflare Workers. It:
 *   - keeps your Google API key secret (the website never sees it)
 *   - counts Google calls per calendar month and STOPS at MONTHLY_CAP,
 *     so you stay inside Google's free allowance (5,000 Nearby Search Pro / month)
 *   - asks Google only for the cheapest fields (no ratings, hours or reviews)
 *   - only answers your own website, and only for places in Singapore
 *
 * Settings (Cloudflare dashboard → your Worker → Settings → Variables):
 *   GOOGLE_KEY       (secret)  your Google Maps Platform API key
 *   ALLOWED_ORIGINS  (text)    e.g. https://yourname.github.io
 *   MONTHLY_CAP      (text)    default 4500 (leaves a safety margin under 5,000)
 *   TURNSTILE_SECRET (secret)  Cloudflare Turnstile secret key; when set, every Google
 *                              search needs a fresh human-check token from the website
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

// Rough box around Singapore: refuse anything outside it.
const SG = { minLat: 1.15, maxLat: 1.48, minLon: 103.59, maxLon: 104.1 };

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
    if (url.pathname !== "/nearby") return json({ error: "not found" }, 404, cors);

    const lat = parseFloat(url.searchParams.get("lat"));
    const lon = parseFloat(url.searchParams.get("lon"));
    let radius = parseFloat(url.searchParams.get("radius"));
    if (!(lat >= SG.minLat && lat <= SG.maxLat && lon >= SG.minLon && lon <= SG.maxLon)) {
      return json({ error: "outside Singapore" }, 400, cors);
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
    } catch {
      return json({ places: [], capped: true, reason: "counter unavailable" }, 200, cors);
    }

    // ---- one Nearby Search call ----------------------------------------------
    let res;
    try {
      res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": env.GOOGLE_KEY,
          "X-Goog-FieldMask": FIELD_MASK,
        },
        body: JSON.stringify({
          includedTypes: INCLUDED_TYPES,
          maxResultCount: 20,
          rankPreference: "DISTANCE",
          locationRestriction: { circle: { center: { latitude: lat, longitude: lon }, radius } },
        }),
      });
    } catch {
      return json({ places: [], error: "google unreachable" }, 200, cors);
    }
    if (!res.ok) return json({ places: [], error: `google ${res.status}` }, 200, cors);

    const data = await res.json();
    const places = (data.places || [])
      .filter((p) => !p.businessStatus || p.businessStatus === "OPERATIONAL")   // skip closed places
      .filter((p) => p.location && p.displayName && p.displayName.text)
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
    return json({ places, used: used + 1, cap }, 200, cors);
  },
};
