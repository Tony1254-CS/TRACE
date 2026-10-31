// TRACE Field evidence API — Vercel serverless function.
// Storage: Vercel Blob (observations.json, read-modify-write; fine at
// field-demo scale). Without BLOB_READ_WRITE_TOKEN it returns 501 and the
// app honestly falls back to its on-device queue — never a fake success.
import { put, head } from '@vercel/blob';

const KEY = 'trace-field/observations.json';

async function readAll() {
  try {
    const meta = await head(KEY);
    const res = await fetch(meta.url);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(501).json({ error: 'blob storage not configured' });
  }
  if (req.method === 'GET') {
    return res.status(200).json(await readAll());
  }
  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const row = {
      candidateId: String(body.candidateId || ''),
      answer: String(body.answer || ''),
      relation: String(body.relation || ''),
      note: String(body.note || '').slice(0, 1000),
      lat: body.lat ?? null, lon: body.lon ?? null, accuracyM: body.accuracyM ?? null,
      takenAt: String(body.takenAt || new Date().toISOString()),
      observerTag: String(body.observerTag || ''),
      status: 'awaiting review', // never "verified" — a photo is evidence for review
      receivedAt: new Date().toISOString(),
    };
    if (!row.candidateId || !row.answer) return res.status(400).json({ error: 'candidateId and answer required' });
    const all = await readAll();
    all.push(row);
    await put(KEY, JSON.stringify(all), { access: 'public', contentType: 'application/json', allowOverwrite: true });
    return res.status(201).json(row);
  }
  return res.status(405).json({ error: 'method not allowed' });
}
