#!/usr/bin/env python3
"""Independent crosschecks of the NISAR candidates (all public, no login).

1. Sentinel-1 RTC (C-band, ASF processing, Planetary Computer COGs):
   per-candidate mean VV gamma-0 (dB) on the S1 dates nearest the NISAR
   pair, plus the fraction of core pixels darker than -17 dB (smooth /
   water-like at C-band VV) on each date.
2. Sentinel-2 L2A NDWI (optical) on the two clearest dates
   (2026-07-04, 14.8% cloud; 2026-10-12, 0.0% cloud): per-candidate
   fraction of pixels with NDWI > 0 (open-water-like).
A crosscheck AGREES when the sign of the S1 dark-fraction change matches
the NISAR direction story (NISAR brighter -> less water-like).
Writes crosscheck_out.json, merged into case.json by build_case_v3.py.
"""
import json

import urllib.request
import numpy as np
import rasterio
from rasterio.features import geometry_mask
from rasterio.windows import from_bounds
from rasterio.warp import transform as warp_transform
from rasterio.warp import transform_bounds
from shapely.geometry import Polygon

STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
AOI = (89.58, 25.44, 89.82, 25.70)
CASE = json.load(open("../public/data/case.json"))


def _get_json(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)


def sign(collection, href):
    tok = _get_json(f"https://planetarycomputer.microsoft.com/api/sas/v1/token/{collection}")["token"]
    return f"{href}?{tok}"


def search(collection, dt):
    body = json.dumps({"collections": [collection], "bbox": list(AOI), "datetime": dt, "limit": 20}).encode()
    req = urllib.request.Request(STAC, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)["features"]


def read_window(href, collection):
    url = sign(collection, href)
    with rasterio.Env(GDAL_HTTP_UNSAFESSL="YES"), rasterio.open(url) as ds:
        bounds = transform_bounds("EPSG:4326", ds.crs, *AOI)
        win = from_bounds(*bounds, transform=ds.transform)
        arr = ds.read(1, window=win).astype(np.float32)
        transform = ds.window_transform(win)
        return arr, transform, arr.shape, str(ds.crs)


def core_mask(shape, transform, poly_ll, crs):
    xs, ys = warp_transform("EPSG:4326", crs, [p[0] for p in poly_ll], [p[1] for p in poly_ll])
    geom = Polygon(zip(xs, ys))
    return geometry_mask([geom], out_shape=shape, transform=transform, invert=True,
                         all_touched=False)


def main():
    out = {"sentinel1": {}, "sentinel2": {}}
    # ---- Sentinel-1 RTC: same relative orbit on both sides of the pair ----
    # (A broad search paginates and can hand back a same-date segment from
    # the wrong footprint - caught live: NaNs for 2026-07-13. Query each
    # window separately and lock the orbit.)
    def window_items(lo, hi):
        feats = search("sentinel-1-rtc", f"{lo}/{hi}")
        by_orbit = {}
        for f in feats:
            orb = f["properties"].get("sat:relative_orbit")
            by_orbit.setdefault(orb, []).append(f)
        return by_orbit
    wa = window_items("2026-07-08", "2026-07-17")
    wb = window_items("2026-10-02", "2026-10-13")
    common = set(wa) & set(wb)
    print("S1 orbits in windows:", {k: len(v) for k, v in wa.items()}, {k: len(v) for k, v in wb.items()}, "common:", common)
    orbit = sorted(common)[0]
    fa = min(wa[orbit], key=lambda f: abs(np.datetime64(f["properties"]["datetime"][:10]) - np.datetime64("2026-07-09")))
    fb = min(wb[orbit], key=lambda f: abs(np.datetime64(f["properties"]["datetime"][:10]) - np.datetime64("2026-10-13")))
    d_a, d_b = fa["properties"]["datetime"][:10], fb["properties"]["datetime"][:10]
    print("S1 pair:", d_a, d_b, "orbit", orbit)
    vv = {}
    for tag, f in (("a", fa), ("b", fb)):
        d = f["properties"]["datetime"][:10]
        href = f["assets"]["vv"]["href"]
        arr, tr, shape, crs1 = read_window(href, "sentinel-1-rtc")
        db = 10 * np.log10(np.clip(arr, 1e-5, None))
        vv[tag] = (db, tr, shape, d, f["id"])
        vv["crs"] = crs1
    for cand in CASE["candidates"]:
        row = {}
        for tag in ("a", "b"):
            db, tr, shape, d, _id = vv[tag]
            m = core_mask(shape, tr, cand["core"], vv["crs"])
            sel = db[m]
            sel = sel[np.isfinite(sel)]
            row[f"vvDb_{tag}"] = round(float(sel.mean()), 2)
            row[f"darkFrac_{tag}"] = round(float((sel < -17).mean()), 3)
            row[f"date_{tag}"] = d
        s1_dark_change = row["darkFrac_b"] - row["darkFrac_a"]
        # NISAR brighter (land emergence) should show dark fraction falling.
        agree = (s1_dark_change < -0.02) if cand["direction"] == "brighter" else (s1_dark_change > 0.02)
        row["s1Agrees"] = bool(agree)
        row["s1DarkChange"] = round(s1_dark_change, 3)
        out["sentinel1"][cand["id"]] = row
        print(cand["id"], row)

    # ---- Sentinel-2 NDWI on the clear dates ----
    for tag, target in (("jul", "2026-07-04"), ("oct", "2026-10-12")):
        feats = search("sentinel-2-l2a", f"{target}T00:00:00Z/{target}T23:59:59Z")
        f = feats[0]
        b03, _, _, _c = read_window(f["assets"]["B03"]["href"], "sentinel-2-l2a")
        b08, tr, shape, crs2 = read_window(f["assets"]["B08"]["href"], "sentinel-2-l2a")
        s2crs = crs2
        g, n = b03.astype(np.float32), b08.astype(np.float32)
        ndwi = (g - n) / np.clip(g + n, 1, None)
        for cand in CASE["candidates"]:
            m = core_mask(shape, tr, cand["core"], vv["crs"])
            frac = round(float((ndwi[m] > 0).mean()), 3)
            out["sentinel2"].setdefault(cand["id"], {})[f"ndwiWaterFrac_{tag}"] = frac
            out["sentinel2"][cand["id"]][f"date_{tag}"] = target
        print("S2", target, "done", f["id"])
    json.dump(out, open("crosscheck_out.json", "w"), indent=1)
    print("wrote crosscheck_out.json")


if __name__ == "__main__":
    main()
