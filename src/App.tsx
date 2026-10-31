import { useEffect, useMemo, useRef, useState } from 'react';
import { loadCase, nextPass, haversineKm, bearingDeg, type CaseData, type Manifest, type Candidate } from './data';
import { db, type Observation, type ObsAnswer } from './db';
import { syncAllQueued, readWebInbox, fetchInboxRows, type WebInboxRow } from './sync';
import QRCode from 'qrcode';

type Tab = 'inbox' | 'map' | 'verify' | 'radar' | 'place';

let scenesPromise: Promise<Record<string, string>> | null = null;
function loadScenes(): Promise<Record<string, string>> {
  if (!scenesPromise) scenesPromise = fetch('/data/scenes.json').then((r) => r.json());
  return scenesPromise;
}
const TABS: { id: Tab; label: string }[] = [
  { id: 'inbox', label: 'INBOX' }, { id: 'map', label: 'CASE' }, { id: 'verify', label: 'VERIFY' },
  { id: 'radar', label: 'RADAR' }, { id: 'place', label: 'MY PLACE' },
];

function useTick(target: number, digits = 1) {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0; const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / 600);
      setV(parseFloat((target * p).toFixed(digits)));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, digits]);
  return v;
}

export default function App() {
  const [data, setData] = useState<{ caseData: CaseData; manifest: Manifest } | null>(null);
  const [tab, setTab] = useState<Tab>('inbox');
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [passport, setPassport] = useState(false);
  const [queuedCount, setQueuedCount] = useState(0);

  useEffect(() => { loadCase().then(setData).catch(() => {}); }, []);
  useEffect(() => {
    const refresh = async () => setQueuedCount(await db.observations.where('status').equals('queued').count());
    refresh();
    const onOnline = () => { syncAllQueued().then(refresh); };
    window.addEventListener('online', onOnline);
    const i = setInterval(refresh, 2000); // polling fallback for the evidence loop
    return () => { window.removeEventListener('online', onOnline); clearInterval(i); };
  }, []);

  // Deep link / QR: ?case=CH-01 opens the exact case.
  useEffect(() => {
    if (!data) return;
    const id = new URLSearchParams(location.search).get('case');
    const c = data.caseData.candidates.find((x) => x.id === id) ?? data.caseData.candidates[0];
    setSelected(c);
  }, [data]);

  if (!data) return <main><p className="mono dim">Loading case…</p></main>;
  const { caseData, manifest } = data;
  const sel = selected ?? caseData.candidates[0];

  return (
    <>
      <header className="topbar">
        <span className="brand">TRACE Field</span>
        <span className="tag">THE SATELLITE ASKS. YOU ANSWER.</span>
      </header>
      <main>
        {tab === 'inbox' && <Inbox caseData={caseData} onOpen={(c) => { setSelected(c); setTab('map'); }} queuedCount={queuedCount} />}
        {tab === 'map' && <CaseMap caseData={caseData} manifest={manifest} sel={sel} onSelect={setSelected} onPassport={() => setPassport(true)} onVerify={() => setTab('verify')} />}
        {tab === 'verify' && <Verify caseData={caseData} sel={sel} onSelect={setSelected} />}
        {tab === 'radar' && <WalkRadar caseData={caseData} />}
        {tab === 'place' && <MyPlace caseData={caseData} sel={sel} />}
      </main>
      <nav className="tabbar">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}{t.id === 'verify' && queuedCount > 0 ? ` · ${queuedCount}` : ''}
          </button>
        ))}
      </nav>
      {passport && <Passport caseData={caseData} manifest={manifest} sel={sel} onClose={() => setPassport(false)} />}
    </>
  );
}

