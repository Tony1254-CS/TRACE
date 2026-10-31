#!/usr/bin/env python3
"""TRACE Field calibrated pipeline v4: real GCOV float gamma-0 (dB).

Reads the two downloaded pair granules (2026-07-09, 2026-10-13), crops the
AOI on the native frequencyA grid, converts gamma-0 power to dB, re-runs the
12-setting change ensemble IN dB, and re-derives the candidate polygons and
per-candidate calibrated statistics. Output: gcov_out.json (+ pair scene PNGs).
"""
import json, os
import numpy as np, h5py
from scipy import ndimage
import cv2
from rasterio.transform import from_bounds
import rasterio
from shapely.geometry import Polygon, mapping
from pyproj import Transformer

HERE = os.path.dirname(os.path.abspath(__file__))
FILES = {
    "2026-07-09": os.path.join(HERE, "gcov", "NISAR_L2_PR_GCOV_025_019_D_076_2005_DHDH_M_20260709T124242_20260709T124317_P05023_N_F_J_001.h5"),
    "2026-10-13": os.path.join(HERE, "gcov", "NISAR_L2_PR_GCOV_033_019_D_076_2005_DHDH_M_20261013T124240_20261013T124315_P05023_N_F_J_001.h5"),
}
AOI = (89.58, 25.44, 89.82, 25.70)  # lon0, lat0, lon1, lat1
BASE = "science/LSAR/GCOV/grids/frequencyA"

def load(date):
    h = h5py.File(FILES[date], "r")
    epsg = int(h[f"{BASE}/projection"][()])
    xs = h[f"{BASE}/xCoordinates"][:]; ys = h[f"{BASE}/yCoordinates"][:]
    t = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True)
    xa, ya = t.transform(AOI[0], AOI[1]); xb, yb = t.transform(AOI[2], AOI[3])
    xlo, xhi, ylo, yhi = min(xa, xb), max(xa, xb), min(ya, yb), max(ya, yb)
    xi = np.where((xs >= xlo) & (xs <= xhi))[0]
    yi = np.where((ys >= ylo) & (ys <= yhi))[0]  # ys descending: row 0 = north
    cols = slice(xi[0], xi[-1] + 1); rows = slice(yi[0], yi[-1] + 1)
    out = {"epsg": epsg, "xs": xs[cols], "ys": ys[rows],
           "spacing": float(h[f"{BASE}/xCoordinateSpacing"][()])}
    for layer in ["HHHH", "HVHV"]:
        out[layer] = h[f"{BASE}/{layer}"][rows, cols].astype(np.float32)
    out["mask"] = h[f"{BASE}/mask"][rows, cols]
    h.close()
    print(date, "window", out["HHHH"].shape, "spacing", out["spacing"], "epsg", epsg)
    return out

def to_db(a, mask):
    valid = (a > 0) & np.isfinite(a)
    db = np.where(valid, 10 * np.log10(np.maximum(a, 1e-6)), np.nan)
    return db

