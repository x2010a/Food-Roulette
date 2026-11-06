# Food Roulette 🎡

Can't decide what to eat? Spin the wheel and it picks a food place near you in Singapore,
then opens it in Google Maps for reviews and directions.

Runs entirely free: no server, no database, no API keys.

- **Data:** OpenStreetMap, refreshed weekly by GitHub Actions
- **Hosting:** GitHub Pages
- **Reviews / directions:** a plain Google Maps link (free, no API)

## Project layout

```
site/                     ← the website (this folder is what gets published)
  index.html
  style.css
  app.js
  data/places.json        ← created by the workflow, don't edit by hand
scripts/build_data.py     ← downloads food places from OpenStreetMap
.github/workflows/build-and-deploy.yml
```

## Deploy (one-time setup, ~5 minutes)

1. Create a new **public** repo on GitHub (public = free Actions and Pages).
2. Upload everything in this folder to it (or `git push`). Keep the `.github` folder.
3. In the repo go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
4. Go to **Actions → Build & deploy → Run workflow**. This first run downloads the data
   (about a minute), commits `site/data/places.json`, and publishes the site.
5. Your site is live at `https://<your-username>.github.io/<repo-name>/`.

After that:
- The data refreshes **every Monday 4am SGT** automatically.
- Any change you push to `main` redeploys the site (using the existing data, so it's quick).
- Need fresh data now? **Actions → Build & deploy → Run workflow**.

## Running it on your computer

```bash
pip install requests
python scripts/build_data.py          # creates site/data/places.json
cd site && python -m http.server 8000 # open http://localhost:8000
```

"Use my location" only works on `localhost` or HTTPS (GitHub Pages is HTTPS).

## How it works

- `build_data.py` asks OpenStreetMap's Overpass API for every named restaurant, fast food
  outlet, café, food court/hawker centre and ice cream shop in Singapore and saves them as
  one compact JSON file. If a download looks broken (under 1,000 places), it stops and keeps
  the old data.
- The page loads that file, finds places within the chosen radius of the user, puts up to
  10 random ones on the wheel and spins.
- Personal settings (places hidden as "closed", places visited in the last 7 days, last area)
  are saved in the user's own browser. Nothing is sent anywhere.

## Cuisine & craving filters

`scripts/classify.py` tags every place with a cuisine (Chinese, Malay & Indo, Indian, Thai,
Japanese, Korean, Western, Others) and a craving (Rice, Noodles, Bread & burgers, Light / low-carb).
It uses the OpenStreetMap `cuisine` tag first, then keywords in the place name
("Prata" → Indian + Bread, "Mookata" → Thai + Light).

- Hawker centres, food courts, kopitiams and coffee shops are marked **many stalls** and match
  every cuisine and craving (users can switch this off).
- Places with no cuisine found are hidden while a cuisine filter is on.
- Each weekly run prints a **coverage report** in the Actions log (Actions → latest run →
  "Refresh food places") showing how many places each filter catches. To improve it, add
  keywords to the lists in `classify.py` and push.

## Road search

The weekly run also downloads every named road in Singapore (expressways excluded) into
`site/data/roads.json`. Typing in the road box suggests matches and understands short forms
like `ave`, `rd`, `st`, `jln`, `upp`, `amk`, `tpy`. Picking a road searches for food within the
chosen distance of **anywhere along that road**, not just one point. If the road download fails,
the previous week's road list is kept.

## Extra sources: NEA hawker centres & your own lists

**NEA hawker centres** (`scripts/nea.py`): every existing NEA hawker centre from data.gov.sg,
with its stall count. Centres already in OpenStreetMap get the stall count added; missing
ones are added.

**Your own lists** (`data/manual/*.json`): drop in a file such as `sethlui-top300.json`
(made with the browser console snippet) and the weekly run adds its places. Postal codes become
map points via OneMap (Singapore Land Authority), cached in `data/geocode_cache.json`.
Format: `{"site": "SETHLUI.com", "fetched": "2026-11-03", "places": [{"name", "address", "postcode", "url"}]}`

## Google places (optional, capped to the free allowance)

When a user picks a location, the app asks Google once for up to 20 nearby food places
and adds any we don't already have. It goes through a small relay (`worker/worker.js`) on
Cloudflare's free plan that keeps your API key secret and **stops at 4,500 Google calls a
month**, under the 5,000 free Nearby Search (Pro) calls. After that the app carries on with
the free data and shows "Extra Google places are paused until next month".

- Only the cheapest fields are requested (name, location, address, type, Maps link). Adding
  ratings, hours or reviews would move every call to a pricier tier with a 1,000/month free
  allowance, so don't add them without lowering `MONTHLY_CAP` to ~900.
- One call per location. Re-spins, filters and a smaller radius reuse it. Results live only
  in the user's browser memory for that visit; nothing from Google is saved to the repo.
- Google places show "Place info from Google Maps" (required attribution) and open their exact
  Google Maps listing.

### Set up Google (about 10 minutes)
1. Go to console.cloud.google.com and create a project, e.g. `food-roulette`.
2. **Billing** → link a billing account. Google requires a card even for free usage.
3. **APIs & Services → Library** → enable **Places API (New)**.
4. **APIs & Services → Credentials → Create credentials → API key**. Edit the key →
   **API restrictions → Restrict key → Places API (New)** only. Leave application
   restrictions as none (the key lives on Cloudflare, never in the website).
5. Extra safety: **Billing → Budgets & alerts** → a US$1 budget with email alerts.

### Set up the Cloudflare relay (about 10 minutes, free)
1. Sign up at dash.cloudflare.com.
2. **Storage & Databases → KV → Create** a namespace called `food-roulette-usage`.
3. **Workers & Pages → Create → Worker**, name it `food-roulette`, Deploy, then
   **Edit code**: replace everything with `worker/worker.js` and click Deploy.
4. In the Worker: **Settings → Bindings → Add → KV namespace**: variable name `USAGE`,
   namespace `food-roulette-usage`.
5. **Settings → Variables and Secrets → Add**:
   - `GOOGLE_KEY` (type **Secret**): your Google API key
   - `ALLOWED_ORIGINS` (Text): `https://<your-username>.github.io`
   - `MONTHLY_CAP` (Text): `4500`
6. Copy the Worker's address, e.g. `https://food-roulette.<you>.workers.dev`.

### Add the human check (Cloudflare Turnstile, free, about 5 minutes)
Stops bots from using up your Google allowance. Real users usually see nothing; Turnstile
only asks for a click when something looks automated. Spins are never checked.
1. Cloudflare dashboard → **Turnstile → Add widget**. Name it `food-roulette`, add the
   hostname `<your-username>.github.io`, widget mode **Managed**. Create.
2. Copy the **Site Key** into `site/config.js` → `turnstileSiteKey`.
3. Copy the **Secret Key** into your Worker: **Settings → Variables and Secrets → Add**,
   name `TURNSTILE_SECRET`, type **Secret**.

The Worker checks the token before touching the monthly counter, so failed checks cost
nothing. If someone fails the check, the app keeps working on the free data.

### Switch it on
Edit `site/config.js` on GitHub and set `googleProxy` to that address. Commit; the site
redeploys in about a minute. To switch Google off, set it back to `""`.

To see this month's usage: Cloudflare → KV → `food-roulette-usage` → key `google-calls:YYYY-MM`.
Note Cloudflare's free KV allows 1,000 counter updates a day; on an unusually busy day the
relay pauses Google until the next day rather than risk going over.

## Things to know

- **Credit OpenStreetMap.** The footer's "© OpenStreetMap contributors" line is required by
  the data licence (ODbL). Keep it.
- **Data gaps.** Names and locations are good; cuisine, opening hours and halal/vegetarian tags
  are often missing. Hawker centres are usually one place, not individual stalls.
- **Keep the repo active.** GitHub pauses scheduled workflows in repos with no activity for 60
  days. The weekly data commit normally counts as activity, but if a refresh fails for a while,
  run the workflow manually to restart it.
- **Change what counts as food** in `FOOD_AMENITIES` in `scripts/build_data.py`, and the
  starting areas in `AREAS` at the top of `site/app.js`.

## Ready for Phase 2 (reviews)

Each place has a stable `id` (e.g. `n123456789`, its OpenStreetMap ID). When you add a backend
like Supabase for verified reviews and photos, store reviews against that ID and the wheel
data doesn't need to change.
