#!/usr/bin/env python3
"""TRACE Field precompute v2 — REAL change candidates from NISAR browse imagery.

Inputs (public, no login): ASF browse PNGs for the 9 track-19/frame-076
GCOV granules. The LATLON browse is an HH/HV/HH composite in a lat/lon
grid (verified: R == B exactly, R correlates with NATIVE HHHH at 0.86,
G with NATIVE HVHV at 0.85), so R = HH intensity, G = HV intensity.

Method, honestly stated: browse images are 8-bit renders, not calibrated
float gamma-0 (the .h5 requires an Earthdata login). Change is therefore
computed in browse intensity after per-date percentile harmonisation,
with an ensemble over thresholds / filter windows / MMU sizes:
robust core = change under every setting, fringe = change under some.
Areas use the browse grid spacing and are labelled as such.
The calibrated pipeline (same code path on GCOV float layers) replaces
this when Earthdata credentials are available.

Pair: 2026-07-09 -> 2026-10-13. Both are 20 MHz DH mixed-mode granules
(same product configuration and browse family — the two 40 MHz dates
render with different texture and are kept in the series, not the pair).
Discharge (GloFAS) fell 35,236 -> 11,994 m3/s between them: monsoon to
recession. Alignment verified visually: channel network is co-located.
"""
import json
import urllib.parse
import urllib.request

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

AOI = (89.58, 25.44, 89.82, 25.70)  # lon0, lat0, lon1, lat1
STEP = 0.00045  # degrees per browse-grid pixel (~50 m N-S)
DATES = ["20260627", "20260709", "20260721", "20260814", "20260826",
         "20260907", "20260919", "20261001", "20261013"]
PAIR = ("20260709", "20261013")
BROWSE = "nisar_browse"


def granule_bbox(date):
    """CMR polygon bbox for that date's full frame-076 granule."""
    params = {"short_name": "NISAR_L2_GCOV_PROVISIONAL_V1",
              "bounding_box": "89.55,25.40,89.85,25.75", "page_size": "200"}
    url = "https://cmr.earthdata.nasa.gov/search/granules.json?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=30) as r:
        entries = json.load(r)["feed"]["entry"]
    for e in entries:
        if f"_{date}T" in e["title"] and "_019_D_076_" in e["title"] and "_F_" in e["title"]:
            vals = [float(v) for v in e["polygons"][0][0].split()]
            lats, lons = vals[0::2], vals[1::2]
            return (min(lons), min(lats), max(lons), max(lats)), e["title"]
    raise SystemExit(f"granule not found for {date}")


REF_STATS = {}

def sample_aoi(date):
    """Resample the date's LATLON HH/HV onto the common AOI grid.

    Harmonisation uses FULL-frame percentiles (stable land dominates the
    frame), never AOI percentiles — the AOI itself is what changed.
    """
    (gx0, gy0, gx1, gy1), title = granule_bbox(date)
    img = np.asarray(Image.open(f"{BROWSE}/{date}_J_001_LATLON.png")).astype(np.float32)
    hh, hv = img[:, :, 0], img[:, :, 1]
    p2, p98 = np.percentile(hh[hh > 0], [2, 98])
    if not REF_STATS:
        REF_STATS["p2"], REF_STATS["p98"] = p2, p98
    hh = np.clip((hh - p2) / max(p98 - p2, 1e-6), 0, 1) * (REF_STATS["p98"] - REF_STATS["p2"]) + REF_STATS["p2"]
    h = int(round((AOI[3] - AOI[1]) / STEP))
    w = int(round((AOI[2] - AOI[0]) / STEP))
    ys = AOI[3] - (np.arange(h) + 0.5) * STEP
    xs = AOI[0] + (np.arange(w) + 0.5) * STEP
    sx = (xs - gx0) / (gx1 - gx0) * (hh.shape[1] - 1)
    sy = (gy1 - ys) / (gy1 - gy0) * (hh.shape[0] - 1)
    SX, SY = np.meshgrid(sx, sy)
    coords = [SY.ravel(), SX.ravel()]
    out_hh = ndimage.map_coordinates(hh, coords, order=1).reshape(h, w)
    out_hv = ndimage.map_coordinates(hv, coords, order=1).reshape(h, w)
    nodata = (out_hh <= 0) & (out_hv <= 0)
    return out_hh, out_hv, nodata, title


