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
  { id: 'inbox', label: 'MISSION' }, { id: 'map', label: 'MAP' }, { id: 'verify', label: 'VERIFY' },
  { id: 'radar', label: 'LAB' }, { id: 'place', label: 'MY PLACE' },
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
        <div>
          <div className="brand">TRACE <em>Field</em></div>
          <div className="tag">THE SATELLITE ASKS · YOU ANSWER</div>
        </div>
        <div className="livecase">
          CASE <b>{caseData.caseId}</b><br />{caseData.site.name.toUpperCase()}
          {queuedCount > 0 && <><br /><span className="queuepill">{queuedCount} TO SYNC</span></>}
        </div>
      </header>
      <main>
        {tab === 'inbox' && <Inbox caseData={caseData} onOpen={(c) => { setSelected(c); setTab('map'); }} queuedCount={queuedCount} />}
        {tab === 'map' && <CaseMap caseData={caseData} manifest={manifest} sel={sel} onSelect={setSelected} onPassport={() => setPassport(true)} onVerify={() => setTab('verify')} />}
        {tab === 'verify' && <Verify caseData={caseData} sel={sel} onSelect={setSelected} />}
        {tab === 'radar' && <><WalkRadar caseData={caseData} />{caseData.deltaGrid && <ThresholdLab caseData={caseData} />}</>}
        {tab === 'place' && <MyPlace caseData={caseData} sel={sel} />}
      </main>
      <nav className="tabbar">
        {TABS.map((t, i) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            <span className="n">0{i + 1}</span>
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
  const replay = [
    ...caseData.dates.map((d) => ({ t: d, label: `NISAR pass — track 19 frame 076 acquired`, kind: 'pass' as const })),
    ...inbox.map((o) => ({ t: o.takenAt.slice(0, 10), label: `Field evidence: ${o.candidateId} — ${o.answer}${o.relation ? ` (${o.relation})` : ''} · awaiting review`, kind: 'evidence' as const })),
  ].sort((a, b) => a.t.localeCompare(b.t));

  async function downloadCase() {
    // 1) Case JSON + shell into the case cache (the progress ring's first half).
    const urls = ['/data/case.json', '/data/manifest.json', '/data/scenes.json', '/data/audio.json', '/', '/icons/icon.svg'];
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
      <div className="hero sweep">
        <div className="kick">MISSION INBOX · TRACK 19 · FRAME 076</div>
        <h1>The satellite is <em>unsure</em> about {caseData.candidates.length} places near you.</h1>
        <div className="sub">{caseData.site.name} — it never asks you to confirm what it already knows. Your eyes finish the measurement.</div>
        <div className="strip">
          <div><div className="k">NISAR PASSES</div><div className="v">{r.nisarTotal} <small>same track</small></div></div>
          <div><div className="k">RIVER FELL</div><div className="v">{caseData.drivers.dischargeM3sByDate[caseData.pair[0]]}→{caseData.drivers.dischargeM3sByDate[caseData.pair[1]]} <small>m³/s</small></div></div>
          <div><div className="k">NEXT PASS</div><div className="v">{nextPass(caseData.dates[caseData.dates.length - 1]).toISOString().slice(5, 10)}</div></div>
        </div>
      </div>

      <div className="sect">
        <div className="sect-h"><span className="idx">01</span><span className="name">THE CASES</span><span className="rule" /><span className="meta">TAP TO OPEN THE MAP</span></div>
        {caseData.candidates.map((c) => (
          <button key={c.id} className="card" onClick={() => onOpen(c)}>
            <div className="chead">
              <span className="cid">{c.id}</span>
              <span className="chip sim">{c.provenance}</span>
              <span className="chip">{c.status.replace('-', ' ').toUpperCase()}</span>
            </div>
            <div className="q">{c.question}</div>
            <div className="cfoot">
              <div><div className="k">DISTANCE</div><div className="v">{c.distanceKm} km</div></div>
              <div><div className="k">ROBUST CORE</div><div className="v">{c.robustAreaHa} ha</div></div>
              <div><div className="k">Δ HH · CALIBRATED</div><div className="v">{c.calibrated ? `+${c.calibrated.dDbHH} dB` : '—'}</div></div>
            </div>
          </button>
        ))}
      </div>

      <div className="sect">
        <div className="sect-h"><span className="idx">02</span><span className="name">FIELD KIT</span><span className="rule" /></div>
        <div className="ringwrap">
          <svg className="progress-ring" width="52" height="52">
            <circle cx="26" cy="26" r="21" fill="none" stroke="#1F2A33" strokeWidth="4" />
            <circle cx="26" cy="26" r="21" fill="none" stroke="#FFB224" strokeWidth="4"
              strokeDasharray={2 * Math.PI * 21} strokeDashoffset={dl < 0 ? 2 * Math.PI * 21 : 2 * Math.PI * 21 * (1 - dl / 100)} transform="rotate(-90 26 26)" />
          </svg>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15 }}>Offline pack</div>
            <div className="dim" style={{ fontSize: 12.5 }}>{dl < 0 ? 'Case, scenes, audio and map tiles — before you leave signal.' : dl < 100 ? `Caching… ${dl}%` : 'Cached. Airplane mode is fine now.'}</div>
          </div>
        </div>
        <div className="btnrow" style={{ marginTop: 12 }}>
          <button className="btn ghost" onClick={downloadCase}>Download case</button>
          {queuedCount > 0 && <button className="btn" onClick={() => syncAllQueued()}>Sync now · {queuedCount}</button>}
        </div>
      </div>

      <div className="sect">
        <div className="sect-h"><span className="idx">03</span><span className="name">WHY THE RIVER MOVED</span><span className="rule" /></div>
        <div className="ledger">
          <div className="rowline"><span className="lab">Discharge · {caseData.pair[0]}</span><span className="val">{caseData.drivers.dischargeM3sByDate[caseData.pair[0]].toLocaleString()} m³/s</span></div>
          <div className="rowline"><span className="lab">Discharge · {caseData.pair[1]}</span><span className="val">{caseData.drivers.dischargeM3sByDate[caseData.pair[1]].toLocaleString()} m³/s</span></div>
          <div className="rowline"><span className="lab">Rain over the pair window</span><span className="val">{caseData.drivers.rainPairTotalMm} mm</span></div>
          <div className="rowline"><span className="lab">Optical clear views</span><span className="val">{r.opticalClear} of {r.opticalTotal} dates</span></div>
          <div className="rowline"><span className="lab">L-band passes seen</span><span className="val">{r.nisarSeen} of {r.nisarTotal}</span></div>
        </div>
        <div className="dim" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.55 }}>Discharge: GloFAS via Open-Meteo Flood API. Rain: NASA POWER. The FFWC Chilmari gauge has no public API — discharge stands in for stage, and says so.</div>
      </div>

      <div className="sect">
        <div className="sect-h"><span className="idx">04</span><span className="name">MISSION REPLAY</span><span className="rule" /><span className="meta">{replay.length} EVENTS</span></div>
        <details className="acc">
          <summary><span className="t">How this investigation unfolded</span><span className="plus">+</span></summary>
          <div className="body">
            {replay.map((e, i) => (
              <div key={i} className="rowline"><span className="mono dim" style={{ fontSize: 12 }}>{e.t}</span><span style={{ fontSize: 13, color: e.kind === 'evidence' ? 'var(--amber)' : 'var(--bone)' }}>{e.label}</span></div>
            ))}
          </div>
        </details>
      </div>

      <div className="sect">
        <div className="sect-h"><span className="idx">05</span><span className="name">EVIDENCE RETURN</span><span className="rule" /></div>
        <div className="verdict-n">{awaiting} observation{awaiting === 1 ? '' : 's'} awaiting review</div>
        <div className="ledger" style={{ marginTop: 8 }}>
          {inbox.map((row, i) => (
            <div key={i} className="rowline"><span>{row.candidateId} — {row.answer}{row.relation ? ` · ${row.relation}` : ''}</span><span className="mono dim" style={{ fontSize: 11 }}>{row.observerTag}</span></div>
          ))}
        </div>
        {awaiting === 0 && <div className="dim" style={{ fontSize: 13, marginTop: 8, lineHeight: 1.55 }}>Submit from Verify and watch this list change. Conflicting answers are kept as separate rows — never merged, never called verified.</div>}
      </div>
    </>
  );
}

