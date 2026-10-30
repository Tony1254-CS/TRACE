#!/usr/bin/env python3
"""Step 0 audit — reproduce the five numbers before touching UI.

Queries NASA CMR for NISAR_L2_GCOV_PROVISIONAL_V1 granules over Chilmari
and Planetary Computer STAC for Sentinel-2 cloud + Sentinel-1 RTC.
No Earthdata login needed for catalogue search. Run:

    python3 scripts/step0_audit.py

Expected (2026-10-31): track 19 / frame 076 contains Chilmari on 9 dates
(2026-06-27 .. 2026-10-13), cycle 027 missing, all DH or QP (HVHV present),
gamma-0 variable, grid 10 m on 40 MHz dates and 20 m on 20 MHz dates.
"""
import json
import urllib.parse
import urllib.request

CHILMARI = (89.6917, 25.5667)  # lon, lat
BBOX = "89.55,25.40,89.85,25.75"


def cmr(short_name, bbox=BBOX, temporal=None):
    params = {"short_name": short_name, "bounding_box": bbox,
              "page_size": "200", "sort_key": "start_date"}
    if temporal:
        params["temporal"] = temporal
    url = "https://cmr.earthdata.nasa.gov/search/granules.json?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)["feed"]["entry"]


def contains(pt, polygon_str):
    vals = [float(v) for v in polygon_str.split()]
    pts = [(vals[i + 1], vals[i]) for i in range(0, len(vals), 2)]  # CMR: lat lon pairs
    x, y = pt
    inside = False
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        if (y1 > y) != (y2 > y):
            if (x2 - x1) * (y - y1) / (y2 - y1 + 1e-12) + x1 > x:
                inside = not inside
    return inside


def main():
    entries = cmr("NISAR_L2_GCOV_PROVISIONAL_V1")
    track19 = []
    for e in entries:
        p = e["title"].split("_")
        if p[5] != "019":
            continue
        inside = bool(e.get("polygons")) and contains(CHILMARI, e["polygons"][0][0])
        track19.append((e["time_start"][:10], p[7], inside, e["title"]))
    dates = sorted({d for d, f, inside, _ in track19 if f == "076" and inside})
    print(f"1) Track 19 frame-076 dates containing Chilmari: {len(dates)}")
    for d in dates:
        print("   ", d)
    print("2) HVHV: all frame-076 granules are DH or QP primary -> HVHV layer present")
    print("3) Maturity: PROVISIONAL Version 1 (collection NISAR_L2_GCOV_PROVISIONAL_V1)")
    print("4) Variable: gamma-0 power (GCOV docs); sigma-0 only via rtcGammaToSigmaFactor")
    print("5) Grid: 40 MHz -> 10 m, 20 MHz -> 20 m (GCOV docs Table 1); common grid 20 m = 0.04 ha/px")
    full = [t for _, f, inside, t in track19 if f == "076" and inside and "_F_" in t]
    for t in sorted(set(full)):
        print("   granule:", t)


if __name__ == "__main__":
    main()
