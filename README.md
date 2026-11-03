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