/* ---------------- Mission inbox ---------------- */
function Inbox({ caseData, onOpen, queuedCount }: { caseData: CaseData; onOpen: (c: Candidate) => void; queuedCount: number }) {
  const [dl, setDl] = useState(-1);
  const [inbox, setInbox] = useState<WebInboxRow[]>(readWebInbox());
  useEffect(() => {
    let live = true;
    const tick = async () => { const rows = await fetchInboxRows(); if (live) setInbox(rows); };
    void tick();
    const i = setInterval(() => void tick(), 2000);
    return () => { live = false; clearInterval(i); };
  }, []);
  const r = caseData.sensorRace;

  async function downloadCase() {
    // 1) Case JSON + shell into the case cache (the progress ring's first half).
    const urls = ['/data/case.json', '/data/manifest.json', '/data/scenes.json', '/', '/icons/icon.svg'];
    const cache = await caches.open('trace-case-v1');
    for (let i = 0; i < urls.length; i++) { await cache.add(urls[i]); setDl(Math.round(((i + 1) / urls.length) * 50)); }
    // 2) Basemap tiles for the case area, zooms 10-13 — fetched through the
    //    service worker, whose runtime cache (basemap-tiles) serves them
    //    offline. Tile math is standard slippy-map.
    const lon2x = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
    const lat2y = (lat: number, z: number) => {
      const r = (lat * Math.PI) / 180;
      return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
    };
    const tiles: string[] = [];
    for (const z of [10, 11, 12, 13]) {
      for (let x = lon2x(89.58, z); x <= lon2x(89.82, z); x++)
        for (let y = lat2y(25.70, z); y <= lat2y(25.44, z); y++)
          tiles.push(`https://basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`);
    }
    let done = 0;
    for (const t of tiles) {
      try { await fetch(t); } catch { /* a missing tile is a grey square, not a failure */ }
      done++;
      setDl(50 + Math.round((done / tiles.length) * 50));
    }
  }
  const awaiting = inbox.length;
  const circ = 2 * Math.PI * 26;

  return (
    <>
      <div className="sweep">
        <div className="mono amber" style={{ fontSize: 11, letterSpacing: 1.5 }}>MISSION INBOX · TRACK 19 · FRAME 076</div>
        <h1 style={{ fontSize: 26, margin: '8px 0 2px' }}>The satellite is unsure about {caseData.candidates.length} places near you</h1>
        <div className="dim" style={{ fontSize: 13 }}>{caseData.site.name} — it never asks you to confirm what it already knows.</div>
      </div>

      {caseData.candidates.map((c) => (
        <button key={c.id} className="card" onClick={() => onOpen(c)}>
          <span className="chip amber">{c.id}</span>{' '}
          <span className="chip sim">{c.provenance}</span>{' '}
          <span className="chip">{c.status.replace('-', ' ').toUpperCase()}</span>
          <div className="q">{c.question}</div>
          <div className="mono dim" style={{ fontSize: 12 }}>{c.title} · {c.distanceKm} km away · robust core {c.robustAreaHa} ha</div>
        </button>
      ))}

      <div className="card" style={{ cursor: 'default' }}>
        <div className="ringwrap">
          <svg className="progress-ring" width="64" height="64">
            <circle cx="32" cy="32" r="26" fill="none" stroke="#1F2A33" strokeWidth="5" />
            <circle cx="32" cy="32" r="26" fill="none" stroke="#FFB224" strokeWidth="5"
              strokeDasharray={circ} strokeDashoffset={dl < 0 ? circ : circ * (1 - dl / 100)} transform="rotate(-90 32 32)" />
          </svg>
          <div>
            <div style={{ fontSize: 16 }}>Offline pack</div>
            <div className="dim" style={{ fontSize: 13 }}>{dl < 0 ? 'Download this case — tiles and JSON — before you leave signal.' : dl < 100 ? `Caching… ${dl}%` : 'Cached. Airplane mode is fine now.'}</div>
          </div>
        </div>
        <button className="btn ghost" onClick={downloadCase}>Download case</button>
        {queuedCount > 0 && <button className="btn" onClick={() => syncAllQueued()}>Sync now ({queuedCount} queued)</button>}
      </div>

      <div className="card" style={{ cursor: 'default' }}>
        <div className="mono" style={{ fontSize: 12 }}>
          SENSOR RACE — Optical had a clear view on <span className="amber">{r.opticalClear} of {r.opticalTotal}</span> dates.
          L-band saw all <span className="teal">{r.nisarSeen} of {r.nisarTotal}</span> of its passes. C-band context: {r.s1Dates} dates.
        </div>
      </div>

      <div className="card" style={{ cursor: 'default' }}>
        <div className="mono amber" style={{ fontSize: 11, letterSpacing: 1.5 }}>DRIVERS — WHY THE RIVER MOVED</div>
        <div className="rowline"><span>Jamuna discharge {caseData.pair[0]}</span><span className="mono">{caseData.drivers.dischargeM3sByDate[caseData.pair[0]]} m³/s</span></div>
        <div className="rowline"><span>Jamuna discharge {caseData.pair[1]}</span><span className="mono">{caseData.drivers.dischargeM3sByDate[caseData.pair[1]]} m³/s</span></div>
        <div className="rowline"><span>Rain over the pair window</span><span className="mono">{caseData.drivers.rainPairTotalMm} mm</span></div>
        <div className="dim" style={{ fontSize: 12 }}>Discharge: GloFAS via Open-Meteo Flood API. Rain: NASA POWER. The BWDB/FFWC Chilmari gauge has no public API — discharge stands in for stage, and says so.</div>
      </div>

      <div className="card" style={{ cursor: 'default' }}>
        <div className="mono amber" style={{ fontSize: 11, letterSpacing: 1.5 }}>WEB REVIEW — EVIDENCE RETURN</div>
        <div className="verdict" style={{ fontSize: 22, margin: '6px 0' }}>{awaiting} observation{awaiting === 1 ? '' : 's'} awaiting review</div>
        {inbox.map((row, i) => (
          <div key={i} className="rowline"><span>{row.candidateId} — {row.answer}</span><span className="mono dim">{row.observerTag}</span></div>
        ))}
        {awaiting === 0 && <div className="dim" style={{ fontSize: 13 }}>Submit from Verify and watch this card change. Conflicting answers are kept as separate rows — never merged, never called verified.</div>}
      </div>
    </>
  );
}

