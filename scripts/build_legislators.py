"""Build data/legislators.json from the Open States roster of current Illinois legislators.

Run: python3 scripts/build_legislators.py
The weekly GitHub workflow runs this and commits any change, so the
"Find your legislators" lookup stays current after elections.
"""
import csv
import io
import json
import urllib.request
from datetime import date

SOURCE = "https://data.openstates.org/people/current/il.csv"
OUT = "data/legislators.json"


def ilga_link(links):
    urls = [u for u in links.split(";") if u]
    current = [u for u in urls if "/Members/Details/" in u]
    return (current or urls or [""])[-1]


def main():
    with urllib.request.urlopen(SOURCE, timeout=60) as r:
        rows = list(csv.DictReader(io.StringIO(r.read().decode("utf-8"))))
    out = {"source": SOURCE, "updated": date.today().isoformat(), "senate": {}, "house": {}}
    for p in rows:
        chamber = {"upper": "senate", "lower": "house"}.get(p["current_chamber"])
        if not chamber:
            continue
        out[chamber][p["current_district"]] = {
            "name": p["name"],
            "last": p["family_name"],
            "email": p["email"],
            "image": p["image"],
            "page": ilga_link(p["links"]),
            "springfield_phone": p["capitol_voice"],
            "district_phone": p["district_voice"],
            "district_office": p["district_address"],
        }
    if len(out["senate"]) != 59 or len(out["house"]) != 118:
        raise SystemExit(f"Unexpected roster size: {len(out['senate'])} senators, {len(out['house'])} representatives")
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")


if __name__ == "__main__":
    main()
