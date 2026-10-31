#!/usr/bin/env python3
"""v4b merge: ghosts (July water outline), OSM + WorldPop exposure, S1/S2
crosschecks with honest readings, updated Place Watch. Run after v4."""
import json, os, urllib.request, urllib.parse
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
case = json.load(open(os.path.join(ROOT, "public/data/case.json")))
manifest = json.load(open(os.path.join(ROOT, "public/data/manifest.json")))

# ---- ghosts from calibrated July grid: water-like (HH < -20 dB) inside fringe
g = {"__file__": os.path.join(HERE, "gcov_process.py")}
exec(open(os.path.join(HERE, "gcov_process.py")).read().replace('if __name__ == "__main__":\n    main()', ''), g)
A = g["load"]("2026-07-09")
hhA = g["to_db"](A["HHHH"], A["mask"])
from pyproj import Transformer
import cv2
t = Transformer.from_crs("EPSG:4326", f"EPSG:{A['epsg']}", always_xy=True)
tb = Transformer.from_crs(f"EPSG:{A['epsg']}", "EPSG:4326", always_xy=True)
xs, ys = A["xs"], A["ys"]
def raster_native(ring):
    m = np.zeros(hhA.shape, np.uint8)
    pts = []
    for lon, lat in ring:
        X, Y = t.transform(lon, lat)
        xi = int(np.searchsorted(xs, X)); yi = int(np.searchsorted(ys, Y)) if ys[0] < ys[-1] else int(np.searchsorted(-ys, -Y))
        pts.append([xi, yi])
    cv2.fillPoly(m, [np.array(pts, np.int32)], 1)
    return m.astype(bool)
def ring_of(mask, ds=4):
    small = mask[::ds, ::ds].astype(np.uint8)
    cnts, _ = cv2.findContours(small, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts: return []
    c = max(cnts, key=cv2.contourArea).reshape(-1, 2)
    pts = []
    for px, py in c[:: max(1, len(c) // 60)]:
        lon, lat = tb.transform(float(xs[min(px * ds, len(xs) - 1)]), float(ys[min(py * ds, len(ys) - 1)]))
        pts.append([round(float(lon), 5), round(float(lat), 5)])
    return pts
for c in case["candidates"]:
    region = raster_native(c["fringe"])
    water_jul = region & (hhA < -20)
    c["ghost"] = ring_of(water_jul)
    print(c["id"], "ghost pts:", len(c["ghost"]), "july-water px in fringe:", int(water_jul.sum()))

# ---- OSM buildings within 1 km of new centroids
def overpass(q):
    req = urllib.request.Request("https://overpass-api.de/api/interpreter",
                                 data=urllib.parse.urlencode({"data": q}).encode(),
                                 headers={"User-Agent": "trace-field/4.0"})
    return json.load(urllib.request.urlopen(req, timeout=120))
buildings = {}
for c in case["candidates"]:
    lon, lat = c["centroid"]
    r = overpass(f'[out:json][timeout:60];way["building"](around:1000,{lat},{lon});out count;')
    buildings[c["id"]] = int(r["elements"][0]["tags"]["total"]) if r["elements"] else 0
    print("OSM buildings", c["id"], buildings[c["id"]])
wp = json.load(open(os.path.join(HERE, "worldpop_out.json")))
manifest["exposure"] = {"buildingsWithin1km": buildings,
                        "namedSettlementsInAOI": manifest.get("exposure", {}).get("namedSettlementsInAOI", 28),
                        "note": "OSM counts are a floor, not a census (mapping completeness varies). © OpenStreetMap contributors, ODbL."}
manifest["exposureWorldPop"] = {"source": "WorldPop Bangladesh 2020 (Global_2000_2020)",
                                "population": {k: {"core": v["core"], "corePlusFringe": v["corePlusFringe"]} for k, v in wp.items()}}

# ---- crosschecks
xc = json.load(open(os.path.join(HERE, "crosscheck_out.json")))
READINGS = {
    "CH-01": "C-band backs the emergence: Sentinel-1's water-like (dark) fraction inside this core fell from 0.42 to 0.00 and VV rose from -15.8 to -10.0 dB. But optical NDWI saw no open water here on either clear date — so July's radar-dark surface may have been smooth wet mud or shallow turbid water, not deep open water. The field question is what replaced it.",
    "CH-02": "Sentinel-1's dark fraction fell from 0.09 to 0.01 and optical saw no open water on either clear date. Consistent with a wet surface drying and roughening as the river fell — not a lake draining. What the surface is now is exactly what a person standing on it can say.",
    "CH-03": "Sentinel-1's dark fraction fell from 0.19 to 0.00 (VV -13.8 to -11.3 dB); optical saw no open water on either clear date. Two independent sensors agree this ground emerged or dried between July and October. What grew, cracked or was built on it is the open question.",
}
for c in case["candidates"]:
    s1, s2 = xc["sentinel1"][c["id"]], xc["sentinel2"][c["id"]]
    c["crosscheck"] = {
        "s1": {"vvDbA": s1["vvDb_a"], "vvDbB": s1["vvDb_b"], "darkFracA": s1["darkFrac_a"], "darkFracB": s1["darkFrac_b"], "dateA": s1["date_a"], "dateB": s1["date_b"]},
        "s2": {"ndwiWaterFracJul": s2["ndwiWaterFrac_jul"], "ndwiWaterFracOct": s2["ndwiWaterFrac_oct"], "dateJul": s2["date_jul"], "dateOct": s2["date_oct"]},
        "reading": READINGS[c["id"]],
    }
    c["provenance"] = "CROSSCHECKED"
manifest["methodV4"]["ghosts"] = "Ghost outline = July open-water extent (calibrated HH < -20 dB) inside each candidate fringe."
manifest["methodV4"].pop("note", None)

# ---- Place Watch: emergence story
case["placeWatch"] = {
    "bn": "স্যাটেলাইট বলছে: জুলাইয়ে যমুনার পশ্চিম পাড়ের এই অংশটা ছিল পানির নিচে বা ভেজা মসৃণ মাটি। অক্টোবরে নদীর পানি কমতেই তিনটি বড় জায়গায় শুকনো, খসখসে মাটি বেরিয়ে এসেছে। সেখানে এখন কী আছে — নতুন চর, ফসল, নাকি মানুষের বসতি — সেটা আপনার চোখে দেখে বলতে হবে। পরের ছবি আসবে 25 October 2026-এ।",
    "en": "The satellite says: in July this western-bank reach was under water or smooth wet ground. As the river fell, three large patches emerged bright and rough by October. What is on them now — new char, crops, or homes — is for your eyes to answer. Next picture arrives 25 October 2026.",
}
import hashlib
case["caseHash"] = hashlib.sha256(json.dumps(case, sort_keys=True).encode()).hexdigest()[:16]
manifest["manifestHash"] = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()[:16]
json.dump(case, open(os.path.join(ROOT, "public/data/case.json"), "w"), indent=1)
json.dump(manifest, open(os.path.join(ROOT, "public/data/manifest.json"), "w"), indent=1)
print("v4b merged")
