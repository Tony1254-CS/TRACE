# TRACE Field

**The satellite asks. You answer.**

The ground-witness app for TRACE (NASA Space Apps 2026, *Dancing with SAR*).
The web case detects a change it cannot settle; this app opens that exact
case on a phone, guides one field observation, works offline, and returns
the evidence to the web as **awaiting review**. It never says "verified" —
a photo is evidence for review, not ground truth.

Record the demo video from a phone with the PWA installed to the home
screen, never a desktop browser. Record on Android for haptics: iOS Safari
has no `navigator.vibrate` and no Background Sync, so the offline queue
also has a manual **Sync now** button plus an `online`-event trigger.

## Step 0 — data audit before any UI (done 2026-10-31)

Reproduce: `python3 scripts/step0_audit.py`. Full report:
`STEP0_DATA_AUDIT.md` in the project goal folder.

1. **NISAR dates, track 19 over Chilmari: 9 real dates** — frame 076,
   descending, ~12:42 UTC: 2026-06-27, 07-09, 07-21, 08-14, 08-26, 09-07,
   09-19, 10-01, 10-13. Cycle 027 (2026-08-02) is missing — verified.
   9 ≥ 3, so this is a full time series, not a before/after pair.
2. **HVHV: yes, all 9 dates.** DH dual-pol (QP quad-pol on 08-26 and
   09-19), Frequency A. Only polarizations actually in the granule are shown.
3. **Version/maturity: PROVISIONAL Version 1** — `NISAR_L2_GCOV_PROVISIONAL_V1`,
   CRID P05023, DOI 10.5067/NIL2GCOV-P1. Orbit accuracy N on 8/9, F
   (forecast) on 2026-09-19 — flagged in the Passport.
4. **Variable: gamma-0 (γ°) power.** Not sigma-0 (that needs the
   `rtcGammaToSigmaFactor` layer). All UI strings load this from JSON.
5. **Grid: mixed.** 10 m on the two 40 MHz dates, 20 m on the other
   seven. Common analysis grid 20 m → **0.04 ha/pixel**.

Cross-checks: Sentinel-2 tile T45RYJ had 49 acquisitions in the window,
only 5 with cloud <20% (sensor race is real). Sentinel-1 RTC: 18 dates,
relative orbits 114/150, VV/VH — C-band context only, labelled as such.
Not yet verified, slots marked UNVERIFIED in `manifest.json`: GPM IMERG,
BWDB/FFWC river stage, JRC Global Surface Water, WorldPop/OSM exposure.

**Honesty rule in the code:** GCOV pixel processing has not run yet, so
the change candidates in `public/data/case.json` are seeded, deterministic
(never `Math.random()`), physically ordered, and carry a **SIMULATED**
chip in the UI and Passport. The Python precompute
(`rasterio`/`rio-cogeo`, offline) replaces them with real masks — robust
core = agreement across Otsu offsets / filter windows / MMU settings
(a robustness measure, not a probability).

## Features

- **Mission inbox** — radar-sweep intro, “The satellite is unsure about
  3 places near you”, QR/deep link `?case=CH-01` opens the exact case.
- **Case map** — MapLibre; robust core solid, contested fringe amber
  hatching, ghost outlines of earlier boundaries; date scrubber snaps
  only to the 9 real acquisition dates; numbers tick to value.
- **Offline pack** — Cache API download with a real progress ring.
- **Verify** — water / wet land / sandbar / vegetation / not observable,
  photo, GPS with accuracy, timestamp, note, optional voice note.
  Dexie/IndexedDB queue: Queued → Synced → Awaiting review.
  A submission far from the site is auto-tagged
  “Demo observer, not at case site”.
- **Evidence return** — Review card flips to “N observations awaiting
  review” with an audit trail; conflicting observers stay separate rows.
  Supabase if `VITE_SUPABASE_URL` is set, else local inbox + 2 s polling.
- **Change Passport** — per polygon: granule ID, dates, variable/units,
  threshold, area with grid size, QC flags, manifest hash, and
  MEASURED / DERIVED / CROSSCHECKED / UNVERIFIED / SIMULATED chips.
  Bottom sheet with peek / half / full snaps.
- **Walk on the Radar** — backscatter under your finger drives pitch
  (Web Audio) and haptics; the dB value is always on screen.
  “An encoding of data, not a sound from space.”
- **My Place Watch** — plain Bangla in “consistent with” wording
  (Hind Siliguri), next-pass countdown computed as last date + 12n days.
- **Point & Prove** — bearing + distance to the polygon from GPS,
  labelled approximate. **Sensor race chip** and a 4-card **SAR field
  guide** cover the frequency / physical-driver story.
- **Field Story** — deliberately empty until the team has a real one.

Copy rules enforced: smooth open water is dark because of specular
reflection; flooded vegetation is often bright at L-band (double bounce);
same-track 12-day repeats only; Sentinel-1 is C-band radar, not optical;
NISAR launched 30 July 2025, wide swath is SweepSAR; land-to-water is not
automatically erosion. `npm run check:hardcoded` lints UI strings so every
measurement loads from JSON.

## Stack

React + Vite + TypeScript, vite-plugin-pwa (Workbox), MapLibre GL JS,
Dexie over IndexedDB, Web Audio API. Palette: ink `#0A0E12`, panel
`#11171D`, hairline `#1F2A33`, bone `#E8E4DA`, amber `#FFB224` (signal),
water teal `#3FD0C9`. Type: Instrument Serif (verdicts), Inter Tight
(UI), JetBrains Mono (every number), Hind Siliguri (Bangla). PWA:
standalone manifest, theme-color, bottom tab bar, safe-area insets,
100dvh, 44 px targets, overscroll disabled, no scrollbars.

```bash
npm install
npm run dev      # develop
npm run build    # production build (dist/)
```

Web and app share one `case.json` + `manifest.json` format
(`public/data/`), so the web console reads the same case this app answers.
