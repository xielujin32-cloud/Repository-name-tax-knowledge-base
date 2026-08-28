import { getStore } from '@netlify/blobs';
import { DEFAULT_KNOWLEDGE_CARDS } from '../../src/knowledge-cards.js';

const STORE_NAME = 'taxkb-knowledge';
const STORE_KEY = 'knowledge-card-state-v1';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultState() {
  return { knowledgeCards: clone(DEFAULT_KNOWLEDGE_CARDS), knowledgeCardCandidates: [], audit: [] };
}

function mergeDefaultCards(state) {
  const knownIds = new Set((state.knowledgeCards || []).map((card) => card.id));
  const additions = DEFAULT_KNOWLEDGE_CARDS.filter((card) => !knownIds.has(card.id));
  if (additions.length) state.knowledgeCards.push(...clone(additions));
  return additions.length > 0;
}

export async function readKnowledgeCardState() {
  const store = getStore(STORE_NAME);
  const state = await store.get(STORE_KEY, { type: 'json' });
  if (!state) {
    const initial = defaultState();
    await store.setJSON(STORE_KEY, initial);
    return initial;
  }
  state.knowledgeCards = Array.isArray(state.knowledgeCards) ? state.knowledgeCards : [];
  state.knowledgeCardCandidates = Array.isArray(state.knowledgeCardCandidates) ? state.knowledgeCardCandidates : [];
  state.audit = Array.isArray(state.audit) ? state.audit : [];
  if (mergeDefaultCards(state)) await store.setJSON(STORE_KEY, state);
  return state;
}

export async function updateKnowledgeCardState(mutator) {
  const store = getStore(STORE_NAME);
  const state = await readKnowledgeCardState();
  const result = await mutator(state);
  await store.setJSON(STORE_KEY, state);
  return result;
}

export function addAudit(state, { actor, action, targetType, targetId, detail = {} }) {
  state.audit.unshift({ id: `audit-${crypto.randomUUID()}`, actor, action, targetType, targetId, detail, at: new Date().toISOString() });
  state.audit = state.audit.slice(0, 1000);
}
