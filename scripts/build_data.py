"""
Build the Food Roulette data files:
  site/data/places.json   food places from OpenStreetMap + NEA hawker centres (+ any lists in data/manual/)
  site/data/roads.json    road names with sample points, for the road search box

Run locally:      pip install requests && python scripts/build_data.py
Run on GitHub:    the "Build & deploy" workflow runs this weekly.
"""
import hashlib
import json
import math
import pathlib
import re
import sys
import time
from collections import Counter, defaultdict

import requests

import nea
from classify import CRAVING_LABELS, CRAVING_NAMES, CUISINE_LABELS, CUISINE_NAMES, MIXED_NAMES, classify
from geocode import Geocoder

DATA_DIR = pathlib.Path(__file__).resolve().parent.parent / "site" / "data"

OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
FOOD_AMENITIES = ["restaurant", "fast_food", "cafe", "food_court", "ice_cream"]
ROAD_TYPES = ["trunk", "primary", "secondary", "tertiary", "unclassified",
              "residential", "living_street", "pedestrian", "service"]

AREA = '[out:json][timeout:180];area["ISO3166-1"="SG"][admin_level=2]->.sg;'
PLACES_QUERY = AREA + f'nwr["amenity"~"^({"|".join(FOOD_AMENITIES)})$"](area.sg);out center tags;'
ROADS_QUERY = AREA + f'way["highway"~"^({"|".join(ROAD_TYPES)})$"]["name"](area.sg);out center tags;'

MIN_PLACES = 1000
MIN_ROADS = 1000

PLACE_FIELDS = ["id", "name", "type", "cuisine", "lat", "lon", "halal", "veg",
                "street", "postcode", "hours", "cz", "cr", "mix", "addr", "stalls", "f"]

ROAD_GRID = 0.002
ROAD_MAX_POINTS = 40

HAWKER_ADDR = re.compile(r"food ?cent(re|er)|hawker|market|food ?court|kopitiam|coffee ?shop|eating house", re.I)


# ------------------------------------------------------------------ helpers
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
    return (el.get("lat") or el.get("center", {}).get("lat"),
            el.get("lon") or el.get("center", {}).get("lon"))


def dist_m(a_lat, a_lon, b_lat, b_lon):
    dy = (a_lat - b_lat) * 110574
    dx = (a_lon - b_lon) * 111320 * math.cos(math.radians(1.35))
    return math.hypot(dx, dy)


STOP = {"the", "restaurant", "stall", "cafe", "café", "kitchen", "eating", "house", "food",
        "centre", "center", "market", "and", "&", "pte", "ltd", "singapore", "sg", "@"}


def name_key(name):
    words = re.findall(r"[a-z0-9]+", (name or "").lower())
    return [w for w in words if w not in STOP] or words


def similar(a, b):
    ka, kb = set(name_key(a)), set(name_key(b))
    if not ka or not kb:
        return False
    if ka <= kb or kb <= ka:
        return True
    return len(ka & kb) / len(ka | kb) >= 0.5


class Grid:
    """Tiny spatial index so 'what's within 150 m?' is fast."""
    def __init__(self, items, cell=0.002):
        self.cell, self.g = cell, defaultdict(list)
        for it in items:
            self.add(it)

    def add(self, it):
        self.g[(int(it["lat"] / self.cell), int(it["lon"] / self.cell))].append(it)

    def near(self, lat, lon, radius_m):
        ci, cj = int(lat / self.cell), int(lon / self.cell)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for it in self.g.get((ci + di, cj + dj), []):
                    if dist_m(lat, lon, it["lat"], it["lon"]) <= radius_m:
                        yield it


def new_place(pid, name, amenity, lat, lon, addr=None, postcode=None):
    cz, cr, mixed, _ = classify(name, None, amenity)
    return {"id": pid, "name": name, "type": amenity, "cuisine": None, "lat": lat, "lon": lon,
            "halal": None, "veg": None, "street": None, "postcode": postcode, "hours": None,
            "cz": cz, "cr": cr, "mix": mixed, "addr": addr, "stalls": None, "f": [], "_src": None}


