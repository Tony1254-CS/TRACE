import { db, type Observation } from './db';

/**
 * Evidence return, with an honesty contract on the state machine:
 * a row is only ever "synced" after a real backend accepts it.
 * Routes, in order:
 *  1. Supabase REST (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY set)
 *  2. Same-origin /api/observations (Vercel function + Blob when deployed)
 *  3. On-device review inbox (localStorage) — the row reaches "awaiting
 *     review" on THIS device only, and the Review card says so.
 * Status flow: queued -> synced -> awaiting-review. Never "verified":
 * a photo is evidence for review, not ground truth.
 */
const SUPA_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export interface WebInboxRow {
  candidateId: string; answer: string; takenAt: string; status: string; observerTag: string;
}
export function readWebInbox(): WebInboxRow[] {
  try { return JSON.parse(localStorage.getItem('trace-web-inbox') ?? '[]'); } catch { return []; }
}

/** Cross-device rows from the deployed API; null when no API answers. */
export async function fetchRemoteInbox(): Promise<WebInboxRow[] | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch('/api/observations', { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const rows = await res.json() as Record<string, unknown>[];
    return rows.map((r) => ({
      candidateId: String(r.candidateId), answer: String(r.answer),
      takenAt: String(r.takenAt ?? ''), status: 'awaiting review',
      observerTag: String(r.observerTag ?? ''),
    }));
  } catch { return null; }
}

export async function fetchInboxRows(): Promise<WebInboxRow[]> {
  const remote = await fetchRemoteInbox();
  const local = readWebInbox();
  return remote ? [...local, ...remote] : local;
}

async function postToApi(obs: Observation): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch('/api/observations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({
        candidateId: obs.caseCandidateId, answer: obs.answer, note: obs.note,
        lat: obs.lat, lon: obs.lon, accuracyM: obs.accuracyM, takenAt: obs.takenAt,
        observerTag: obs.observerTag,
      }),
    });
    clearTimeout(t);
    return res.ok;
  } catch { return false; }
}

export async function syncObservation(obs: Observation): Promise<void> {
  if (!obs.id) return;
  let backendAccepted = false;
  if (SUPA_URL && SUPA_KEY) {
    const res = await fetch(`${SUPA_URL}/rest/v1/observations`, {
      method: 'POST',
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        candidate_id: obs.caseCandidateId, answer: obs.answer, note: obs.note,
        lat: obs.lat, lon: obs.lon, accuracy_m: obs.accuracyM, taken_at: obs.takenAt,
      }),
    });
    if (!res.ok) throw new Error('supabase post failed');
    backendAccepted = true;
  } else if (await postToApi(obs)) {
    backendAccepted = true;
  }
  if (backendAccepted) {
    await db.observations.update(obs.id, { status: 'synced' });
  } else {
    // On-device fallback: the row joins THIS device's review inbox.
    const inbox = readWebInbox();
    inbox.push({ candidateId: obs.caseCandidateId, answer: obs.answer, takenAt: obs.takenAt, status: 'awaiting review', observerTag: obs.observerTag });
    localStorage.setItem('trace-web-inbox', JSON.stringify(inbox));
  }
  await db.observations.update(obs.id, { status: 'awaiting-review' });
}

export async function syncAllQueued(): Promise<number> {
  const queued = await db.observations.where('status').equals('queued').toArray();
  let n = 0;
  for (const o of queued) {
    try { await syncObservation(o); n++; } catch { /* stays queued; manual Sync now retries */ }
  }
  return n;
}
