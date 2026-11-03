"""
NEA hawker centres from data.gov.sg (Open Data Licence).

Dataset: "Hawker Centres (GEOJSON)" by NEA
https://data.gov.sg/datasets/d_4a086da0a5553be1d89383cd90d07ecd/view
"""
import re
import time

import requests

DATASET_ID = "d_4a086da0a5553be1d89383cd90d07ecd"
API = "https://api-open.data.gov.sg/v1/public/api/datasets/" + DATASET_ID
HEADERS = {"User-Agent": "food-roulette-data-refresh/1.0"}


def _download_url():
    """data.gov.sg gives a temporary download link via poll-download."""
    for step in ("poll-download", "initiate-download", "poll-download", "poll-download"):
        r = requests.get(f"{API}/{step}", headers=HEADERS, timeout=60)
        if r.ok:
            url = (r.json().get("data") or {}).get("url")
            if url:
                return url
        time.sleep(3)
    raise RuntimeError("data.gov.sg did not return a download link")


def _props(feature):
    """Properties come either as plain keys or as an HTML table in 'Description'."""
    p = {k.upper(): v for k, v in (feature.get("properties") or {}).items()}
    desc = p.get("DESCRIPTION")
    if isinstance(desc, str) and "<th" in desc.lower():
        for k, v in re.findall(r"<th>\s*(.*?)\s*</th>\s*<td>\s*(.*?)\s*</td>", desc, re.I | re.S):
            # the table holds the real values; its NAME beats placeholders like "kml_1"
            p[k.strip().upper()] = re.sub(r"<[^>]+>", "", v).strip()
    return p


def parse(geojson):
    """Return a list of hawker centres: dicts with name, lat, lon, addr, postcode, stalls."""
    out = []
    for f in geojson.get("features", []):
        geom = f.get("geometry") or {}
        if geom.get("type") != "Point":
            continue
        lon, lat = geom["coordinates"][:2]
        p = _props(f)
        status = (p.get("STATUS") or "").lower()
        if status and "exist" not in status:
            continue  # skip ones under construction / closed
        name = (p.get("NAME") or "").strip()
        if not name:
            continue
        postcode = (p.get("ADDRESSPOSTALCODE") or "").strip() or None
        street = " ".join(x for x in [(p.get("ADDRESSBLOCKHOUSENUMBER") or "").strip(),
                                      (p.get("ADDRESSSTREETNAME") or "").strip()] if x)
        addr = ", ".join(x for x in [street, f"Singapore {postcode}" if postcode else ""] if x)
        try:
            stalls = int(float(p.get("NUMBER_OF_COOKED_FOOD_STALLS") or 0)) or None
        except ValueError:
            stalls = None
        out.append({"name": name, "lat": round(lat, 5), "lon": round(lon, 5),
                    "addr": addr or None, "postcode": postcode, "stalls": stalls})
    return out


def fetch():
    url = _download_url()
    r = requests.get(url, headers=HEADERS, timeout=120)
    r.raise_for_status()
    return parse(r.json())