# ------------------------------------------------------------------ sources
def osm_places(elements):
    places = []
    for el in elements:
        t = el.get("tags", {})
        name = (t.get("name:en") or t.get("name") or "").strip()
        lat, lon = latlon(el)
        if not name or lat is None or lon is None:
            continue
        amenity = t.get("amenity")
        cz, cr, mixed, source = classify(name, t.get("cuisine"), amenity)
        places.append({
            "id": f"{el['type'][0]}{el['id']}", "name": name, "type": amenity,
            "cuisine": (t.get("cuisine") or "").replace("_", " ").replace(";", ", ") or None,
            "lat": round(lat, 5), "lon": round(lon, 5),
            "halal": t.get("diet:halal"), "veg": t.get("diet:vegetarian"),
            "street": t.get("addr:street"), "postcode": t.get("addr:postcode"),
            "hours": t.get("opening_hours"),
            "cz": cz, "cr": cr, "mix": mixed, "addr": None, "stalls": None, "f": [], "_src": source,
        })
    return places


def merge_nea(places, centres):
    grid = Grid(places)
    added = matched = 0
    for c in centres:
        hit = next((p for p in grid.near(c["lat"], c["lon"], 150)
                    if p["mix"] or similar(p["name"], c["name"])), None)
        if hit:
            hit["stalls"] = c["stalls"]
            hit["mix"] = True
            hit["addr"] = hit["addr"] or c["addr"]
            matched += 1
        else:
            pid = "h" + hashlib.md5(c["name"].encode()).hexdigest()[:8]
            p = new_place(pid, c["name"], "food_court", c["lat"], c["lon"], c["addr"], c["postcode"])
            p["mix"], p["stalls"] = True, c["stalls"]
            places.append(p)
            grid.add(p)
            added += 1
    return matched, added


def merge_listed(places, listed, geocoder):
    """Attach listed places (data/manual/) to existing places, or add new ones. Returns counts."""
    # 1) group mentions of the same stall (same postal code + similar name)
    groups = []
    by_postal = defaultdict(list)
    for b in listed:
        bucket = by_postal[b["postcode"]]
        g = next((g for g in bucket if similar(g["name"], b["name"])), None)
        if g:
            g["mentions"].append(b)
        else:
            g = {"name": b["name"], "postcode": b["postcode"], "address": b["address"], "mentions": [b]}
            bucket.append(g)
            groups.append(g)

    grid = Grid(places)
    stats = Counter()
    for g in groups:
        pos = geocoder.postal(g["postcode"])
        if not pos:
            stats["no_location"] += 1
            continue
        lat, lon = pos
        feats = sorted({(m["site"], m["url"], (m.get("date") or "")[:4]) for m in g["mentions"]},
                       key=lambda x: x[2], reverse=True)[:3]
        hit = next((p for p in grid.near(lat, lon, 80) if similar(p["name"], g["name"])), None)
        if hit:
            known = {f[1] for f in hit["f"]}
            hit["f"] += [list(f) for f in feats if f[1] not in known]
            hit["addr"] = hit["addr"] or g["address"]
            stats["matched"] += 1
        else:
            amenity = "stall" if HAWKER_ADDR.search(g["address"] or "") else "restaurant"
            pid = "b" + hashlib.md5(f"{g['name']}|{g['postcode']}".encode()).hexdigest()[:10]
            p = new_place(pid, g["name"], amenity, lat, lon, g["address"], g["postcode"])
            p["mix"] = False  # a single stall, even if it's inside a hawker centre
            p["f"] = [list(f) for f in feats]
            places.append(p)
            grid.add(p)
            stats["added"] += 1
    return stats


MANUAL_DIR = pathlib.Path(__file__).resolve().parent.parent / "data" / "manual"
LIST_PAGES = {"SETHLUI.com": "https://sethlui.com/top-300-hawkers/"}


