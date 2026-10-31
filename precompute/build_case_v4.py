#!/usr/bin/env python3
"""Build case v4 from the CALIBRATED GCOV pipeline (gcov_out.json).

The browse-era candidates are retired: in calibrated gamma-0, old CH-01
changed +0.74 dB (nothing) and old CH-03 -0.86 dB (nothing). The real signal
is the western channel-belt emergence (raw dHH +11..+14 dB). v4 candidates
are the frozen 12-setting dB ensemble's top-3 robust clusters.
"""
import json, math, os
import numpy as np
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location("pc", os.path.join(HERE, "precompute.py"))
pc = importlib.util.module_from_spec(spec); spec.loader.exec_module(pc)
from PIL import Image
ref = np.asarray(Image.open(os.path.join(HERE, "nisar_browse", "20261013_J_001_LATLON.png"))).astype(np.float32)
pc.REF_STATS["p2"], pc.REF_STATS["p98"] = np.percentile(ref[:, :, 0][ref[:, :, 0] > 0], [2, 98])

gcov = json.load(open(os.path.join(HERE, "gcov_out.json")))
case = json.load(open(os.path.join(ROOT, "public", "data", "case.json")))
manifest = json.load(open(os.path.join(ROOT, "public", "data", "manifest.json")))

# browse series for the NEW cores
samples = {d: pc.sample_aoi(d) for d in pc.DATES}
H, W = samples[pc.DATES[0]][0].shape
import cv2
def raster(ring):
    m = np.zeros((H, W), np.uint8)
    pts = np.array([[(lon - pc.AOI[0]) / pc.STEP, (pc.AOI[3] - lat) / pc.STEP] for lon, lat in ring], np.int32)
    cv2.fillPoly(m, [pts], 1)
    return m.astype(bool)

CHIL = (89.70, 25.57)
def dist_km(lon, lat):
    from math import radians, sin, cos, asin, sqrt
    dLa, dLo = radians(lat - CHIL[1]), radians(lon - CHIL[0])
    a = sin(dLa / 2) ** 2 + cos(radians(CHIL[1])) * cos(radians(lat)) * sin(dLo / 2) ** 2
    return round(2 * 6371 * asin(sqrt(a)), 1)

TITLES = {
    "CH-01": ("Western channel belt — south reach", "In July this ground returned almost no radar signal — open water. By October it is among the brightest ground in the case. Emerged char, new crop, or settlement edge?"),
    "CH-02": ("Western channel belt — north reach", "Open water here in July; bright, rough ground by October while the river fell. Sandbar surface, ploughed char, or homesteads moving in?"),
    "CH-03": ("Western channel belt — mid reach", "The radar saw water in July and dry bright ground in October. What is standing on it now?"),
}
cands = []
for gc in gcov["candidates"]:
    cid = gc["id"]
    core_b = raster(gc["core"])
    hh_s, hv_s = [], []
    for d in pc.DATES:
        hh, hv, nd, t = samples[d]
        hh_s.append(round(float(hh[core_b].mean()), 1))
        hv_s.append(None if d == "2026-09-07" else round(float(hv[core_b].mean()), 1))
    title, q = TITLES[cid]
    cal = gc["calibrated"]
    cands.append({
        "id": cid, "title": title, "question": q,
        "centroid": gc["centroid"], "distanceKm": dist_km(*gc["centroid"]),
        "robustPx": gc["robustPxNative"], "fringePx": gc["fringePxNative"],
        "areaHa": gc["totalAreaHa"], "robustAreaHa": gc["robustAreaHa"],
        "core": gc["core"], "fringe": gc["fringeRing"], "ghost": [],
        "hhIntensity": hh_s, "hvIntensity": hv_s,
        "meanDelta": cal["dDbHH"], "direction": "brighter in calibrated HH gamma-0",
        "provenance": "MEASURED", "status": "NEEDS_EYES",
        "calibrated": cal,
    })
    print(cid, gc["centroid"], gc["robustAreaHa"], "ha, dHH", cal["dDbHH"], "dB, series0", hh_s[0], "->", hh_s[-1])

case["candidates"] = cands
case["walkGrid"] = {"date": "2026-10-13", "layer": "NISAR HH gamma-0 (calibrated, dB)",
                    "unit": "dB", "values": gcov["walkGridDb"]}
case["thresholdNote"] = ("Calibrated pipeline: gamma-0 from GCOV float (pair granules), dB, "
                         "12-setting ensemble on the native 20 m grid (thresholds 3/4.5/6 dB x median 3/5 x MMU 100/350 px), "
                         "pair delta referenced to a stable east-farmland control patch (seasonal shift removed). "
                         "Robust = persists in all 12 settings — a robustness measure, not a probability.")
case["pair"] = ["2026-07-09", "2026-10-13"]
import hashlib
case["caseHash"] = hashlib.sha256(json.dumps(case, sort_keys=True).encode()).hexdigest()[:16]
json.dump(case, open(os.path.join(ROOT, "public", "data", "case.json"), "w"), indent=1)

manifest["methodV4"] = {
    "pipeline": "calibrated GCOV gamma-0 (float .h5 via Earthdata), dB ensemble, native 20 m grid",
    "controlPatchShiftDb": gcov["controlPatch"],
    "retired": "Browse-era candidates retired 2026-10-31: old CH-01 calibrated dHH +0.74 dB and old CH-03 -0.86 dB (no real NISAR change; browse-render artefacts). Old CH-02 region confirmed and refined (raw dHH +4.6 dB area mean; robust cores +12..+14 dB).",
    "note": "Pair-date map scenes are calibrated dB renders; other dates remain browse renders. Ghost outlines pending recompute for calibrated cores.",
}
manifest["manifestHash"] = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()[:16]
json.dump(manifest, open(os.path.join(ROOT, "public", "data", "manifest.json"), "w"), indent=1)

# scenes: swap pair dates to calibrated renders
scenes = json.load(open(os.path.join(ROOT, "public", "data", "scenes.json")))
for d, uri in gcov["scenesDb"].items():
    scenes[d] = uri
json.dump(scenes, open(os.path.join(ROOT, "public", "data", "scenes.json"), "w"))
print("case v4 written (crosschecks + exposure + ghosts still to refresh)")