/* ---------------- Case map ---------------- */
function CaseMap({ caseData, manifest, sel, onSelect, onPassport, onVerify }: {
  caseData: CaseData; manifest: Manifest; sel: Candidate;
  onSelect: (c: Candidate) => void; onPassport: () => void; onVerify: () => void;
}) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapRef2 = useRef<import('maplibre-gl').Map | null>(null);
  const [sceneOn, setSceneOn] = useState(true);
  const [dateIdx, setDateIdx] = useState(caseData.dates.length - 1);
  const dateIdxRef = useRef(dateIdx);
  dateIdxRef.current = dateIdx;
  const hh = useTick(sel.hhIntensity[dateIdx], 0);
  const hvRaw = sel.hvIntensity[dateIdx];
  const hv = useTick(hvRaw ?? 0, 0);

  useEffect(() => {
    let map: import('maplibre-gl').Map | undefined; let dead = false;
    (async () => {
      await import('maplibre-gl/dist/maplibre-gl.css');
      const ml = await import('maplibre-gl');
      if (dead || !mapRef.current) return;
      map = new ml.Map({
        container: mapRef.current,
        style: {
          version: 8,
          sources: { base: { type: 'raster', tiles: ['https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap contributors (ODbL), © CARTO' } },
          layers: [{ id: 'base', type: 'raster', source: 'base' }],
        },
        center: [caseData.site.lon, caseData.site.lat], zoom: 12,
      });
      map.on('load', async () => {
        if (!map) return;
        mapRef2.current = map;
        // The actual NISAR HH scene (browse render) under the polygons,
        // switched by the date scrubber. AOI corners, north-up.
        const scenes = await loadScenes().catch(() => ({} as Record<string, string>));
        if (!map) return;
        map.addSource('nisar-scene', {
          type: 'image',
          url: scenes[caseData.dates[dateIdxRef.current]] ?? '',
          coordinates: [[89.58, 25.70], [89.82, 25.70], [89.82, 25.44], [89.58, 25.44]],
        } as never);
        map.addLayer({ id: 'nisar-scene', type: 'raster', source: 'nisar-scene', paint: { 'raster-opacity': 0.92 } });
        // Amber hatching for the contested fringe: pattern generated at runtime.
        const cv = document.createElement('canvas'); cv.width = cv.height = 8;
        const g = cv.getContext('2d')!; g.strokeStyle = '#FFB224'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(-2, 10); g.lineTo(10, -2); g.moveTo(-2, 2); g.lineTo(2, -2); g.moveTo(6, 10); g.lineTo(10, 6); g.stroke();
        map.addImage('hatch', g.getImageData(0, 0, 8, 8));
        const fc = (c: Candidate) => ({
          type: 'FeatureCollection' as const,
          features: [
            { type: 'Feature' as const, properties: { k: 'fringe' }, geometry: { type: 'Polygon' as const, coordinates: [[...c.fringe, c.fringe[0]]] } },
            { type: 'Feature' as const, properties: { k: 'core' }, geometry: { type: 'Polygon' as const, coordinates: [[...c.core, c.core[0]]] } },
            { type: 'Feature' as const, properties: { k: 'ghost' }, geometry: { type: 'Polygon' as const, coordinates: [[...c.ghost, c.ghost[0]]] } },
          ],
        });
        for (const c of caseData.candidates) {
          map.addSource(c.id, { type: 'geojson', data: fc(c) as never });
          map.addLayer({ id: `${c.id}-fringe`, type: 'fill', source: c.id, filter: ['==', ['get', 'k'], 'fringe'], paint: { 'fill-pattern': 'hatch', 'fill-opacity': 0.9 } });
          map.addLayer({ id: `${c.id}-core`, type: 'fill', source: c.id, filter: ['==', ['get', 'k'], 'core'], paint: { 'fill-color': '#3FD0C9', 'fill-opacity': 0.5 } });
          map.addLayer({ id: `${c.id}-ghost`, type: 'line', source: c.id, filter: ['==', ['get', 'k'], 'ghost'], paint: { 'line-color': '#8A94A0', 'line-dasharray': [2, 2], 'line-width': 1 } });
        }
      });
    })();
    return () => { dead = true; map?.remove(); };
  }, [caseData]);

  useEffect(() => {
    const map = mapRef2.current;
    if (!map || !map.getSource('nisar-scene')) return;
    let live = true;
    void loadScenes().then((scenes) => {
      if (!live || !mapRef2.current) return;
      const src = mapRef2.current.getSource('nisar-scene') as unknown as { updateImage: (o: { url: string }) => void };
      const url = scenes[caseData.dates[dateIdx]];
      if (url) src.updateImage({ url });
      mapRef2.current.setLayoutProperty('nisar-scene', 'visibility', sceneOn ? 'visible' : 'none');
    });
    return () => { live = false; };
  }, [dateIdx, sceneOn, caseData]);

  const granule = manifest.granules[dateIdx];
  return (
    <>
      <div ref={mapRef} className="mapbox" />
      <div className="mono dim" style={{ fontSize: 11, marginTop: 6 }}>
        Solid = robust core · amber hatch = contested fringe · dashed = earlier boundary. Underneath: the actual NISAR HH scene for the selected date. Basemap © OSM (ODbL).
      </div>
      <button className="chip" style={{ minHeight: 40, cursor: 'pointer', color: sceneOn ? '#FFB224' : undefined }} onClick={() => setSceneOn(!sceneOn)}>
        {sceneOn ? 'NISAR SCENE: ON' : 'NISAR SCENE: OFF'}
      </button>
      <div className="scrub">
        {caseData.dates.map((d, i) => (
          <button key={d} className={i === dateIdx ? 'active' : ''} onClick={() => setDateIdx(i)}>{d.slice(5)}</button>
        ))}
      </div>
      <div className="rowline"><span>{sel.id} · {sel.title}</span><span className="mono">{caseData.dates[dateIdx]}</span></div>
      <div className="rowline"><span className="dim">HH intensity (browse, 0–255)</span><span className="mono amber">{hh}</span></div>
      <div className="rowline"><span className="dim">HV intensity (browse, 0–255)</span><span className="mono teal">{hvRaw === null ? 'no HV render this date — see Passport QA' : hv}</span></div>
      <div className="rowline"><span className="dim">Jamuna discharge (GloFAS)</span><span className="mono">{caseData.drivers.dischargeM3sByDate[caseData.dates[dateIdx]]} m³/s</span></div>
      {sel.crosscheck && <div className="dim" style={{ fontSize: 12.5, lineHeight: 1.5 }}><span className="mono teal" style={{ fontSize: 11 }}>CROSSCHECK — </span>{sel.crosscheck.reading}</div>}
      <div className="rowline"><span className="dim">Granule grid</span><span className="mono">{granule.gridM} m native GCOV · browse grid for polygons</span></div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        {caseData.candidates.map((c) => (
          <button key={c.id} className="chip" style={{ minHeight: 44, cursor: 'pointer', color: c.id === sel.id ? '#FFB224' : undefined }} onClick={() => onSelect(c)}>{c.id}</button>
        ))}
      </div>
      <button className="btn ghost" onClick={onPassport}>Change Passport — where this number came from</button>
      <button className="btn" onClick={onVerify}>Answer this case</button>
    </>
  );
}