def manual_places():
    """Lists you drop into data/manual/*.json, e.g. sethlui-top300.json from the console snippet.

    Format: {"site": "SETHLUI.com", "fetched": "2026-11-03",
             "places": [{"name", "address", "postcode", "url"?}, ...]}
    """
    out = []
    for path in sorted(MANUAL_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except ValueError as e:
            print(f"    WARNING: {path.name} is not valid JSON ({e}); skipped.")
            continue
        site = data.get("site") or path.stem
        for p in data.get("places", []):
            code = p.get("postcode") or (re.findall(r"(?<!\d)(\d{6})(?!\d)", p.get("address") or "") or [None])[-1]
            if not p.get("name") or not code:
                continue
            out.append({"name": p["name"].strip(), "address": p.get("address"), "postcode": code, "site": site,
                        "url": p.get("url") or LIST_PAGES.get(site) or "", "date": data.get("fetched")})
    return out


# ------------------------------------------------------------------ output
def to_rows(places):
    rows = []
    for p in sorted(places, key=lambda p: p["id"]):
        rows.append([p["id"], p["name"], p["type"], p["cuisine"], p["lat"], p["lon"], p["halal"], p["veg"],
                     p["street"], p["postcode"], p["hours"], ",".join(p["cz"]) or None,
                     ",".join(p["cr"]) or None, 1 if p["mix"] else 0, p["addr"], p["stalls"],
                     p["f"] or None])
    return rows


def print_coverage(places):
    n = len(places) or 1
    pct = lambda x: f"{100 * x / n:4.1f}%"
    mixed = sum(p["mix"] for p in places)
    none = sum(1 for p in places if not p["mix"] and not p["cz"])
    by_tag, by_name, crav = Counter(), Counter(), Counter()
    for p in places:
        for c in p["cz"]:
            (by_tag if p["_src"] == "tag" else by_name)[c] += 1
        for c in p["cr"]:
            crav[c] += 1
    print("\n=== Filter coverage report ===")
    print(f"Food places (all sources):    {len(places)}")
    print(f"Many-stall places (match all): {mixed} ({pct(mixed)})")
    print(f"No cuisine found:             {none} ({pct(none)})  <- hidden when a cuisine filter is on")
    print("\nCuisine          from tag  from name   total")
    for code, label in CUISINE_LABELS.items():
        print(f"  {label:<18}{by_tag[code]:>6}{by_name[code]:>10}{by_tag[code] + by_name[code]:>9}")
    print("\nCraving")
    for code, label in CRAVING_LABELS.items():
        print(f"  {label:<18}{crav[code]:>6}")
    print()


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
        if len(pts) > ROAD_MAX_POINTS:
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


# ------------------------------------------------------------------ main
def main():
    today = time.strftime("%Y-%m-%d")

    print("1/4 Downloading food places from OpenStreetMap...")
    places = osm_places(overpass(PLACES_QUERY))
    print(f"    {len(places)} named food places.")
    if len(places) < MIN_PLACES:
        sys.exit(f"Only {len(places)} places - looks wrong, not overwriting data.")

    print("2/4 Adding NEA hawker centres (data.gov.sg)...")
    try:
        matched, added = merge_nea(places, nea.fetch())
        print(f"    {matched} matched existing places, {added} added.")
    except Exception as e:  # noqa: BLE001
        print(f"    WARNING: NEA download failed ({e}); continuing without it.")

    print("3/4 Hand-made lists (data/manual/)...")
    imported = manual_places()
    if imported:
        geocoder = Geocoder()
        stats = merge_listed(places, imported, geocoder)
        geocoder.save()
        print(f"    {len(imported)} listed: {stats['added']} added, {stats['matched']} matched existing places, "
              f"{stats['no_location']} skipped (postal code not found).")
    else:
        print("    none.")

    print_coverage(places)
    write("places.json", {"updated": today,
                          "source": "© OpenStreetMap contributors (ODbL); NEA via data.gov.sg",
                          "fields": PLACE_FIELDS, "places": to_rows(places)})

    # The app classifies Google places in the browser with the same keyword lists.
    write("classify.json", {"cuisine": CUISINE_NAMES, "craving": CRAVING_NAMES, "mixed": MIXED_NAMES.pattern})

    print("4/4 Downloading road names...")
    time.sleep(5)
    try:
        roads = build_roads(overpass(ROADS_QUERY))
        print(f"    {len(roads)} road names.")
        if len(roads) < MIN_ROADS:
            raise RuntimeError(f"only {len(roads)} roads")
        write("roads.json", {"updated": today, "source": "© OpenStreetMap contributors (ODbL)", "roads": roads})
    except Exception as e:  # noqa: BLE001
        print(f"    WARNING: road download failed ({e}); keeping the previous roads.json.")


if __name__ == "__main__":
    main()
