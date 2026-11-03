"""
Download Singapore food places and road names from OpenStreetMap and write:
  site/data/places.json   food places, tagged with cuisine + craving guesses
  site/data/roads.json    road names with sample points, for the road search box

Run locally:      pip install requests && python scripts/build_data.py
Run on GitHub:    the "Build & deploy" workflow runs this weekly.
"""
import json
import pathlib
import sys
import time
from collections import Counter, defaultdict

import requests

from classify import CRAVING_LABELS, CUISINE_LABELS, classify

DATA_DIR = pathlib.Path(__file__).resolve().parent.parent / "site" / "data"

# Public Overpass servers. If the first is busy, the next is tried.
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# Which OSM amenity tags count as "food". Edit to taste.
FOOD_AMENITIES = ["restaurant", "fast_food", "cafe", "food_court", "ice_cream"]

# Road types people would search by (expressways excluded: you can't eat on the PIE).
ROAD_TYPES = ["trunk", "primary", "secondary", "tertiary", "unclassified",
              "residential", "living_street", "pedestrian", "service"]

AREA = '[out:json][timeout:180];area["ISO3166-1"="SG"][admin_level=2]->.sg;'
PLACES_QUERY = AREA + f'nwr["amenity"~"^({"|".join(FOOD_AMENITIES)})$"](area.sg);out center tags;'
ROADS_QUERY = AREA + f'way["highway"~"^({"|".join(ROAD_TYPES)})$"]["name"](area.sg);out center tags;'

# If a download returns fewer than this, something went wrong:
# keep the previous data instead of publishing a broken file.
MIN_PLACES = 1000
MIN_ROADS = 1000

PLACE_FIELDS = ["id", "name", "type", "cuisine", "lat", "lon", "halal", "veg",
                "street", "postcode", "hours", "cz", "cr", "mix"]

ROAD_GRID = 0.002      # merge road points closer than ~220 m
ROAD_MAX_POINTS = 40   # cap points per road name to keep the file small


def overpass(query):
    headers = {"User-Agent": "food-roulette-data-refresh/1.0"}
    last_err = None
    for url in OVERPASS_URLS:
        for attempt in range(3):
            try:
                print(f"  {url} (attempt {attempt + 1})...")
                r = requests.post(url, data={"data": query}, headers=headers, timeout=300)
                r.raise_for_status()
                return r.json()["elements"]
            except Exception as e:  # noqa: BLE001
                last_err = e
                print(f"    failed: {e}")
                time.sleep(20)
    raise RuntimeError(f"All Overpass servers failed: {last_err}")


def latlon(el):
    lat = el.get("lat") or el.get("center", {}).get("lat")
    lon = el.get("lon") or el.get("center", {}).get("lon")
    return lat, lon


# ------------------------------------------------------------------ places
def build_places(elements):
    rows, stats = [], {"total": 0, "mixed": 0, "no_cuisine": 0,
                       "cuisine_tag": Counter(), "cuisine_name": Counter(), "craving": Counter()}
    for el in elements:
        t = el.get("tags", {})
        name = (t.get("name:en") or t.get("name") or "").strip()
        lat, lon = latlon(el)
        if not name or lat is None or lon is None:
            continue
        amenity = t.get("amenity")
        cz, cr, mixed, source = classify(name, t.get("cuisine"), amenity)

        stats["total"] += 1
        if mixed:
            stats["mixed"] += 1
        elif not cz:
            stats["no_cuisine"] += 1
        for c in cz:
            stats["cuisine_tag" if source == "tag" else "cuisine_name"][c] += 1
        for c in cr:
            stats["craving"][c] += 1

        rows.append([
            f"{el['type'][0]}{el['id']}",            # n123 / w456 / r789
            name,
            amenity,
            (t.get("cuisine") or "").replace("_", " ").replace(";", ", ") or None,
            round(lat, 5), round(lon, 5),
            t.get("diet:halal"), t.get("diet:vegetarian"),
            t.get("addr:street"), t.get("addr:postcode"), t.get("opening_hours"),
            ",".join(cz) or None,
            ",".join(cr) or None,
            1 if mixed else 0,
        ])
    rows.sort(key=lambda r: r[0])  # stable order = smaller git diffs
    return rows, stats


def print_coverage(stats):
    n = stats["total"] or 1
    pct = lambda x: f"{100 * x / n:4.1f}%"
    print("\n=== Filter coverage report ===")
    print(f"Named food places:            {stats['total']}")
    print(f"Many-stall places (match all): {stats['mixed']} ({pct(stats['mixed'])})")
    print(f"No cuisine found:             {stats['no_cuisine']} ({pct(stats['no_cuisine'])})"
          "  <- hidden when a cuisine filter is on")
    print("\nCuisine          from tag  from name   total")
    for code, label in CUISINE_LABELS.items():
        a, b = stats["cuisine_tag"][code], stats["cuisine_name"][code]
        print(f"  {label:<18}{a:>6}{b:>10}{a + b:>9}")
    print("\nCraving")
    for code, label in CRAVING_LABELS.items():
        print(f"  {label:<18}{stats['craving'][code]:>6}")
    print()


# ------------------------------------------------------------------- roads
def build_roads(elements):
    points = defaultdict(dict)
    for el in elements:
        name = (el.get("tags", {}).get("name") or "").strip()
        lat, lon = latlon(el)
        if not name or lat is None:
            continue
        cell = (round(lat / ROAD_GRID), round(lon / ROAD_GRID))
        points[name].setdefault(cell, (round(lat, 4), round(lon, 4)))

    roads = []
    for name, cells in points.items():
        pts = sorted(cells.values())
        if len(pts) > ROAD_MAX_POINTS:                 # sample evenly along the list
            step = len(pts) / ROAD_MAX_POINTS
            pts = [pts[int(i * step)] for i in range(ROAD_MAX_POINTS)]
        roads.append([name, [c for p in pts for c in p]])
    roads.sort(key=lambda r: r[0].lower())
    return roads


def write(name, payload):
    path = DATA_DIR / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {path} ({path.stat().st_size / 1024:.0f} KB).")


def main():
    today = time.strftime("%Y-%m-%d")
    source = "© OpenStreetMap contributors (ODbL)"

    print("Downloading food places...")
    rows, stats = build_places(overpass(PLACES_QUERY))
    print(f"Kept {len(rows)} named food places.")
    if len(rows) < MIN_PLACES:
        sys.exit(f"Only {len(rows)} places - looks wrong, not overwriting data.")
    print_coverage(stats)
    write("places.json", {"updated": today, "source": source, "fields": PLACE_FIELDS, "places": rows})

    # Roads are a nice-to-have: if this fails, keep last week's file and carry on.
    time.sleep(5)  # be polite to the free server
    print("Downloading road names...")
    try:
        roads = build_roads(overpass(ROADS_QUERY))
        print(f"Kept {len(roads)} road names.")
        if len(roads) < MIN_ROADS:
            raise RuntimeError(f"only {len(roads)} roads")
        write("roads.json", {"updated": today, "source": source, "roads": roads})
    except Exception as e:  # noqa: BLE001
        print(f"WARNING: road download failed ({e}); keeping the previous roads.json.")


if __name__ == "__main__":
    main()
