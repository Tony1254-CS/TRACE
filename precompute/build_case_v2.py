#!/usr/bin/env python3
"""Build case.json / manifest.json v2 from real precompute outputs."""
import hashlib
import json
import math
import os

PRE = json.load(open(os.path.join(os.path.dirname(__file__), "precompute_out.json")))
RAIN = json.load(open("/tmp/power_rain.json"))          # NASA POWER PRECTOTCORR, Chilmari point
GLO = json.load(open("/tmp/glofas.json"))               # Open-Meteo Flood API (GloFAS), Chilmari point
EXPO_PATH = "/tmp/osm_exposure.json"
EXPO = json.load(open(EXPO_PATH)) if os.path.exists(EXPO_PATH) else None

DATES = ["2026-06-27", "2026-07-09", "2026-07-21", "2026-08-14", "2026-08-26",
         "2026-09-07", "2026-09-19", "2026-10-01", "2026-10-13"]
SITE = (25.5667, 89.6917)


def hav(lat, lon):
    r = math.pi / 180
    dlat = (lat - SITE[0]) * r
    dlon = (lon - SITE[1]) * r
    s = math.sin(dlat / 2) ** 2 + math.cos(SITE[0] * r) * math.cos(lat * r) * math.sin(dlon / 2) ** 2
    return round(2 * 6371 * math.asin(math.sqrt(s)), 1)


META = {
    1: ("Far east bank", "This ground went dark as the river rose in July, then came back bright and stayed bright. What is there now — crop, sand, or the edge of a settlement?"),
    2: ("North-west channel char", "Open water here in June and July; by October it is the brightest ground in the whole case. New sandbar, or land that dried and cracked?"),
    3: ("North-east low ground", "Everything around it dried as the river fell — this patch went the other way and got darker. Standing water left behind, or low wet land?"),
}

cands = []
for c in PRE["candidates"]:
    title, question = META[c["rank"]]
    lat, lon = c["centroid"][1], c["centroid"][0]
    cands.append({
        "id": f"CH-0{c['rank']}", "title": title, "question": question,
        "centroid": c["centroid"], "distanceKm": hav(lat, lon),
        "robustPx": c["corePx"], "fringePx": c["fringePx"],
        "areaHa": round((c["corePx"] + c["fringePx"]) * PRE["pxHa"], 1),
        "robustAreaHa": round(c["corePx"] * PRE["pxHa"], 1),
        "core": c["core"], "fringe": c["fringe"], "ghost": c["ghost"],
        "hhIntensity": c["hhIntensity"], "hvIntensity": c["hvIntensity"],
        "meanDelta": c["meanDelta"], "direction": c["direction"],
        "provenance": "DERIVED", "status": "awaiting-observation",
    })

rain_by_date = {}
for d in DATES:
    lo = d.replace("-", "")
    rain_by_date[d] = None
discharge = {}
for d in DATES:
    i = GLO["time"].index(d)
    discharge[d] = round(GLO["discharge"][i])
rain_windows = {}
for a, b in [("20260627", "20260709"), ("20260710", "20260814"), ("20260815", "20260919"), ("20260920", "20261013")]:
    rain_windows[f"{a[:4]}-{a[4:6]}-{a[6:]}->{b[:4]}-{b[4:6]}-{b[6:]}"] = round(
        sum(v for k, v in RAIN.items() if a <= k <= b), 1)
rain_pair_total = round(sum(v for k, v in RAIN.items() if "20260709" <= k <= "20261013"), 1)

manifest = json.load(open(os.path.join(os.path.dirname(__file__), "..", "public", "data", "manifest.json")))
manifest["generated"] = "2026-10-31 v2"
manifest["method"] = ("Browse-derived: ASF LATLON browse (HH/HV/HH composite, R==B verified, "
                      "R~HHHH r=0.86, G~HVHV r=0.85), full-frame percentile harmonisation, "
                      "ensemble of 12 settings (3 thresholds x 2 median windows x 2 MMU). "
                      "Robust = change in all 12, fringe = change in some. "
                      "Calibrated GCOV float processing is gated on an Earthdata login (h5 returns 401).")
manifest["browseGrid"] = {"stepDeg": PRE["stepDeg"], "haPerPixel": PRE["pxHa"],
                          "note": "Areas are computed on the ~50 m browse grid, not the 20 m native GCOV grid."}
manifest["qaFlags"] = [
    "2026-09-07 HVHV browse is black over the whole AOI (mean 1.0) - defective render, HV excluded for that date; HH unaffected.",
    "40 MHz dates (2026-07-21, 2026-08-14) render with different texture - used in the series, never as a change-pair anchor.",
    "One top cluster was rejected: nodata-black in July, data in October (coverage artefact at the AOI edge).",
    "Stable-land control patch (east farmland) varies 116-138 intensity across the 9 dates after harmonisation.",
]
manifest["drivers"] = {
    "dischargeM3sByDate": discharge, "dischargeSource": "GloFAS river discharge via Open-Meteo Flood API, Chilmari point",
    "rainMmWindows": rain_windows, "rainPairTotalMm": rain_pair_total, "rainSource": "NASA POWER PRECTOTCORR daily, Chilmari point",
    "stageSource": "BWDB/FFWC Chilmari gauge has no public API found 2026-10-31; GloFAS discharge used as the hydrological driver, labelled as such.",
}
manifest["exposure"] = EXPO if EXPO else {"osm": "UNVERIFIED - Overpass query pending"}
manifest["manifestHash"] = "sha256:" + hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()

case = {
    "caseId": manifest["caseId"], "site": manifest["site"], "track": 19, "frame": 76,
    "dates": DATES, "pair": ["2026-07-09", "2026-10-13"],
    "thresholdNote": ("Candidate = robust change in HH browse intensity between the pair dates under an ensemble of "
                      "12 settings (thresholds 0.16/0.22/0.30 normalised, median windows 3/5, MMU 20/60 px). "
                      "Agreement across settings is a robustness measure, not a probability."),
    "candidates": cands,
    "drivers": manifest["drivers"],
    "sensorRace": {"opticalClear": 5, "opticalTotal": 49, "nisarSeen": 9, "nisarTotal": 9, "s1Dates": 18},
    "placeWatch": {"bn": "এই জায়গায় স্যাটেলাইটের সংকেত পানির উপস্থিতির সঙ্গে সামঞ্জস্যপূর্ণ — তবে এটি নিশ্চিত প্রমাণ নয়।",
                   "en": "At this place, the satellite signal is consistent with water being present — it is not proof on its own."},
    "walkGrid": {**PRE["walkGrid"], "date": f"{PRE['walkGrid']['date'][:4]}-{PRE['walkGrid']['date'][4:6]}-{PRE['walkGrid']['date'][6:]}"},
    "manifestHash": manifest["manifestHash"],
}
case["caseHash"] = "sha256:" + hashlib.sha256(json.dumps(case, sort_keys=True).encode()).hexdigest()

root = os.path.join(os.path.dirname(__file__), "..", "public", "data")
json.dump(manifest, open(os.path.join(root, "manifest.json"), "w"), indent=1)
json.dump(case, open(os.path.join(root, "case.json"), "w"), indent=1)
print("candidates:", [(c["id"], c["areaHa"], c["distanceKm"]) for c in cands])
print("discharge:", discharge)
print("rain windows:", rain_windows)
print("exposure:", EXPO)
