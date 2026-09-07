import { getStore } from '@netlify/blobs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const EVIDENCE_RAW_STORE_NAME = 'taxkb-evidence-raw';
function safeKey(key) { const value = String(key || '').replace(/\\/g, '/'); if (!value || value.startsWith('/') || value.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('evidence object key 无效。'); return value; }

export function createLocalEvidenceObjectStore({ rootDirectory = path.join(process.cwd(), '.netlify', 'evidence-raw', EVIDENCE_RAW_STORE_NAME) } = {}) {
  async function filename(key) { const file = path.resolve(rootDirectory, ...safeKey(key).split('/')); if (!file.startsWith(path.resolve(rootDirectory))) throw new Error('evidence object path 超出本地存储根目录。'); return file; }
  return Object.freeze({
    async putImmutable(key, value) { const file = await filename(key); await mkdir(path.dirname(file), { recursive: true }); try { await writeFile(file, String(value), { encoding: 'utf8', flag: 'wx' }); } catch (error) { if (error?.code === 'EEXIST') throw new Error(`原始对象不可覆盖：${key}`); throw error; } return key; },
    async read(key) { return readFile(await filename(key), 'utf8'); },
    async has(key) { try { await readFile(await filename(key)); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } },
    // Only Phase 3C-2 uses this for objects it created before a failed DB
    // transaction. Once a Raw Snapshot commits, no caller receives its key
    // through this cleanup path, so immutable evidence remains immutable.
    async deleteUnreferenced(key) { try { await unlink(await filename(key)); } catch (error) { if (error?.code !== 'ENOENT') throw error; } }
  });
}

// Production adapter is intentionally not called by Phase 2C local tests.
export function createNetlifyBlobsEvidenceObjectStore({ store = getStore(EVIDENCE_RAW_STORE_NAME) } = {}) { return Object.freeze({
  async putImmutable(key, value) { const safe = safeKey(key); if (await store.get(safe)) throw new Error(`原始对象不可覆盖：${safe}`); await store.set(safe, String(value)); return safe; },
  async read(key) { return store.get(safeKey(key)); }, async has(key) { return Boolean(await store.get(safeKey(key))); },
  async deleteUnreferenced(key) { await store.delete(safeKey(key)); }
}); }