def main():
    A = load("2026-07-09"); B = load("2026-10-13")
    assert A["HHHH"].shape == B["HHHH"].shape, (A["HHHH"].shape, B["HHHH"].shape)
    hhA, hhB = to_db(A["HHHH"], A["mask"]), to_db(B["HHHH"], B["mask"])
    hvA, hvB = to_db(A["HVHV"], A["mask"]), to_db(B["HVHV"], B["mask"])
    both = np.isfinite(hhA) & np.isfinite(hhB)
    # Radiometric tie-point: a stable east-farmland control patch (same patch
    # as the browse QA) shifted seasonally between the pair dates. Calibrated
    # change is measured relative to that documented shift, not absolutely.
    Hh, Ww = hhA.shape
    def _cell(lon, lat): return int((25.70 - lat) / 0.26 * Hh), int((lon - 89.58) / 0.24 * Ww)
    r0, c0 = _cell(89.795, 25.560); r1, c1 = _cell(89.815, 25.545)
    ctrlA = float(np.nanmean(hhA[r0:r1, c0:c1])); ctrlB = float(np.nanmean(hhB[r0:r1, c0:c1]))
    shift = ctrlB - ctrlA
    print(f"control patch: Jul {ctrlA:.2f} dB -> Oct {ctrlB:.2f} dB; seasonal shift {shift:+.2f} dB removed")
    delta = np.where(both, hhB - hhA - shift, 0.0)
    spacing = A["spacing"]; ha_px = spacing * spacing / 10000.0
    print("native spacing m:", spacing, "ha/px:", ha_px, "valid pair frac:", float(both.mean()))

    # 12-setting ensemble in dB: thresholds x median windows x MMU
    votes = np.zeros(delta.shape, np.uint8)
    for t in [3.0, 4.5, 6.0]:
        for w in [3, 5]:
            d = ndimage.median_filter(np.where(both, delta, 0.0), size=w)
            chg0 = (np.abs(d) > t) & both
            for mmu in [100, 350]:
                chg = chg0.copy()
                lab, n = ndimage.label(chg)
                if n:
                    sizes = ndimage.sum_labels(chg, lab, range(1, n + 1))
                    kill = np.isin(lab, np.where(sizes < mmu)[0] + 1)
                    chg = chg & ~kill
                votes += chg.astype(np.uint8)
    robust = votes == 12  # persists across ALL 12 settings
    fringe = (votes >= 3) & ~robust
    print("robust px:", int(robust.sum()), "fringe px:", int(fringe.sum()))

    lab, n = ndimage.label(robust)
    objs = []
    for i in range(1, n + 1):
        m = lab == i
        cnt = int(m.sum())
        if cnt < 100: continue
        objs.append((cnt, m))
    objs.sort(key=lambda x: -x[0])
    print("clusters:", [(c, round(c * ha_px, 1)) for c, _ in objs[:6]])

    t_back = Transformer.from_crs(f"EPSG:{A['epsg']}", "EPSG:4326", always_xy=True)
    xs, ys = A["xs"], A["ys"]
    def ring(mask, ds=4):
        small = mask[::ds, ::ds].astype(np.uint8)
        cnts, _ = cv2.findContours(small, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cnts: return []
        c = max(cnts, key=cv2.contourArea).reshape(-1, 2)
        pts = []
        for px, py in c[:: max(1, len(c) // 60)]:
            X = xs[min(px * ds, len(xs) - 1)]; Y = ys[min(py * ds, len(ys) - 1)]
            lon, lat = t_back.transform(X, Y)
            pts.append([round(float(lon), 5), round(float(lat), 5)])
        return pts

    cands = []
    for k, (cnt, core) in enumerate(objs[:3], 1):
        fr = fringe & (ndimage.binary_dilation(core, iterations=25))
        ys_i, xs_i = np.nonzero(core)
        clon, clat = t_back.transform(float(xs[xs_i].mean()), float(ys[ys_i].mean()))
        stats = {}
        for nm, arr in [("hhDbA", hhA), ("hhDbB", hhB), ("hvDbA", hvA), ("hvDbB", hvB)]:
            v = arr[core]; v = v[np.isfinite(v)]
            stats[nm] = round(float(v.mean()), 2) if len(v) else None
        stats["dDbHH"] = round(stats["hhDbB"] - stats["hhDbA"], 2)
        stats["dDbHV"] = round(stats["hvDbB"] - stats["hvDbA"], 2) if stats["hvDbA"] is not None else None
        cands.append({
            "id": f"CH-0{k}", "centroid": [round(float(clon), 4), round(float(clat), 4)],
            "robustPxNative": cnt, "fringePxNative": int(fr.sum()),
            "robustAreaHa": round(cnt * ha_px, 1), "totalAreaHa": round((cnt + int(fr.sum())) * ha_px, 1),
            "core": ring(core), "fringeRing": ring(core | fr),
            "calibrated": stats,
            "meanDeltaDb": stats["dDbHH"],
        })
        print(cands[-1]["id"], cands[-1]["centroid"], cands[-1]["robustAreaHa"], "ha, dHH", stats["dDbHH"], "dB")

    # Walk grid in dB (Oct 13 HH), 64x64 block means
    g = hhB
    H, W = g.shape
    wg = np.nanmean(g[: H // 64 * 64, : W // 64 * 64].reshape(64, H // 64, 64, W // 64), axis=(1, 3))
    walk = [[None if not np.isfinite(v) else round(float(v), 1) for v in row] for row in wg]

    # Pair scenes rendered from calibrated dB (fixed -25..0 dB stretch)
    from PIL import Image
    scenes = {}
    import base64, io
    for date, arr in [("2026-07-09", hhA), ("2026-10-13", hhB)]:
        img = np.clip((np.nan_to_num(arr, nan=-25.0) + 25) / 25 * 255, 0, 255).astype(np.uint8)
        buf = io.BytesIO(); Image.fromarray(img).save(buf, format="PNG", optimize=True)
        scenes[date] = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
        print("scene", date, len(buf.getvalue()) // 1024, "KB")

    json.dump({"candidates": cands, "walkGridDb": walk, "scenesDb": scenes,
               "gridM": spacing, "haPerPixelNative": ha_px,
               "controlPatch": {"julDb": round(ctrlA, 2), "octDb": round(ctrlB, 2), "shiftDb": round(shift, 2)}},
              open(os.path.join(HERE, "gcov_out.json"), "w"))
    print("gcov_out.json written")

if __name__ == "__main__":
    main()
