import Dexie, { type Table } from 'dexie';

export type ObsStatus = 'queued' | 'synced' | 'awaiting-review';
export type ObsAnswer = 'water' | 'wet-land' | 'sandbar' | 'vegetation' | 'not-observable';

export interface Observation {
  id?: number;
  caseCandidateId: string;
  answer: ObsAnswer;
  note: string;
  lat: number | null;
  lon: number | null;
  accuracyM: number | null;
  takenAt: string;
  photo?: Blob;
  voice?: Blob;
  status: ObsStatus;
  relation?: 'supports' | 'contradicts' | 'inconclusive'; // vs the satellite reading, per H5
  observerTag: string; // e.g. "Demo observer, not at case site" when GPS is far from the case
}

class TraceDb extends Dexie {
  observations!: Table<Observation, number>;
  constructor() {
    super('trace-field');
    this.version(1).stores({ observations: '++id, caseCandidateId, status' });
  }
}

export const db = new TraceDb();
