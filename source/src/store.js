// Local-only storage: preferences and draft in localStorage, generated audio in IndexedDB.
const DB = 'sawt';
const STORE = 'history';
const MAX_ITEMS = 50;
const VOICES = 'voices';

export function loadPrefs() { try { return JSON.parse(localStorage.getItem('sawt.prefs')) || {}; } catch { return {}; } }
export function savePrefs(p) { try { localStorage.setItem('sawt.prefs', JSON.stringify(p)); } catch { /* ignore */ } }
export function loadDraft() { try { return localStorage.getItem('sawt.draft') || ''; } catch { return ''; } }
export function saveDraft(t) { try { localStorage.setItem('sawt.draft', t); } catch { /* ignore */ } }

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB, 2);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          if (!d.objectStoreNames.contains(VOICES)) d.createObjectStore(VOICES, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  return dbp;
}

function tx(mode, fn, name = STORE) {
  return db().then((d) => {
    if (!d) return null;
    return new Promise((resolve) => {
      const t = d.transaction(name, mode);
      const s = t.objectStore(name);
      const out = fn(s);
      t.oncomplete = () => resolve(out?.result ?? out);
      t.onerror = () => resolve(null);
    });
  });
}

export async function listHistory() {
  const all = (await tx('readonly', (s) => s.getAll())) || [];
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function addHistory(item) {
  await tx('readwrite', (s) => s.add(item));
  const all = await listHistory();
  for (const old of all.slice(MAX_ITEMS)) await deleteHistory(old.id);
}

export const deleteHistory = (id) => tx('readwrite', (s) => s.delete(id));
export const clearHistory = () => tx('readwrite', (s) => s.clear());

// Custom voices: { id, name, samples: Float32Array (24 kHz mono), createdAt }
export async function listVoices() {
  const all = (await tx('readonly', (s) => s.getAll(), VOICES)) || [];
  return all.sort((a, b) => a.createdAt - b.createdAt);
}
export const saveVoice = (v) => tx('readwrite', (s) => s.put(v), VOICES);
export const deleteVoice = (id) => tx('readwrite', (s) => s.delete(id), VOICES);