/* ---------------- Change Passport ---------------- */
function Passport({ caseData, manifest, sel, onClose }: { caseData: CaseData; manifest: Manifest; sel: Candidate; onClose: () => void }) {
  const [snap, setSnap] = useState<'peek' | 'half' | 'full'>('half');
  const gA = manifest.granules.find((g) => g.date === caseData.pair[1])!;
  return (
    <div className={`sheet ${snap}`}>
      <div className="grip" />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="verdict" style={{ fontSize: 24 }}>Change Passport · {sel.id}</span>
        <span>
          {(['peek', 'half', 'full'] as const).map((s) => (
            <button key={s} className="chip" style={{ cursor: 'pointer', marginLeft: 4 }} onClick={() => setSnap(s)}>{s.toUpperCase()}</button>
          ))}
          <button className="chip" style={{ cursor: 'pointer', marginLeft: 4 }} onClick={onClose}>✕</button>
        </span>
      </div>
      <table><tbody>
        <tr><td>GRANULE (PAIR END)</td><td className="granule">{gA.granuleId}</td></tr>
        <tr><td>DATES</td><td className="mono">{caseData.pair[0]} → {caseData.pair[1]} · same track 19, same 20 MHz DH product family</td></tr>
        <tr><td>VARIABLE</td><td>{manifest.variableLabel} — measured here from the ASF browse render of HHHH/HVHV (see Method)</td></tr>
        <tr><td>LAYERS SHOWN</td><td className="mono">{gA.layersFrequencyA.join(', ')} — only polarizations in this granule</td></tr>
        <tr><td>METHOD</td><td style={{ fontSize: 12 }}>{manifest.method}</td></tr>
        <tr><td>THRESHOLD</td><td style={{ fontSize: 12 }}>{caseData.thresholdNote}</td></tr>
        <tr><td>AREA</td><td className="mono">{sel.areaHa} ha on the browse grid ({manifest.browseGrid?.haPerPixel} ha/pixel, ~50 m) · robust core {sel.robustAreaHa} ha · native GCOV grid is {manifest.commonGridM} m</td></tr>
        <tr><td>DRIVERS</td><td className="mono">Discharge {caseData.drivers.dischargeM3sByDate[caseData.pair[0]]} → {caseData.drivers.dischargeM3sByDate[caseData.pair[1]]} m³/s (GloFAS) · rain over the pair {caseData.drivers.rainPairTotalMm} mm (NASA POWER)</td></tr>
        <tr><td>EXPOSURE</td><td className="mono">{manifest.exposure?.buildingsWithin1km?.[sel.id] ?? '—'} mapped buildings within 1 km (OSM, © contributors, ODbL) · {manifest.exposure?.namedSettlementsInAOI} named settlements in the case area · WorldPop 2020: ≈{manifest.exposureWorldPop?.population[sel.id]?.core.toLocaleString()} people inside the robust core, ≈{manifest.exposureWorldPop?.population[sel.id]?.corePlusFringe.toLocaleString()} including the fringe</td></tr>
        {sel.crosscheck && <tr><td>CROSSCHECK</td><td style={{ fontSize: 12 }}>Sentinel-1 C-band VV {sel.crosscheck.s1.vvDbA} → {sel.crosscheck.s1.vvDbB} dB ({sel.crosscheck.s1.dateA} → {sel.crosscheck.s1.dateB}, calibrated gamma-0) · Sentinel-2 NDWI water fraction {sel.crosscheck.s2.ndwiWaterFracJul} → {sel.crosscheck.s2.ndwiWaterFracOct} (4 Jul → 12 Oct). {sel.crosscheck.reading}</td></tr>}
        <tr><td>PRODUCT</td><td className="mono">{manifest.product.collection} · {manifest.product.maturity} · CRID {manifest.product.crid}</td></tr>
        <tr><td>QC FLAGS</td><td style={{ fontSize: 12 }}>orbit accuracy {gA.orbitAccuracy} · {(manifest.qaFlags ?? []).join(' ')}</td></tr>
        <tr><td>MANIFEST HASH</td><td className="granule">{manifest.manifestHash}</td></tr>
        <tr><td>PROVENANCE</td><td><span className="chip teal">{sel.provenance}</span> <span className="chip">MEASURED: CATALOGUE + BROWSE</span></td></tr>
      </tbody></table>
      <p className="dim" style={{ fontSize: 12 }}>This polygon was computed from real NISAR imagery of these two granules. The one upgrade left is radiometric: calibrated float gamma-0 from the .h5 (Earthdata login) instead of the browse render — same pipeline, better numbers.</p>
      <PassportShare caseData={caseData} sel={sel} />
    </div>
  );
}