/* ---------------- Plain language (H6) ---------------- */
function PlainWords({ caseData, sel }: { caseData: CaseData; sel: Candidate }) {
  const [open, setOpen] = useState(false);
  const d0 = caseData.drivers.dischargeM3sByDate[caseData.pair[0]];
  const d1 = caseData.drivers.dischargeM3sByDate[caseData.pair[1]];
  const dirEn = sel.meanDelta < 0 ? 'went darker — the surface became smoother, consistent with standing water' : 'came back bright — the surface became rougher or drier';
  const dirBn = sel.meanDelta < 0 ? 'আগের চেয়ে অন্ধকার হয়েছে — পৃষ্ঠ মসৃণ হয়েছে, যা জমে থাকা পানির সঙ্গে মেলে' : 'আগের চেয়ে উজ্জ্বল হয়েছে — পৃষ্ঠ শুকিয়েছে বা খসখসে হয়েছে';
  return (
    <div style={{ marginTop: 6 }}>
      <button className="chip" style={{ minHeight: 40, cursor: 'pointer', color: open ? '#FFB224' : undefined }} onClick={() => setOpen(!open)}>PLAIN WORDS · সহজ ভাষায়</button>
      {open && (
        <div style={{ marginTop: 10, border: "1px solid var(--hair)", background: "var(--panel2)", padding: 16 }}>
          <div style={{ fontSize: 14.5, lineHeight: 1.55 }}>
            Satellite observations indicate a candidate surface transition at {sel.title.toLowerCase()}. The mapped area is {sel.areaHa} hectares ({sel.robustAreaHa} hectares of it robust across every tested setting). Between {caseData.pair[0]} and {caseData.pair[1]} this ground {dirEn}. River discharge fell from {d0} to {d1} cubic metres per second over the same window. River-stage differences and classification uncertainty affect how confidently this can be read as erosion — which is why a person on the ground is being asked.
          </div>
          <div className="bn" style={{ fontSize: 15.5, lineHeight: 1.65, marginTop: 10 }}>
            স্যাটেলাইটের ছবিতে {sel.id} এলাকায় মাটির চেহারা বদলের ইঙ্গিত মিলেছে। মোট এলাকা {sel.areaHa} হেক্টর, যার {sel.robustAreaHa} হেক্টর সব পরীক্ষায় টিকে আছে। এই জায়গাটি {dirBn}। একই সময়ে নদীর পানির প্রবাহ {d0} থেকে কমে {d1} ঘনমিটার প্রতি সেকেন্ডে নেমেছে। এটি স্থায়ী ভাঙন কিনা, তা মাঠে গিয়ে দেখলেই নিশ্চিত হওয়া যাবে।
          </div>
        </div>
      )}
    </div>
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
      <div className="mapwrap">
        <div ref={mapRef} className="mapbox" />
        <div className="mapctl">
          <button className="chip" style={{ color: sceneOn ? '#FFB224' : '#8A94A0', borderColor: sceneOn ? '#FFB224' : '#2A3641' }} onClick={() => setSceneOn(!sceneOn)}>
            NISAR SCENE {sceneOn ? 'ON' : 'OFF'}
          </button>
        </div>
        <div className="maplegend">
          <span className="amber">■</span> ROBUST CORE&nbsp;&nbsp;<span style={{ color: '#C77F1A' }}>▨</span> FRINGE&nbsp;&nbsp;<span>┄</span> JULY WATER
        </div>
      </div>

      <div className="seg">
        {caseData.candidates.map((c) => (
          <button key={c.id} className={c.id === sel.id ? 'active' : ''} onClick={() => onSelect(c)}>{c.id}</button>
        ))}
      </div>

      <div className="sect" style={{ marginTop: 22 }}>
        <div className="sect-h"><span className="idx">◆</span><span className="name">{sel.id} — {sel.title.toUpperCase()}</span><span className="rule" /><span className="meta">{caseData.dates[dateIdx]}</span></div>
        <div className="verdict-n">{sel.question}</div>
        <div className="scrub">
          {caseData.dates.map((d, i) => (
            <button key={d} className={i === dateIdx ? 'active' : ''} onClick={() => setDateIdx(i)}>{d.slice(5)}</button>
          ))}
        </div>
        <div className="dim" style={{ fontSize: 11.5, marginTop: 8 }}>Granule grid {granule.gridM} m native GCOV. Basemap © OSM (ODbL). Polygons and scenes load from case data — nothing is drawn by hand.</div>
        <div className="ledger" style={{ marginTop: 10 }}>
          <div className="rowline"><span className="lab">HH intensity (browse)</span><span className="val">{hh} / 255</span></div>
          <div className="rowline"><span className="lab">HV intensity (browse)</span><span className="val">{hvRaw === null ? 'NO HV RENDER — SEE PASSPORT QA' : `${hv} / 255`}</span></div>
          <div className="rowline"><span className="lab">Discharge (GloFAS)</span><span className="val">{caseData.drivers.dischargeM3sByDate[caseData.dates[dateIdx]].toLocaleString()} m³/s</span></div>
          {sel.calibrated && (caseData.dates[dateIdx] === caseData.pair[0] || caseData.dates[dateIdx] === caseData.pair[1]) && (
            <div className="rowline"><span className="lab">HH gamma-0 · calibrated</span><span className="val amber">{caseData.dates[dateIdx] === caseData.pair[0] ? sel.calibrated.hhDbA : sel.calibrated.hhDbB} dB · pair {sel.calibrated.dDbHH > 0 ? '+' : ''}{sel.calibrated.dDbHH} dB</span></div>
          )}
        </div>
        {sel.crosscheck && <div className="reading"><span className="rk">CROSSCHECK — INDEPENDENT SENSORS</span>{sel.crosscheck.reading}</div>}
        <PlainWords caseData={caseData} sel={sel} />
        <div className="actionbar">
          <button className="btn" onClick={onVerify}>Answer this case</button>
          <button className="btn ghost" onClick={onPassport}>Change Passport — provenance</button>
        </div>
      </div>
    </>
  );
}

