import { db, type Observation } from './db';

/**
 * Evidence return. If Supabase env vars are set, POST to the `observations`
 * table (realtime on the web side picks it up). Otherwise the observation is
 * written to the shared local inbox that the Review panel reads — same state
 * machine, used for the on-device split-screen video demo.
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

export async function syncObservation(obs: Observation): Promise<void> {
  if (!obs.id) return;
  await db.observations.update(obs.id, { status: 'synced' });
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
  } else {
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