function PassportShare({ caseData, sel }: { caseData: CaseData; sel: Candidate }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/?case=${caseData.caseId}&candidate=${sel.id}`;
  useEffect(() => {
    if (canvasRef.current) {
      void QRCode.toCanvas(canvasRef.current, url, { width: 148, margin: 1, color: { dark: '#0A0E12', light: '#E8E4DA' } });
    }
  }, [url]);
  async function share() {
    const text = `TRACE Field case ${sel.id} — ${sel.title}. ${sel.question} Open the case: ${url}`;
    if (navigator.share) { try { await navigator.share({ title: 'TRACE Field case', text, url }); return; } catch { /* user cancelled */ } }
    try { await navigator.clipboard.writeText(text); setCopied(true); } catch { /* clipboard unavailable */ }
  }
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 12 }}>
      <canvas ref={canvasRef} width={148} height={148} style={{ borderRadius: 6, flex: 'none' }} />
      <div>
        <div className="mono amber" style={{ fontSize: 11, letterSpacing: 1.5 }}>HAND THIS CASE ON</div>
        <p className="dim" style={{ fontSize: 12.5 }}>Scan to open this exact case on another phone, or share the link. The case file carries its own manifest hash, so the copy can be checked against this one.</p>
        <button className="btn" onClick={share}>{copied ? 'Link copied' : 'Share case link'}</button>
      </div>
    </div>
  );
}

/* ---------------- Verify ---------------- */
const ANSWERS: { id: ObsAnswer; label: string }[] = [
  { id: 'water', label: 'Water' }, { id: 'wet-land', label: 'Wet land' }, { id: 'sandbar', label: 'Sandbar' },
  { id: 'vegetation', label: 'Vegetation / crop' }, { id: 'not-observable', label: 'Not observable' },
];
function Verify({ caseData, sel, onSelect }: { caseData: CaseData; sel: Candidate; onSelect: (c: Candidate) => void }) {
  const [answer, setAnswer] = useState<ObsAnswer | null>(null);
  const [note, setNote] = useState('');
  const [pos, setPos] = useState<{ lat: number; lon: number; acc: number } | null>(null);
  const [photo, setPhoto] = useState<Blob | undefined>();
  const [voice, setVoice] = useState<Blob | undefined>();
  const [rec, setRec] = useState(false);
  const [mine, setMine] = useState<Observation[]>([]);
  const recRef = useRef<MediaRecorder | null>(null);

  const refresh = async () => setMine(await db.observations.orderBy('id').reverse().limit(10).toArray());
  useEffect(() => { refresh(); const i = setInterval(refresh, 2000); return () => clearInterval(i); }, []);

  function getGps() {
    navigator.geolocation?.getCurrentPosition(
      (p) => setPos({ lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy) }),
      () => setPos(null), { enableHighAccuracy: true, timeout: 15000 });
  }
  async function toggleVoice() {
    if (rec) { recRef.current?.stop(); setRec(false); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream); const chunks: Blob[] = [];
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.onstop = () => { setVoice(new Blob(chunks, { type: 'audio/webm' })); stream.getTracks().forEach((t) => t.stop()); };
      mr.start(); recRef.current = mr; setRec(true);
    } catch { /* mic denied — voice note is optional */ }
  }
  async function submit() {
    if (!answer) return;
    const distKm = pos ? haversineKm(pos.lat, pos.lon, sel.centroid[1], sel.centroid[0]) : Infinity;
    const obs: Observation = {
      caseCandidateId: sel.id, answer, note,
      lat: pos?.lat ?? null, lon: pos?.lon ?? null, accuracyM: pos?.acc ?? null,
      takenAt: new Date().toISOString(), photo, voice, status: 'queued',
      observerTag: distKm <= 25 ? 'Field observer' : 'Demo observer, not at case site',
    };
    await db.observations.add(obs);
    if (navigator.onLine) { try { await syncAllQueued(); } catch { /* remains queued */ } }
    if ('vibrate' in navigator) navigator.vibrate(30);
    setAnswer(null); setNote(''); setPhoto(undefined); setVoice(undefined); refresh();
  }

  const dist = pos ? haversineKm(pos.lat, pos.lon, sel.centroid[1], sel.centroid[0]) : null;
  const brg = pos ? Math.round(bearingDeg(pos.lat, pos.lon, sel.centroid[1], sel.centroid[0])) : null;

  return (
    <>
      <div className="mono amber" style={{ fontSize: 11, letterSpacing: 1.5 }}>VERIFY · {sel.id}</div>
      <h1 style={{ fontSize: 25, margin: '6px 0' }}>{sel.question}</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        {caseData.candidates.map((c) => (
          <button key={c.id} className="chip" style={{ minHeight: 44, cursor: 'pointer', color: c.id === sel.id ? '#FFB224' : undefined }} onClick={() => onSelect(c)}>{c.id}</button>
        ))}
      </div>
      <div className="choices">
        {ANSWERS.map((a) => (
          <button key={a.id} className={answer === a.id ? 'active' : ''} onClick={() => setAnswer(a.id)}>{a.label}</button>
        ))}
      </div>
      <button className="btn ghost" onClick={getGps}>Get GPS fix</button>
      {pos && <div className="acc-ring" style={{ marginTop: 8 }}>
        {pos.lat.toFixed(5)}, {pos.lon.toFixed(5)} · accuracy ±{pos.acc} m
        {dist !== null && <> · Point &amp; Prove (approximate): {dist.toFixed(1)} km to the polygon, bearing {brg}°</>}
      </div>}
      <label className="btn ghost" style={{ textAlign: 'center' }}>
        {photo ? 'Photo attached ✓' : 'Take / attach photo'}
        <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => setPhoto(e.target.files?.[0])} />
      </label>
      <button className="btn ghost" onClick={toggleVoice}>{rec ? 'Stop voice note' : voice ? 'Voice note attached ✓' : 'Add voice note (optional)'}</button>
      <textarea rows={3} placeholder="Note — what did you actually see?" value={note} onChange={(e) => setNote(e.target.value)} style={{ marginTop: 10 }} />
      <button className="btn" disabled={!answer} onClick={submit}>Submit evidence</button>
      <p className="dim" style={{ fontSize: 12 }}>Your photo is evidence for review, not ground truth. Submissions are never labelled “verified”.</p>
      {mine.length > 0 && <>
        <div className="mono" style={{ fontSize: 11, letterSpacing: 1.5, marginTop: 14 }}>YOUR QUEUE</div>
        {mine.map((o) => (
          <div key={o.id} className="rowline"><span>{o.caseCandidateId} — {o.answer}</span><span className="chip">{o.status.replace('-', ' ').toUpperCase()}</span></div>
        ))}
        <button className="btn ghost" onClick={() => syncAllQueued().then(refresh)}>Sync now</button>
      </>}
    </>
  );
}

/* ---------------- Walk on the Radar ---------------- */
function WalkRadar({ caseData }: { caseData: CaseData }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [val, setVal] = useState<number | null>(null);
  const audioRef = useRef<{ ctx: AudioContext; osc: OscillatorNode } | null>(null);
  const grid = useMemo(() => {
    // REAL field: NISAR HH browse intensity over the case AOI, latest date,
    // computed by precompute.py from the actual granule — not a simulation.
    const values = caseData.walkGrid.values;
    return { N: values.length, cells: values.flat() };
  }, [caseData]);
  const [gpsOn, setGpsOn] = useState(false);
  const [posPx, setPosPx] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const cv = canvasRef.current; if (!cv) return;
    const g = cv.getContext('2d')!; const { N, cells } = grid; const s = cv.width / N;
    for (let i = 0; i < cells.length; i++) {
      const v = cells[i]; const t = Math.max(0, Math.min(1, v / 255));
      g.fillStyle = v < 45 ? '#12484d' : `rgb(${Math.round(30 + t * 225)},${Math.round(40 + t * 140)},${Math.round(45 + t * 40)})`;
      g.fillRect((i % N) * s, Math.floor(i / N) * s, s + 1, s + 1);
    }
    if (posPx) {
      g.strokeStyle = '#FFB224'; g.lineWidth = 3;
      g.beginPath(); g.arc(posPx.x * cv.width, posPx.y * cv.height, 10, 0, Math.PI * 2); g.stroke();
      g.fillStyle = '#FFB224'; g.beginPath(); g.arc(posPx.x * cv.width, posPx.y * cv.height, 3, 0, Math.PI * 2); g.fill();
    }
  }, [grid, posPx]);

  // GPS walk: your position inside the case area samples the same real grid.
  useEffect(() => {
    if (!gpsOn || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition((p) => {
      const lon = p.coords.longitude, lat = p.coords.latitude;
      const fx = (lon - 89.58) / (89.82 - 89.58);
      const fy = (25.70 - lat) / (25.70 - 25.44);
      if (fx < 0 || fx > 1 || fy < 0 || fy > 1) { setPosPx(null); return; }
      setPosPx({ x: fx, y: fy });
      const gx = Math.min(grid.N - 1, Math.floor(fx * grid.N));
      const gy = Math.min(grid.N - 1, Math.floor(fy * grid.N));
      setVal(grid.cells[gy * grid.N + gx]);
    }, () => setGpsOn(false), { enableHighAccuracy: true });
    return () => navigator.geolocation.clearWatch(id);
  }, [gpsOn, grid]);

  function probe(e: React.PointerEvent) {
    const cv = canvasRef.current!; const r = cv.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * grid.N);
    const y = Math.floor(((e.clientY - r.top) / r.height) * grid.N);
    const v = grid.cells[Math.max(0, Math.min(grid.cells.length - 1, y * grid.N + x))];
    if (v !== val) {
      setVal(v);
      if ('vibrate' in navigator) navigator.vibrate(8); // Android only — iOS Safari has no vibrate
      try {
        if (!audioRef.current) {
          const ctx = new AudioContext(); const osc = ctx.createOscillator(); const gain = ctx.createGain();
          gain.gain.value = 0.04; osc.connect(gain); gain.connect(ctx.destination); osc.start();
          audioRef.current = { ctx, osc };
        }
        audioRef.current.osc.frequency.value = 110 + (v / 255) * 660;
      } catch { /* audio is an encoding aid, not required */ }
    }
  }
  const cls = val === null ? '' : val < 45 ? 'consistent with smooth open water (dark — specular reflection)' : val > 120 ? 'consistent with rough or vegetated land (bright)' : 'in between — wet land or sand, the contested zone';
  return (
    <>
      <div className="mono amber" style={{ fontSize: 11, letterSpacing: 1.5 }}>WALK ON THE RADAR · <span className="chip teal">REAL NISAR HH · {caseData.walkGrid.date}</span></div>
      <h1 style={{ fontSize: 25, margin: '6px 0' }}>Drag a finger across the scene</h1>
      <div className="walk" onPointerMove={probe} onPointerDown={probe}>
        <canvas ref={canvasRef} width={480} height={480} />
        <div className="dbread">{val === null ? 'HH —' : `HH ${Math.round(val)} / 255`}</div>
      </div>
      <button className="btn ghost" onClick={() => setGpsOn(!gpsOn)}>{gpsOn ? 'GPS walk: on — you are the amber ring' : 'Walk it with GPS instead'}</button>
      {gpsOn && !posPx && <p className="dim" style={{ fontSize: 12.5 }}>GPS is on but you are outside the case area (the Jamuna reach around Chilmari) — the ring appears when you step inside it.</p>}
      <p className="dim" style={{ fontSize: 13 }}>
        {val !== null && <span className="mono" style={{ color: 'var(--bone)' }}>Under your finger: {cls}. </span>}
        Pitch and vibration follow the real HH browse intensity under your finger — dark smooth water low, bright land high.
        Walk it with GPS on site, or drag from a chair. <em>An encoding of data, not a sound from space.</em>
      </p>
    </>
  );
}

/* ---------------- My Place + field guide ---------------- */
function MyPlace({ caseData, sel }: { caseData: CaseData; sel: Candidate }) {
  const last = caseData.dates[caseData.dates.length - 1];
  const next = useMemo(() => nextPass(last), [last]);
  const days = Math.max(0, Math.ceil((next.getTime() - Date.now()) / 86400000));
  const daysTick = useTick(days, 0);
  function speak() {
    try {
      const u = new SpeechSynthesisUtterance(caseData.placeWatch.bn); u.lang = 'bn-BD';
      speechSynthesis.speak(u); // fallback only — a recorded human voice replaces this when available
    } catch { /* captions below always work offline */ }
  }
  void sel;
  return (
    <>
      <div className="mono amber" style={{ fontSize: 11, letterSpacing: 1.5 }}>MY PLACE WATCH · {caseData.site.name.toUpperCase()}</div>
      <p className="bn" style={{ fontSize: 19, lineHeight: 1.6 }}>{caseData.placeWatch.bn}</p>
      <p className="dim" style={{ fontSize: 13 }}>{caseData.placeWatch.en}</p>
      <button className="btn ghost" onClick={speak}>Play Bangla brief</button>
      <div className="rowline"><span>Next NISAR pass (track 19)</span><span className="mono amber">{next.toISOString().slice(0, 10)}</span></div>
      <div className="rowline"><span>Countdown</span><span className="mono">{daysTick} days · last pass + 12-day cycles</span></div>

      <div className="mono" style={{ fontSize: 11, letterSpacing: 1.5, margin: '18px 0 8px' }}>SAR FIELD GUIDE</div>
      {[
        ['Why smooth water is dark', 'A calm surface reflects the radar pulse away from the satellite — specular reflection — so almost nothing returns. Rough or flooded ground scatters some back.'],
        ['L-band vs C-band', 'NISAR L-band (~24 cm) penetrates canopy further than Sentinel-1 C-band (~5.6 cm). Sentinel-1 is radar too — not optical.'],
        ['Why 12 days', 'NISAR repeats the same track every 12 days. Change detection compares same-track passes, so geometry matches and the difference is the ground, not the view.'],
        ['What HH and HV see', 'HH is the surface / double-bounce channel — flooded vegetation is often bright at L-band. HV is volume scattering from canopy. Wet soil is not automatically dark; roughness and moisture both matter.'],
      ].map(([t, b]) => (
        <div key={t} className="guide-card"><h3>{t}</h3><div className="dim" style={{ fontSize: 14, lineHeight: 1.5 }}>{b}</div></div>
      ))}
      <p className="dim" style={{ fontSize: 12 }}>Field Story is intentionally empty: it takes one real voice-and-photo pin from the team, and nothing invented.</p>
    </>
  );
}
