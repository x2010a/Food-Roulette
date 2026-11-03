"""
Turn Singapore postal codes into coordinates with OneMap (Singapore Land Authority).
Results are cached in data/geocode_cache.json so each postal code is looked up once.
"""
import json
import pathlib
import time

import requests

CACHE_PATH = pathlib.Path(__file__).resolve().parent.parent / "data" / "geocode_cache.json"
URL = "https://www.onemap.gov.sg/api/common/elastic/search"
HEADERS = {"User-Agent": "food-roulette-data-refresh/1.0"}


class Geocoder:
    def __init__(self):
        try:
            self.cache = json.loads(CACHE_PATH.read_text())
        except (OSError, ValueError):
            self.cache = {}
        self.lookups = 0

    def postal(self, code):
        """Return (lat, lon) for a 6-digit postal code, or None."""
        if code in self.cache:
            hit = self.cache[code]
            return tuple(hit) if hit else None
        try:
            r = requests.get(URL, params={"searchVal": code, "returnGeom": "Y",
                                          "getAddrDetails": "Y", "pageNum": 1},
                             headers=HEADERS, timeout=30)
            r.raise_for_status()
            results = r.json().get("results") or []
            match = next((x for x in results if x.get("POSTAL") == code), None)
            value = [round(float(match["LATITUDE"]), 5), round(float(match["LONGITUDE"]), 5)] if match else None
        except Exception as e:  # noqa: BLE001  network hiccup: don't cache, try next week
            print(f"    OneMap lookup failed for {code}: {e}")
            return None
        self.cache[code] = value
        self.lookups += 1
        time.sleep(0.3)  # stay well under OneMap's rate limit
        return tuple(value) if value else None

    def save(self):
        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        CACHE_PATH.write_text(json.dumps(self.cache, separators=(",", ":"), sort_keys=True))
