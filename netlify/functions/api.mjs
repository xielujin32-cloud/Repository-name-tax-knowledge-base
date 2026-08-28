import { buildKnowledgeCard, publicKnowledgeCard, searchKnowledgeCards } from '../../src/knowledge-cards.js';
import { addAudit, readKnowledgeCardState, updateKnowledgeCardState } from '../lib/knowledge-card-store.mjs';

const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const id = (prefix) => `${prefix}-${crypto.randomUUID()}`;

function publicTaxTypes(cards) {
  const groups = new Map();
  for (const card of cards.filter((item) => item.status === 'published')) {
    const current = groups.get(card.taxType) || { label: card.taxType, count: 0, updatedAt: card.updatedAt };
    current.count += 1;
    if (String(card.updatedAt) > String(current.updatedAt)) current.updatedAt = card.updatedAt;
    groups.set(card.taxType, current);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
}

function normalisePath(url) {
  const index = url.pathname.indexOf('/api/');
  return index >= 0 ? url.pathname.slice(index) : url.pathname;
}

function requireAdmin(request) {
  const expected = process.env.NETLIFY_TAXKB_ADMIN_TOKEN;
  const received = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!expected) throw new Error('管理员接口尚未配置 NETLIFY_TAXKB_ADMIN_TOKEN。');
  if (!received || received !== expected) return false;
  return true;
}

async function requestBody(request) {
  try { return await request.json(); } catch { throw new SyntaxError('请求正文必须是 JSON。'); }
}

async function adminApi(request, pathname) {
  if (!requireAdmin(request)) return json({ error: '仅管理员可执行此操作。' }, 401);
  if (request.method === 'GET' && pathname === '/api/admin/knowledge-cards') {
    return json({ cards: (await readKnowledgeCardState()).knowledgeCards });
  }
  if (request.method === 'GET' && pathname === '/api/admin/knowledge-card-candidates') {
    return json({ candidates: (await readKnowledgeCardState()).knowledgeCardCandidates });
  }
  if (request.method === 'POST' && pathname === '/api/admin/knowledge-card-candidates') {
    const input = await requestBody(request);
    const candidate = await updateKnowledgeCardState((state) => {
      const replacesCardId = String(input.replacesCardId || '').trim() || null;
      if (replacesCardId && !state.knowledgeCards.some((card) => card.id === replacesCardId && card.status === 'published')) throw new Error('要更新的已发布知识卡片不存在。');
      const value = { id: id('knowledge-card-candidate'), card: buildKnowledgeCard(input, { id: null, status: 'draft' }), replacesCardId, state: 'pending', createdAt: new Date().toISOString(), reviewedAt: null, reviewedBy: null, reviewNote: '' };
      state.knowledgeCardCandidates.unshift(value);
      addAudit(state, { actor: 'netlify-admin', action: 'knowledge_card_candidate_created', targetType: 'knowledge_card_candidate', targetId: value.id, detail: { taxType: value.card.taxType, topic: value.card.topic, replacesCardId } });
      return value;
    });
    return json({ candidate }, 201);
  }
  if (request.method === 'POST' && /^\/api\/admin\/knowledge-card-candidates\/[^/]+\/review$/.test(pathname)) {
    const candidateId = pathname.split('/')[4];
    const { action, note = '' } = await requestBody(request);
    const outcome = await updateKnowledgeCardState((state) => {
      const candidate = state.knowledgeCardCandidates.find((item) => item.id === candidateId && item.state === 'pending');
      if (!candidate) throw new Error('待审知识卡片不存在或已处理。');
      if (!['publish', 'reject'].includes(action)) throw new Error('审核动作无效。');
      const now = new Date().toISOString();
      candidate.reviewedAt = now;
      candidate.reviewedBy = 'netlify-admin';
      candidate.reviewNote = String(note);
      if (action === 'reject') {
        candidate.state = 'rejected';
        addAudit(state, { actor: 'netlify-admin', action: 'knowledge_card_rejected', targetType: 'knowledge_card_candidate', targetId: candidate.id, detail: { note } });
        return { candidate };
      }
      let card;
      if (candidate.replacesCardId) {
        const existing = state.knowledgeCards.find((item) => item.id === candidate.replacesCardId && item.status === 'published');
        if (!existing) throw new Error('要更新的已发布知识卡片不存在。');
        const { versions: ignoredVersions, ...snapshot } = existing;
        const versions = [...(existing.versions || []), { version: existing.version, savedAt: now, card: snapshot }];
        card = buildKnowledgeCard({ ...candidate.card, id: existing.id, createdAt: existing.createdAt }, { id: existing.id, status: 'published', now, version: Number(existing.version || 1) + 1, versions });
        Object.assign(existing, card);
      } else {
        card = buildKnowledgeCard(candidate.card, { id: id('knowledge-card'), status: 'published', now, version: 1, versions: [] });
        state.knowledgeCards.unshift(card);
      }
      candidate.state = 'published';
      candidate.publishedCardId = card.id;
      addAudit(state, { actor: 'netlify-admin', action: 'knowledge_card_published', targetType: 'knowledge_card', targetId: card.id, detail: { candidateId: candidate.id, version: card.version, updated: Boolean(candidate.replacesCardId) } });
      return { candidate, card };
    });
    return json(outcome);
  }
  if (request.method === 'POST' && /^\/api\/admin\/knowledge-cards\/[^/]+\/rollback$/.test(pathname)) {
    const cardId = pathname.split('/')[4];
    const { version } = await requestBody(request);
    const card = await updateKnowledgeCardState((state) => {
      const current = state.knowledgeCards.find((item) => item.id === cardId && item.status === 'published');
      if (!current) throw new Error('已发布知识卡片不存在。');
      const target = (current.versions || []).find((item) => Number(item.version) === Number(version));
      if (!target?.card) throw new Error('找不到要回退的历史版本。');
      const now = new Date().toISOString();
      const { versions: ignoredVersions, ...snapshot } = current;
      const versions = [...(current.versions || []), { version: current.version, savedAt: now, card: snapshot }];
      const restored = buildKnowledgeCard({ ...target.card, id: current.id, createdAt: current.createdAt }, { id: current.id, status: 'published', now, version: Number(current.version || 1) + 1, versions });
      Object.assign(current, restored);
      addAudit(state, { actor: 'netlify-admin', action: 'knowledge_card_rolled_back', targetType: 'knowledge_card', targetId: current.id, detail: { restoredVersion: Number(version), version: current.version } });
      return current;
    });
    return json({ card });
  }
  return json({ error: '接口不存在。' }, 404);
}

