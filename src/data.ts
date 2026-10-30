export interface Granule {
  date: string; granuleId: string; bandwidthMHz: number; polPrimary: string;
  orbitAccuracy: string; gridM: number; layersFrequencyA: string[];
}
export interface Manifest {
  caseId: string; product: { collection: string; maturity: string; crid: string; doi: string };
  track: number; frame: number; variableLabel: string; commonGridM: number; haPerPixel: number;
  granules: Granule[]; manifestHash: string;
  sentinel1RTC: { band: string; dates: string[]; polarizations: string[] };
  sentinel2: { tile: string; acquisitions: number; clearUnder20Pct: number };
}
export interface Candidate {
  id: string; title: string; question: string; centroid: [number, number]; distanceKm: number;
  robustPx: number; fringePx: number; areaHa: number; robustAreaHa: number;
  core: [number, number][]; fringe: [number, number][]; ghost: [number, number][];
  hhDb: number[]; hvDb: number[]; provenance: string; status: string;
}
export interface CaseData {
  caseId: string; site: { name: string; lat: number; lon: number };
  dates: string[]; pair: string[]; thresholdDb: number; thresholdNote: string;
  candidates: Candidate[]; sensorRace: { opticalClear: number; opticalTotal: number; nisarSeen: number; nisarTotal: number; s1Dates: number };
  placeWatch: { bn: string; en: string }; manifestHash: string; caseHash: string;
}

export async function loadCase(): Promise<{ caseData: CaseData; manifest: Manifest }> {
  const [c, m] = await Promise.all([
    fetch('/data/case.json').then((r) => r.json()),
    fetch('/data/manifest.json').then((r) => r.json()),
  ]);
  return { caseData: c as CaseData, manifest: m as Manifest };
}

/** Next NISAR pass: last real date + 12n days, same track. Computed, never typed in. */
export function nextPass(lastDateIso: string, from = new Date()): Date {
  const d = new Date(lastDateIso + 'T12:42:00Z');
  while (d.getTime() <= from.getTime()) d.setUTCDate(d.getUTCDate() + 12);
  return d;
}

export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
export function bearingDeg(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const y = Math.sin((bLon - aLon) * rad) * Math.cos(bLat * rad);
  const x = Math.cos(aLat * rad) * Math.sin(bLat * rad) - Math.sin(aLat * rad) * Math.cos(bLat * rad) * Math.cos((bLon - aLon) * rad);
  return ((Math.atan2(y, x) / rad) + 360) % 360;
}

/** Deterministic seeded PRNG — simulated layers must never use Math.random(). */
export function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
