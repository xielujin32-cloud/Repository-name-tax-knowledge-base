import { mkdir, readFile, writeFile, access, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_KNOWLEDGE_CARDS } from './knowledge-cards.js';

const root = resolve(process.env.TAXKB_DATA_DIR || resolve(process.cwd(), 'data'));
const dataFile = resolve(root, 'knowledge-base.json');
const seedFile = resolve(root, 'seed.json');

export async function initialiseStore() {
  await mkdir(root, { recursive: true });
  try {
    await access(dataFile, constants.F_OK);
  } catch {
    await copyFile(seedFile, dataFile);
  }
  const data = JSON.parse(await readFile(dataFile, 'utf8'));
  let changed = false;
  if (!Array.isArray(data.knowledgeCards)) { data.knowledgeCards = DEFAULT_KNOWLEDGE_CARDS; changed = true; }
  else {
    const knownIds = new Set(data.knowledgeCards.map((card) => card.id));
    const additions = DEFAULT_KNOWLEDGE_CARDS.filter((card) => !knownIds.has(card.id));
    if (additions.length) { data.knowledgeCards.push(...additions); changed = true; }
  }
  if (!Array.isArray(data.knowledgeCardCandidates)) { data.knowledgeCardCandidates = []; changed = true; }
  if (changed) await writeFile(dataFile, JSON.stringify(data, null, 2), 'utf8');
}

export async function readStore() {
  return JSON.parse(await readFile(dataFile, 'utf8'));
}

export async function updateStore(mutator) {
  const data = await readStore();
  const result = await mutator(data);
  await writeFile(dataFile, JSON.stringify(data, null, 2), 'utf8');
  return result;
}

export function newId(data, prefix) {
  const id = `${prefix}-${data.nextId || 1}`;
  data.nextId = (data.nextId || 1) + 1;
  return id;
}

export function audit(data, { actor, action, targetType, targetId, detail = {} }) {
  data.audit.unshift({
    id: newId(data, 'audit'),
    actor,
    action,
    targetType,
    targetId,
    detail,
    at: new Date().toISOString()
  });
  data.audit = data.audit.slice(0, 1000);
}

export function publicDocument(document, source) {
  return {
    ...document,
    source: source ? { id: source.id, name: source.name, authority: source.authority, url: source.url } : null
  };
}