export default async (request) => {
  try {
    const url = new URL(request.url);
    const pathname = normalisePath(url);
    if (pathname.startsWith('/api/admin/')) return await adminApi(request, pathname);
    if (request.method === 'GET' && pathname === '/api/health') return json({ ok: true, storage: 'netlify-blobs' });
    const state = await readKnowledgeCardState();
    if (request.method === 'GET' && pathname === '/api/knowledge/tax-types') return json({ taxTypes: publicTaxTypes(state.knowledgeCards) });
    if (request.method === 'GET' && pathname === '/api/knowledge/cards') {
      const results = searchKnowledgeCards(state.knowledgeCards, { query: url.searchParams.get('query') || '', taxType: url.searchParams.get('taxType') || '' }).slice(0, Math.min(Math.max(Number(url.searchParams.get('limit')) || 30, 1), 100));
      return json({ total: results.length, results: results.map(({ card, score }) => ({ card: publicKnowledgeCard(card), score })) });
    }
    if (request.method === 'GET' && pathname.startsWith('/api/knowledge/cards/')) {
      const card = state.knowledgeCards.find((item) => item.id === pathname.split('/').pop() && item.status === 'published');
      return card ? json({ card: publicKnowledgeCard(card) }) : json({ error: '未找到已发布知识卡片。' }, 404);
    }
    return json({ error: '接口不存在。' }, 404);
  } catch (error) {
    return json({ error: error.message || '请求处理失败。' }, error instanceof SyntaxError ? 400 : 422);
  }
};

export const config = { path: '/api/*' };