def harmonise(a, ref_p2, ref_p98):
    p2, p98 = np.percentile(a[a > 0], [2, 98])
    return np.clip((a - p2) / max(p98 - p2, 1e-6), 0, 1) * (ref_p98 - ref_p2) + ref_p2


def main():
    # Set the harmonisation reference from the pair's second date first.
    ref_img = np.asarray(Image.open(f"{BROWSE}/{PAIR[1]}_J_001_LATLON.png")).astype(np.float32)
    rp2, rp98 = np.percentile(ref_img[:, :, 0][ref_img[:, :, 0] > 0], [2, 98])
    REF_STATS["p2"], REF_STATS["p98"] = rp2, rp98
    stacks = {}
    titles = {}
    for d in DATES:
        hh, hv, nd, title = sample_aoi(d)
        stacks[d] = (hh, hv, nd)
        titles[d] = title
        print(d, "sampled", hh.shape, "nodata%", round(float(nd.mean()) * 100, 1))

    a_hh, a_hv, a_nd = stacks[PAIR[0]]
    b_hh, b_hv, b_nd = stacks[PAIR[1]]
    valid = ~(a_nd | b_nd)
    delta = (b_hh - a_hh) / 255.0  # normalised intensity change, HH

    # Ensemble: thresholds x median windows x MMU.
    votes = np.zeros(delta.shape, np.float32)
    runs = 0
    for thr in (0.16, 0.22, 0.30):
        for win in (3, 5):
            m = ndimage.median_filter(np.abs(delta), size=win) > thr
            m &= valid
            for mmu in (20, 60):
                lab, n = ndimage.label(m)
                if n:
                    sizes = ndimage.sum_labels(m, lab, range(1, n + 1))
                    m = m & np.isin(lab, np.where(sizes >= mmu)[0] + 1)
                votes += m
                runs += 1
    frac = votes / runs
    robust = frac >= 0.999
    fringe = (frac > 0) & ~robust
    print("ensemble runs", runs, "robust px", int(robust.sum()), "fringe px", int(fringe.sum()))

    # Candidates = connected robust clusters (8-connectivity), largest first.
    lab, n = ndimage.label(robust, structure=np.ones((3, 3)))
    sizes = ndimage.sum_labels(robust, lab, range(1, n + 1)) if n else []
    order = np.argsort(sizes)[::-1]
    # pixel area: STEP deg lat * STEP deg lon at lat 25.57
    m_per_deg_lat, m_per_deg_lon = 110990.0, 100340.0
    px_ha = (STEP * m_per_deg_lat) * (STEP * m_per_deg_lon) / 10000.0
    print("browse px ha", round(px_ha, 3))

    def poly_of(mask, simplify_deg=0.0012):
        cnts, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        polys = []
        for c in cnts:
            if len(c) < 4:
                continue
            pts = []
            for x, y in c[:, 0, :]:
                pts.append((AOI[0] + (x + 0.5) * STEP, AOI[3] - (y + 0.5) * STEP))
            from shapely.geometry import Polygon
            from shapely.validation import make_valid

            def largest_polygon(g):
                if g.geom_type == "Polygon":
                    return g
                parts = []
                for sub in getattr(g, "geoms", []):
                    lp = largest_polygon(sub)
                    if lp is not None:
                        parts.append(lp)
                return max(parts, key=lambda x: x.area) if parts else None

            p = largest_polygon(make_valid(Polygon(pts)))
            if p is not None and p.area > 0:
                polys.append(p)
        if not polys:
            return None
        u = unary_union(polys).simplify(simplify_deg)
        if u.geom_type != "Polygon":
            parts = []
            def flat(g):
                if g.geom_type == "Polygon":
                    parts.append(g)
                for sub in getattr(g, "geoms", []):
                    flat(sub)
            flat(u)
            u = max(parts, key=lambda x: x.area) if parts else None
        return u

    # Early-pair robust mask (first two dates) for ghost outlines.
    e_hh_a, _, e_nd_a = stacks[DATES[0]]
    e_hh_b, _, e_nd_b = stacks[DATES[1]]
    e_delta = (e_hh_b - e_hh_a) / 255.0
    e_valid = ~(e_nd_a | e_nd_b)
    e_robust = (ndimage.median_filter(np.abs(e_delta), size=3) > 0.22) & e_valid

    cands = []
    rank = 0
    for idx in order[:10]:
        if len(cands) >= 3:
            break
        cid = idx + 1
        core_mask = lab == cid
        # Validity: a cluster that is nodata-black in either pair date is a
        # coverage artefact, not ground change. (Caught a real one at the
        # AOI's NE edge: HH ~ 2 in July, data in October.)
        if a_hh[core_mask].mean() <= 5 or b_hh[core_mask].mean() <= 5:
            print("skip cluster", cid, "- nodata in a pair date")
            continue
        rank += 1
        # fringe belonging to this candidate: fringe pixels within 6 px of the core
        near = ndimage.binary_dilation(core_mask, iterations=6)
        fringe_mask = fringe & near
        core_poly = poly_of(core_mask)
        fringe_poly = poly_of(fringe_mask | core_mask)
        if core_poly is None:
            continue
        core_geom = mapping(core_poly)["coordinates"][0]
        fringe_geom = mapping(fringe_poly)["coordinates"][0] if fringe_poly else core_geom
        cy, cx = ndimage.center_of_mass(core_mask)
        centroid = [round(AOI[0] + (cx + 0.5) * STEP, 4), round(AOI[3] - (cy + 0.5) * STEP, 4)]
        ghost_mask = e_robust & near
        ghost_poly = poly_of(ghost_mask) if ghost_mask.sum() >= 20 else None
        hh_series, hv_series = [], []
        for d in DATES:
            hh, hv, nd = stacks[d]
            sel = core_mask & ~nd
            hh_series.append(round(float(hh[sel].mean()), 1))
            # QA: the 2026-09-07 HVHV browse is black over the whole AOI
            # (mean 1.0, 100% of pixels <= 2) - a defective render, excluded.
            hv_series.append(None if d == "20260907" else round(float(hv[sel].mean()), 1))
        direction = "brighter" if delta[core_mask].mean() > 0 else "darker"
        ghost_geom = (mapping(ghost_poly)["coordinates"][0] if ghost_poly else fringe_geom)
        cands.append({
            "rank": rank, "corePx": int(core_mask.sum()), "fringePx": int(fringe_mask.sum()),
            "centroid": centroid, "core": [[round(float(x), 4), round(float(y), 4)] for x, y in core_geom],
            "fringe": [[round(float(x), 4), round(float(y), 4)] for x, y in fringe_geom],
            "ghost": [[round(float(x), 4), round(float(y), 4)] for x, y in ghost_geom],
            "meanDelta": round(float(delta[core_mask].mean()), 3), "direction": direction,
            "hhIntensity": hh_series, "hvIntensity": hv_series,
        })
        print("candidate", rank, "corePx", int(core_mask.sum()), "centroid", centroid, "delta", cands[-1]["meanDelta"])

    out = {"pair": [PAIR[0], PAIR[1]], "aoi": AOI, "stepDeg": STEP, "pxHa": round(px_ha, 3),
           "granules": titles, "candidates": cands,
           "walkGrid": None}
    # Walk grid: real HH intensity (latest date), downsampled 64x64 over the AOI centre crop.
    hh = stacks[PAIR[1]][0]
    small = ndimage.zoom(hh, (64 / hh.shape[0], 64 / hh.shape[1]), order=1)
    out["walkGrid"] = {"date": PAIR[1], "layer": "HHHH browse intensity (0-255)",
                       "values": [[round(float(v), 0) for v in row] for row in small]}
    json.dump(out, open("precompute_out.json", "w"), indent=1)
    print("wrote precompute_out.json")


if __name__ == "__main__":
    main()
