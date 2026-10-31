#!/usr/bin/env python3
"""Build case.json / manifest.json v3: v2 + independent crosschecks.

Crosschecks (precompute/crosscheck.py, all public data):
- Sentinel-1 RTC C-band VV gamma-0 (calibrated), same-orbit pair
  2026-07-13 -> 2026-10-05, per candidate core.
- Sentinel-2 NDWI water fraction on the two clear dates
  2026-07-04 and 2026-10-12, per candidate core.
The `reading` lines are written from those numbers, not generated
boilerplate - each states what the other two sensors actually saw.
JRC GSW: the public JEODPP mirror's MonthlyHistory ends at 2021, so no
2026 JRC monthly water is openly downloadable there; S2 NDWI fills the
optical crosscheck role and the manifest says so.
WorldPop: merged from /tmp/worldpop_out.json when present.
"""
import hashlib
import json
import os

HERE = os.path.dirname(__file__)
ROOT = os.path.join(HERE, "..", "public", "data")
XC = json.load(open(os.path.join(HERE, "crosscheck_out.json")))

READINGS = {
    "CH-01": ("Optical saw open water on 13% of this core on 4 Jul and almost none (0.5%) on 12 Oct; "
              "C-band called it land on both of its dates. Two independent sensors agree with the NISAR story: "
              "real July water, gone by October."),
    "CH-02": ("Optical saw no open water here on either clear date, and C-band agrees the ground emerged by October. "
              "So the July NISAR darkness was a smooth wet surface — flooded mud or wet sand — not a lake. "
              "The question below is the one a person on the ground can settle."),
    "CH-03": ("Optical water coverage grew from 28% to 43% between 4 Jul and 12 Oct, and C-band calls this "
              "ground water-like on both dates. The NISAR darkening is real: standing water expanded here "
              "while the river around it fell."),
}

case = json.load(open(os.path.join(ROOT, "case.json")))
manifest = json.load(open(os.path.join(ROOT, "manifest.json")))

for cand in case["candidates"]:
    s1 = XC["sentinel1"][cand["id"]]
    s2 = XC["sentinel2"][cand["id"]]
    cand["crosscheck"] = {
        "s1": {"vvDbA": s1["vvDb_a"], "vvDbB": s1["vvDb_b"], "darkFracA": s1["darkFrac_a"],
               "darkFracB": s1["darkFrac_b"], "dateA": s1["date_a"], "dateB": s1["date_b"]},
        "s2": {"ndwiWaterFracJul": s2["ndwiWaterFrac_jul"], "ndwiWaterFracOct": s2["ndwiWaterFrac_oct"]},
        "reading": READINGS[cand["id"]],
    }
    cand["provenance"] = "CROSSCHECKED"

manifest["crosscheck"] = {
    "sentinel1": "Sentinel-1 RTC (ASF) C-band VV gamma-0, relative orbit 114, 2026-07-13 -> 2026-10-05, Planetary Computer COGs",
    "sentinel2": "Sentinel-2 L2A NDWI > 0 water fraction, tile T45RYJ, 2026-07-04 (14.8% cloud) and 2026-10-12 (0.0% cloud)",
    "jrc": "JRC Global Surface Water: public JEODPP MonthlyHistory mirror ends at 2021 - no 2026 monthly water openly downloadable there (checked 2026-10-31). S2 NDWI fills the optical role.",
}
wp_path = "/tmp/worldpop_out.json"
if os.path.exists(wp_path):
    manifest["exposureWorldPop"] = json.load(open(wp_path))
manifest["generated"] = "2026-10-31 v3"
manifest["manifestHash"] = "sha256:" + hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
case["manifestHash"] = manifest["manifestHash"]
case["caseHash"] = "sha256:" + hashlib.sha256(json.dumps(case, sort_keys=True).encode()).hexdigest()

json.dump(manifest, open(os.path.join(ROOT, "manifest.json"), "w"), indent=1)
json.dump(case, open(os.path.join(ROOT, "case.json"), "w"), indent=1)
print("v3 built; crosschecks merged for", [c["id"] for c in case["candidates"]])
print("worldpop:", "merged" if os.path.exists(wp_path) else "not present")