function downloadReport(caseData: CaseData, manifest: Manifest, c: Candidate) {
  const g = manifest.granules;
  const lines = [
    `# TRACE Field — case report ${c.id}`,
    ``,
    `Site: ${caseData.site.name} · Case ${caseData.caseId}`,
    `Pair: ${caseData.pair[0]} → ${caseData.pair[1]} (same track 19, 12-day repeat family)`,
    ``,
    `## Finding`,
    `${c.title}. Mapped area ${c.areaHa} ha; robust core ${c.robustAreaHa} ha (persists across all 12 tested settings — a robustness measure, not a probability).`,
    `Mean normalised HH change ${c.meanDelta} (${c.direction}). Provenance: ${c.provenance}.`,
    c.crosscheck ? `Crosscheck: S1 VV ${c.crosscheck.s1.vvDbA} → ${c.crosscheck.s1.vvDbB} dB; S2 NDWI water ${c.crosscheck.s2.ndwiWaterFracJul} → ${c.crosscheck.s2.ndwiWaterFracOct}. ${c.crosscheck.reading}` : `Crosscheck: not available.`,
    ``,
    `## Exposure (labelled estimates, not damage)`,
    `OSM buildings within 1 km of the centre: ${manifest.exposure?.buildingsWithin1km?.[c.id] ?? 'unknown'} (a floor, not a census). WorldPop 2020 population inside the robust core: ~${manifest.exposureWorldPop?.population[c.id]?.core ?? 'unknown'}; including fringe: ~${manifest.exposureWorldPop?.population[c.id]?.corePlusFringe ?? 'unknown'}. Exposure is not damage.`,
    ``,
    `## Drivers`,
    `GloFAS discharge: ${caseData.drivers.dischargeM3sByDate[caseData.pair[0]]} → ${caseData.drivers.dischargeM3sByDate[caseData.pair[1]]} m3/s. NASA POWER rain over the pair window: ${caseData.drivers.rainPairTotalMm} mm. FFWC gauge stage has no public API; discharge is the labelled substitute.`,
    ``,
    `## Provenance`,
    `Start granule: ${g[1].granuleId}`,
    `End granule: ${g[g.length - 1].granuleId}`,
    `Product: NISAR L2 GCOV PROVISIONAL V1. Values shown in the app are browse intensity (0-255), not calibrated dB, until the GCOV float pipeline lands.`,
    `Case hash: ${caseData.caseHash} · Manifest hash: ${caseData.manifestHash}`,
    ``,
    `## Labels`,
    `MEASURED = from an identified observation. DERIVED = computed from specified inputs. CROSSCHECKED = compared with independent compatible evidence. A field photo is evidence awaiting review, never automatic verification.`,
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `trace-report-${c.id}.md`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
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
/* ---------------- Point & Prove (A2) ----------------
   Live camera + direction/distance/accuracy to the selected candidate.
   The overlay is indicative only and is labelled APPROXIMATE — phone GPS
   error and heading error apply; it is not an alignment proof. */
function PointProve({ sel }: { sel: Candidate }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [camOn, setCamOn] = useState(false);
  const [pos, setPos] = useState<{ lat: number; lon: number; acc: number } | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  useEffect(() => {
    if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (p) => setPos({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
      () => {}, { enableHighAccuracy: true });
    const onOri = (e: DeviceOrientationEvent) => {
      const h = (e as unknown as { webkitCompassHeading?: number }).webkitCompassHeading ?? (e.alpha !== null ? 360 - e.alpha : null);
      if (h !== null && !Number.isNaN(h)) setHeading(h);
    };
    window.addEventListener('deviceorientationabsolute', onOri);
    window.addEventListener('deviceorientation', onOri);
    return () => { navigator.geolocation.clearWatch(id); window.removeEventListener('deviceorientationabsolute', onOri); window.removeEventListener('deviceorientation', onOri); };
  }, []);
  useEffect(() => () => { streamRef.current?.getTracks().forEach((t) => t.stop()); }, []);
  async function toggleCam() {
    if (camOn) { streamRef.current?.getTracks().forEach((t) => t.stop()); setCamOn(false); return; }
    try {
      const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = st;
      if (videoRef.current) { videoRef.current.srcObject = st; await videoRef.current.play(); }
      setCamOn(true);
    } catch { /* camera denied — the numeric bearing/distance below still works */ }
  }
  const [clon, clat] = sel.centroid;
  const km = pos ? haversineKm(pos.lat, pos.lon, clat, clon) : null;
  const bear = pos ? bearingDeg(pos.lat, pos.lon, clat, clon) : null;
  const arrowDeg = bear !== null ? bear - (heading ?? 0) : 0;
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="mono" style={{ fontSize: 11, letterSpacing: 1.5 }}>POINT &amp; PROVE · {sel.id}</div>
      <div style={{ position: 'relative', marginTop: 8, overflow: 'hidden', background: '#000', border: '1px solid var(--hair)', minHeight: camOn ? undefined : 0 }}>
        <video ref={videoRef} playsInline muted style={{ width: '100%', display: camOn ? 'block' : 'none' }} />
        {camOn && (
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            <div style={{ position: 'absolute', top: 8, left: 8 }} className="chip">APPROXIMATE</div>
            <div style={{ position: 'absolute', top: '38%', left: '50%', transform: `translate(-50%,-50%) rotate(${arrowDeg}deg)`, fontSize: 44, color: '#FFB224', textShadow: '0 0 8px #000' }}>↑</div>
            <div className="mono" style={{ position: 'absolute', bottom: 8, left: 8, right: 8, fontSize: 12, color: '#E8E4DA', textShadow: '0 0 6px #000' }}>
              {km !== null ? `${km.toFixed(2)} km to ${sel.id} centre` : 'waiting for GPS'} · GPS ±{pos ? Math.round(pos.acc) : '—'} m · the ring you must search is the accuracy, not a point
            </div>
          </div>
        )}
      </div>
      <button className="btn ghost" onClick={toggleCam}>{camOn ? 'Stop camera' : 'Open camera — point at the target'}</button>
      <div className="rowline"><span className="dim">Bearing to {sel.id}</span><span className="mono">{bear !== null ? `${Math.round(bear)}°` : '—'}{heading !== null ? ` · phone heading ${Math.round(heading)}°` : ' · allow motion sensors for live heading'}</span></div>
      <div className="dim" style={{ fontSize: 12 }}>Approximate by design: GPS and compass error are shown, never hidden. The satellite outline is indicative at this scale.</div>
    </div>
  );
}

function exportStory(caseData: CaseData, rows: Observation[]) {
  const lines = [
    `# Field story — ${caseData.site.name} (${caseData.caseId})`,
    ``,
    `Exported from TRACE Field. Every record below is evidence awaiting review — none of it is verified ground truth.`,
    ``,
    ...rows.map((o) => `- **${o.takenAt}** · ${o.caseCandidateId}: answered "${o.answer}"${o.relation ? ` — ${o.relation} the satellite reading` : ''}${o.lat !== null ? ` · GPS ${o.lat}, ${o.lon} (±${o.accuracyM} m)` : ''}${o.note ? ` · note: ${o.note}` : ''} · status: ${o.status}${o.observerTag ? ` · ${o.observerTag}` : ''}`),
    ``,
    `The satellite asked. These are the answers so far.`,
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'trace-field-story.md'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const ANSWERS: { id: ObsAnswer; label: string }[] = [
  { id: 'water', label: 'Water' }, { id: 'wet-land', label: 'Wet land' }, { id: 'sandbar', label: 'Sandbar' },
  { id: 'vegetation', label: 'Vegetation / crop' }, { id: 'not-observable', label: 'Not observable' },
];
function Verify({ caseData, sel, onSelect }: { caseData: CaseData; sel: Candidate; onSelect: (c: Candidate) => void }) {
  const [answer, setAnswer] = useState<ObsAnswer | null>(null);
  const [relation, setRelation] = useState<'supports' | 'contradicts' | 'inconclusive' | null>(null);
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
      caseCandidateId: sel.id, answer, note, relation: relation ?? undefined,
      lat: pos?.lat ?? null, lon: pos?.lon ?? null, accuracyM: pos?.acc ?? null,
      takenAt: new Date().toISOString(), photo, voice, status: 'queued',
      observerTag: distKm <= 25 ? 'Field observer' : 'Demo observer, not at case site',
    };
    await db.observations.add(obs);
    if (navigator.onLine) { try { await syncAllQueued(); } catch { /* remains queued */ } }
    if ('vibrate' in navigator) navigator.vibrate(30);
    setAnswer(null); setRelation(null); setNote(''); setPhoto(undefined); setVoice(undefined); refresh();
  }

  const dist = pos ? haversineKm(pos.lat, pos.lon, sel.centroid[1], sel.centroid[0]) : null;
  const brg = pos ? Math.round(bearingDeg(pos.lat, pos.lon, sel.centroid[1], sel.centroid[0])) : null;

  return (
    <>
      <div className="seg">
        {caseData.candidates.map((c) => (
          <button key={c.id} className={c.id === sel.id ? 'active' : ''} onClick={() => onSelect(c)}>{c.id}</button>
        ))}
      </div>

      <div className="sect" style={{ marginTop: 24 }}>
        <div className="sect-h"><span className="idx">◆</span><span className="name">THE QUESTION — {sel.id}</span><span className="rule" /></div>
        <div className="verdict-n">{sel.question}</div>

        <div className="sect-h" style={{ marginTop: 26 }}><span className="idx">A</span><span className="name">WHAT DO YOU SEE?</span><span className="rule" /></div>
        <div className="choices">
          {ANSWERS.map((a) => (
            <button key={a.id} className={answer === a.id ? 'active' : ''} onClick={() => setAnswer(a.id)}>
              <span className="box" />{a.label}
            </button>
          ))}
        </div>

        <div className="sect-h" style={{ marginTop: 26 }}><span className="idx">B</span><span className="name">VS THE SATELLITE READING</span><span className="rule" /></div>
        <div className="choices">
          {([['supports', 'Supports it — the ground agrees'], ['contradicts', 'Contradicts it — the ground disagrees'], ['inconclusive', 'Inconclusive — cannot tell']] as const).map(([id, lab]) => (
            <button key={id} className={relation === id ? 'active' : ''} onClick={() => setRelation(id)}>
              <span className="box" />{lab}
            </button>
          ))}
        </div>

        <div className="sect-h" style={{ marginTop: 26 }}><span className="idx">C</span><span className="name">EVIDENCE</span><span className="rule" /></div>
        <div className="capture">
          <button className={pos ? 'on' : ''} onClick={getGps}>{pos ? 'GPS ✓' : 'GPS FIX'}</button>
          <label className={photo ? 'on' : ''} style={{ flex: 1, minHeight: 58, background: 'var(--panel)', border: `1px solid ${photo ? 'var(--teal)' : 'var(--hair)'}`, color: photo ? 'var(--teal)' : 'var(--bone)', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 1.5, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            {photo ? 'PHOTO ✓' : 'PHOTO'}
            <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => setPhoto(e.target.files?.[0])} />
          </label>
          <button className={voice || rec ? 'on' : ''} onClick={toggleVoice}>{rec ? 'STOP ●' : voice ? 'VOICE ✓' : 'VOICE'}</button>
        </div>
        {pos && <div className="acc-ring" style={{ marginTop: 10 }}>
          {pos.lat.toFixed(5)}, {pos.lon.toFixed(5)} · ±{pos.acc} m
          {dist !== null && <> · Point &amp; Prove (approximate): {dist.toFixed(1)} km to the polygon, bearing {brg}°</>}
        </div>}
        <PointProve sel={sel} />
        <textarea rows={3} placeholder="Note — what did you actually see?" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="dim" style={{ fontSize: 12, lineHeight: 1.55, marginTop: 10 }}>Your photo is evidence for review, not ground truth. Submissions are never labelled "verified".</div>
      </div>

      <div className="actionbar">
        <button className="btn" disabled={!answer} onClick={submit}>Submit evidence</button>
        {mine.length > 0 && <button className="btn ghost" onClick={() => exportStory(caseData, mine)}>Export field story (.md)</button>}
      </div>

      {mine.length > 0 && (
        <div className="sect">
          <div className="sect-h"><span className="idx">◆</span><span className="name">YOUR QUEUE</span><span className="rule" /><span className="meta">{mine.length} RECENT</span></div>
          <div className="ledger">
            {mine.map((o) => (
              <div key={o.id} className="rowline"><span>{o.caseCandidateId} — {o.answer}{o.relation ? ` · ${o.relation}` : ''}</span><span className="chip">{o.status.replace('-', ' ').toUpperCase()}</span></div>
            ))}
          </div>
          <button className="btn ghost" onClick={() => syncAllQueued().then(refresh)}>Sync now</button>
        </div>
      )}
    </>
  );
}

/* ---------------- Walk on the Radar ---------------- */
function WalkRadar({ caseData }: { caseData: CaseData }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [val, setVal] = useState<number | null>(null);
  const audioRef = useRef<{ ctx: AudioContext; osc: OscillatorNode } | null>(null);
  const isDb = caseData.walkGrid.unit === 'dB';
  const grid = useMemo(() => {
    // REAL field: NISAR HH over the case AOI, latest date. v4: calibrated
    // gamma-0 in dB from the GCOV float product — not a simulation.
    const values = caseData.walkGrid.values.map((row) => row.map((v) => v ?? -28));
    return { N: values.length, cells: values.flat() as number[] };
  }, [caseData]);
  const [gpsOn, setGpsOn] = useState(false);
  const [posPx, setPosPx] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const cv = canvasRef.current; if (!cv) return;
    const g = cv.getContext('2d')!; const { N, cells } = grid; const s = cv.width / N;
    for (let i = 0; i < cells.length; i++) {
      const v = cells[i];
      const t = isDb ? Math.max(0, Math.min(1, (v + 28) / 26)) : Math.max(0, Math.min(1, v / 255));
      const dark = isDb ? v < -19 : v < 45;
      g.fillStyle = dark ? '#12484d' : `rgb(${Math.round(30 + t * 225)},${Math.round(40 + t * 140)},${Math.round(45 + t * 40)})`;
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
        audioRef.current.osc.frequency.value = 110 + (isDb ? Math.max(0, Math.min(1, (v + 28) / 26)) : v / 255) * 660;
      } catch { /* audio is an encoding aid, not required */ }
    }
  }
  const cls = val === null ? '' : isDb
    ? (val < -19 ? 'consistent with smooth open water (dark — specular reflection)' : val > -10 ? 'consistent with rough or vegetated land (bright)' : 'in between — wet land or sand, the contested zone')
    : (val < 45 ? 'consistent with smooth open water (dark — specular reflection)' : val > 120 ? 'consistent with rough or vegetated land (bright)' : 'in between — wet land or sand, the contested zone');
  return (
    <>
      <div className="hero" style={{ paddingBottom: 0 }}>
        <div className="kick">FIELD LAB · REAL NISAR HH · {caseData.walkGrid.date}</div>
        <h1 style={{ fontSize: 27 }}>Walk on the <em>radar.</em></h1>
        <div className="sub">Drag a finger across the scene. Pitch and vibration follow the real calibrated gamma-0 under your finger — dark smooth water low, bright rough land high.</div>
      </div>
      <div className="sect">
        <div className="walk" onPointerMove={probe} onPointerDown={probe}>
          <canvas ref={canvasRef} width={480} height={480} />
          <div className="dbread">{val === null ? 'γ0 HH —' : isDb ? `γ0 HH ${val.toFixed(1)} dB` : `HH ${Math.round(val)} / 255`}</div>
        </div>
        <div className="ledger">
          <div className="rowline"><span className="lab">Under your finger</span><span className="val" style={{ whiteSpace: 'normal' }}>{val === null ? 'touch the scene' : cls}</span></div>
        </div>
        <button className="btn ghost" onClick={() => setGpsOn(!gpsOn)}>{gpsOn ? 'GPS walk on — you are the amber ring' : 'Walk it with GPS instead'}</button>
        {gpsOn && !posPx && <p className="dim" style={{ fontSize: 12.5, lineHeight: 1.55 }}>GPS is on but you are outside the case area (the Jamuna reach around Chilmari) — the ring appears when you step inside it.</p>}
        <p className="dim" style={{ fontSize: 12.5, lineHeight: 1.55 }}><em>An encoding of data, not a sound from space.</em></p>
      </div>
    </>
  );
}

/* ---------------- Pocket SAR Lab: threshold experiment (O3) ---------------- */
function ThresholdLab({ caseData }: { caseData: CaseData }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [thr, setThr] = useState(4.5);
  const dg = caseData.deltaGrid!;
  const N = dg.values.length;
  // AOI is ~702 km2 over a 64x64 block grid -> ha per block:
  const haBlock = (70200) / (N * N);
  const [area, setArea] = useState(0);
  useEffect(() => {
    const cv = canvasRef.current; if (!cv) return;
    const g2 = cv.getContext('2d')!; const s = cv.width / N;
    let cnt = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const v = dg.values[y][x];
      const chg = v !== null && Math.abs(v) > thr;
      if (chg) cnt++;
      g2.fillStyle = v === null ? '#0A0E12' : chg ? (v > 0 ? '#FFB224' : '#3FD0C9') : '#1a222b';
      g2.fillRect(x * s, y * s, s + 1, s + 1);
    }
    setArea(Math.round(cnt * haBlock));
  }, [thr, dg, N, haBlock]);
  return (
    <div className="sect">
      <div className="sect-h"><span className="idx">02</span><span className="name">POCKET SAR LAB — THRESHOLD EXPERIMENT</span><span className="rule" /></div>
      <p className="dim" style={{ fontSize: 13.5, lineHeight: 1.6 }}>
        The real calibrated change grid for this case (July → October, dB). Drag the threshold and watch the
        flagged area grow or shrink — this is why the case never reports one magic number: it reports the area
        that survives <em>every</em> setting. Amber = brightened, teal = darkened.
      </p>
      <canvas ref={canvasRef} width={320} height={320} style={{ width: '100%', border: '1px solid var(--hair)', display: 'block' }} />
      <div className="rowline"><span className="lab">Threshold</span><span className="val amber">|Δ| &gt; {thr.toFixed(1)} dB</span></div>
      <input type="range" min={2} max={9} step={0.5} value={thr} onChange={(e) => setThr(Number(e.target.value))} style={{ minHeight: 44 }} />
      <div className="rowline"><span className="lab">Flagged at this one setting</span><span className="val">{area.toLocaleString()} ha</span></div>
      <div className="dim" style={{ fontSize: 12 }}>Before speckle filtering, minimum-area filtering and cross-checks.</div>
    </div>
  );
}

/* ---------------- My Place + field guide ---------------- */
function MyPlace({ caseData, sel }: { caseData: CaseData; sel: Candidate }) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/data/audio.json').then((r) => r.json()).then((j) => { if (live) setAudioUrl(j.myplace_bn); }).catch(() => {});
    return () => { live = false; };
  }, []);
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
      <div className="hero" style={{ paddingBottom: 0 }}>
        <div className="kick">MY PLACE WATCH · {caseData.site.name.toUpperCase()}</div>
        <p className="bn" style={{ fontSize: 20.5, lineHeight: 1.65, margin: 0 }}>{caseData.placeWatch.bn}</p>
        <p className="dim" style={{ fontSize: 13.5, lineHeight: 1.6, marginTop: 12 }}>{caseData.placeWatch.en}</p>
      </div>

      <div className="sect">
        <div className="sect-h"><span className="idx">01</span><span className="name">শুনুন — BANGLA BRIEF</span><span className="rule" /></div>
        {audioUrl
          ? <audio controls src={audioUrl} />
          : <button className="btn ghost" onClick={speak} style={{ marginTop: 0 }}>Play Bangla brief</button>}
        <div className="dim" style={{ fontSize: 12, lineHeight: 1.55 }}>Pre-generated Bangla voice for this case — synthesized, cached for offline play. A recorded human voice replaces it when the team has one.</div>
      </div>

      <div className="sect">
        <div className="sect-h"><span className="idx">02</span><span className="name">NEXT PASS — TRACK 19</span><span className="rule" /></div>
        <div className="strip" style={{ marginTop: 0 }}>
          <div><div className="k">DATE</div><div className="v">{next.toISOString().slice(0, 10)}</div></div>
          <div><div className="k">COUNTDOWN</div><div className="v">{daysTick} <small>days</small></div></div>
          <div><div className="k">CYCLE</div><div className="v">12 <small>days</small></div></div>
        </div>
        <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>Same track, same geometry — the difference between passes is the ground, not the view.</div>
      </div>

      <div className="sect">
        <div className="sect-h"><span className="idx">03</span><span className="name">SAR FIELD GUIDE</span><span className="rule" /></div>
        {[
          ['Why smooth water is dark', 'A calm surface reflects the radar pulse away from the satellite — specular reflection — so almost nothing returns. Rough or flooded ground scatters some back.'],
          ['L-band vs C-band', 'NISAR L-band (~24 cm) penetrates canopy further than Sentinel-1 C-band (~5.6 cm). Sentinel-1 is radar too — not optical.'],
          ['Why 12 days', 'NISAR repeats the same track every 12 days. Change detection compares same-track passes, so geometry matches and the difference is the ground, not the view.'],
          ['What HH and HV see', 'HH is the surface / double-bounce channel — flooded vegetation is often bright at L-band. HV is volume scattering from canopy. Wet soil is not automatically dark; roughness and moisture both matter.'],
        ].map(([t, b]) => (
          <details key={t} className="acc">
            <summary><span className="t">{t}</span><span className="plus">+</span></summary>
            <div className="body">{b}</div>
          </details>
        ))}
      </div>

      <div className="sect">
        <div className="sect-h"><span className="idx">04</span><span className="name">FIELD STORY</span><span className="rule" /></div>
        <p className="dim" style={{ fontSize: 13.5, lineHeight: 1.6 }}>Empty by design. It takes one real voice-and-photo pin from the team — and nothing invented.</p>
      </div>
    </>
  );
}
