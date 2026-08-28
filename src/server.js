import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, normalize } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initialiseStore, readStore, updateStore, newId, audit, publicDocument } from './store.js';
import { searchDocuments, statusLabel } from './search.js';
import { answerFromEvidence } from './answer.js';
import { collectOfficialSource, discoverOfficialPolicyUrls, fetchOfficialDocuments, fetchChinaTaxDocuments } from './collector.js';
import { automaticReviewSummary, candidateScopeReviewSummary, secondaryReviewSummary, thirdReviewSummary, publishedDocumentReviewSummary, publishedDocumentVersionReviewSummary } from './auto-review.js';
import { TAX_TOPICS, documentsForTopic, inferTaxTopics } from './topics.js';
import { priorityReviewQueue } from './priority-review.js';
import { buildKnowledgeCard, publicKnowledgeCard, searchKnowledgeCards } from './knowledge-cards.js';

const port = Number(process.env.PORT || 3000);
const publicDir = resolve(process.cwd(), 'public');
const sessions = new Map();
const activeBulkImports = new Set();
const scheduledBulkRetries = new Map();
const activeStatusChecks = new Set();
const scheduledStatusRetries = new Map();
const users = {
  member: { password: 'member-demo', role: 'member', displayName: '演示成员' },
  admin: { password: 'admin-demo', role: 'admin', displayName: '演示管理员' }
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml' };

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function jsonBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error('请求正文过大');
  }
  return body ? JSON.parse(body) : {};
}

function authenticate(request) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  return token ? sessions.get(token) : null;
}

function requireUser(request, response, role) {
  const user = authenticate(request);
  if (!user) {
    send(response, 401, { error: '请先登录。' });
    return null;
  }
  if (role === 'admin' && user.role !== 'admin') {
    send(response, 403, { error: '仅管理员可执行此操作。' });
    return null;
  }
  return user;
}

function allowedStatus(status) {
  return ['current', 'revised', 'repealed', 'expired', 'pending_verification'].includes(status);
}

function unlinkedVersionRelations(documents, links) {
  const byId = new Map(documents.map((document) => [document.id, document]));
  return links.filter((link) => !byId.get(link.sourceId)?.relations?.some((relation) => relation.documentId === link.targetId && relation.type === link.type));
}

function taxonomySummary(documents) {
  const groups = new Map();
  for (const document of documents) {
    for (const taxType of new Set(document.taxTypes || ['其他税收法规'])) {
      const group = groups.get(taxType) || { label: taxType, count: 0, repealed: 0, expired: 0 };
      group.count += 1;
      if (document.status === 'repealed') group.repealed += 1;
      if (document.status === 'expired') group.expired += 1;
      groups.set(taxType, group);
    }
  }
  return [...groups.values()].sort((left, right) => (right.count - left.count) || left.label.localeCompare(right.label, 'zh-CN'));
}

function isOfficialSourceUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return ['chinatax.gov.cn', 'mof.gov.cn', 'gov.cn', 'npc.gov.cn'].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function buildDocument(input, data, { id = newId(data, 'doc'), publishedToMembersAt = null } = {}) {
  const required = ['title', 'authority', 'sourceId', 'officialUrl'];
  for (const field of required) if (!String(input[field] || '').trim()) throw new Error(`缺少字段：${field}`);
  if (!data.sources.some((source) => source.id === input.sourceId)) throw new Error('来源不存在。');
  const sections = Array.isArray(input.sections) ? input.sections.filter((section) => section?.text?.trim()).map((section, index) => ({
    id: section.id || `${id}-section-${index + 1}`,
    label: String(section.label || `第${index + 1}段`),
    text: String(section.text).trim()
  })) : [];
  if (!sections.length) throw new Error('至少需要一条原文分段。');
  const contentHash = createHash('sha256').update(JSON.stringify({ title: input.title, sections })).digest('hex');
  return {
    id,
    title: String(input.title).trim(),
    documentNumber: String(input.documentNumber || '').trim(),
    authority: String(input.authority).trim(),
    sourceId: input.sourceId,
    officialUrl: String(input.officialUrl).trim(),
    publishedAt: input.publishedAt || null,
    effectiveAt: input.effectiveAt || null,
    status: allowedStatus(input.status) ? input.status : 'pending_verification',
    taxTypes: Array.isArray(input.taxTypes) ? input.taxTypes.filter(Boolean).map(String) : [],
    summary: String(input.summary || '').trim(),
    contentHash,
    relations: Array.isArray(input.relations) ? input.relations.filter((relation) => relation?.documentId && relation?.type) : [],
    sections,
    createdAt: new Date().toISOString(),
    publishedToMembersAt
  };
}

async function collectSource(sourceId, actor, options = {}) {
  const snapshot = await readStore();
  const source = snapshot.sources.find((item) => item.id === sourceId);
  if (!source) throw new Error('来源不存在。');
  if (!source.enabled) throw new Error('该来源已停用。');
  const maxDocuments = Math.min(Math.max(Number(options.maxDocuments) || 25, 1), 100);
  const result = await collectOfficialSource(source, { maxDocuments, maxListPages: 24 });
  return updateStore((data) => {
    const liveSource = data.sources.find((item) => item.id === sourceId);
    const collection = {
      id: newId(data, 'collection'),
      sourceId,
      actor,
      mode: options.mode || 'manual',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      scannedListPages: result.scannedListPages,
      discoveredDetailUrls: result.discoveredDetailUrls,
      discoveredDocuments: result.documents.length,
      createdCandidates: 0,
      skippedDuplicates: 0,
      errors: result.errors
    };
    for (const input of result.documents) {
      const known = data.documents.some((document) => document.officialUrl === input.officialUrl) || data.candidates.some((candidate) => candidate.document.officialUrl === input.officialUrl);
      if (known) {
        collection.skippedDuplicates += 1;
        continue;
      }
      const document = buildDocument(input, data);
      const candidate = { id: newId(data, 'candidate'), document, collectionId: collection.id, state: 'pending', discoveredAt: new Date().toISOString(), reviewedAt: null, reviewedBy: null, reviewNote: '' };
      data.candidates.unshift(candidate);
      collection.createdCandidates += 1;
    }
    data.collections = data.collections || [];
    data.collections.unshift(collection);
    data.collections = data.collections.slice(0, 300);
    liveSource.lastScannedAt = collection.completedAt;
    audit(data, { actor, action: 'source_collected', targetType: 'source', targetId: sourceId, detail: { collectionId: collection.id, createdCandidates: collection.createdCandidates, skippedDuplicates: collection.skippedDuplicates, errors: collection.errors.length } });
    return collection;
  });
}

async function collectOfficialUrls(sourceId, actor, urls) {
  const snapshot = await readStore();
  const source = snapshot.sources.find((item) => item.id === sourceId);
  if (!source) throw new Error('来源不存在。');
  if (!source.enabled) throw new Error('该来源已停用。');
  const uniqueUrls = [...new Set((Array.isArray(urls) ? urls : []).map((url) => String(url).trim()).filter(Boolean))];
  if (!uniqueUrls.length) throw new Error('请至少提供一个官方原文链接。');
  if (uniqueUrls.length > 50) throw new Error('单次最多补充 50 个链接。');
  if (uniqueUrls.some((url) => !isOfficialSourceUrl(url))) throw new Error('仅允许财政部、国家税务总局、中国政府网或中国人大网的官方链接。');
  const fetched = await fetchOfficialDocuments(source, uniqueUrls, { concurrency: 2 });
  return updateStore((data) => {
    const collection = { id: newId(data, 'collection'), sourceId, actor, mode: 'official_url_supplement', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), scannedListPages: 0, discoveredDetailUrls: uniqueUrls.length, discoveredDocuments: fetched.documents.length, createdCandidates: 0, skippedDuplicates: 0, errors: fetched.errors };
    for (const input of fetched.documents) {
      if (addCandidateIfNew(data, input, { collectionId: collection.id })) collection.createdCandidates += 1;
      else collection.skippedDuplicates += 1;
    }
    data.collections = data.collections || [];
    data.collections.unshift(collection);
    data.collections = data.collections.slice(0, 300);
    audit(data, { actor, action: 'official_urls_collected', targetType: 'source', targetId: sourceId, detail: { collectionId: collection.id, requested: uniqueUrls.length, createdCandidates: collection.createdCandidates, skippedDuplicates: collection.skippedDuplicates, errors: collection.errors.length } });
    return collection;
  });
}

function addCandidateIfNew(data, input, { collectionId = null, importId = null } = {}) {
  const known = data.documents.some((document) => document.officialUrl === input.officialUrl) || data.candidates.some((candidate) => candidate.document.officialUrl === input.officialUrl);
  if (known) return false;
  const document = buildDocument(input, data);
  data.candidates.unshift({ id: newId(data, 'candidate'), document, collectionId, importId, state: 'pending', discoveredAt: new Date().toISOString(), reviewedAt: null, reviewedBy: null, reviewNote: '' });
  return true;
}

function queueBulkImport(importId) {
  if (activeBulkImports.has(importId)) return;
  const timer = setTimeout(() => runBulkImport(importId), 0);
  timer.unref();
}

function scheduleBulkImportRetry(importId, retryAfter) {
  if (scheduledBulkRetries.has(importId)) clearTimeout(scheduledBulkRetries.get(importId));
  const delay = Math.max(new Date(retryAfter).getTime() - Date.now(), 0);
  const timer = setTimeout(async () => {
    scheduledBulkRetries.delete(importId);
    try {
      const job = await updateStore((data) => {
        const value = (data.bulkImports || []).find((item) => item.id === importId);
        if (!value || value.status !== 'blocked' || new Date(value.retryAfter || 0) > new Date()) return null;
        value.status = 'running';
        value.phase = 'importing';
        value.blockedReason = null;
        value.retryAfter = null;
        value.updatedAt = new Date().toISOString();
        audit(data, { actor: value.actor, action: 'bulk_import_retry_automatic', targetType: 'bulk_import', targetId: importId });
        return value;
      });
      if (job) queueBulkImport(importId);
    } catch { /* 保留任务状态，下一次服务启动时会重新排程。 */ }
  }, delay);
  timer.unref();
  scheduledBulkRetries.set(importId, timer);
}

async function runBulkImport(importId) {
  if (activeBulkImports.has(importId)) return;
  activeBulkImports.add(importId);
  let shouldContinue = false;
  let retryAfter = null;
  try {
    const snapshot = await readStore();
    const job = (snapshot.bulkImports || []).find((item) => item.id === importId);
    if (!job || !['queued', 'discovering', 'running'].includes(job.status)) return;
    const source = snapshot.sources.find((item) => item.id === job.sourceId);
    if (!source) throw new Error('导入来源不存在。');
    if (job.phase === 'discovering' || !Array.isArray(job.manifest)) {
      const discovery = await discoverOfficialPolicyUrls(source, { maxListPages: job.maxListPages });
      await updateStore((data) => {
        const liveJob = data.bulkImports.find((item) => item.id === importId);
        if (!liveJob || liveJob.status === 'paused') return;
        liveJob.status = 'running';
        liveJob.phase = 'importing';
        liveJob.manifest = discovery.detailUrls;
        liveJob.total = discovery.detailUrls.length;
        liveJob.discoveredListPages = discovery.scannedListPages;
        liveJob.errors.push(...discovery.errors);
        liveJob.updatedAt = new Date().toISOString();
      });
    }
    const current = await readStore();
    const currentJob = current.bulkImports.find((item) => item.id === importId);
    if (!currentJob || currentJob.status !== 'running') return;
    const urls = currentJob.manifest.slice(currentJob.cursor, currentJob.cursor + currentJob.batchSize);
    if (!urls.length) {
      await updateStore((data) => {
        const liveJob = data.bulkImports.find((item) => item.id === importId);
        if (!liveJob) return;
        liveJob.status = 'completed';
        liveJob.phase = 'completed';
        liveJob.completedAt = new Date().toISOString();
        liveJob.updatedAt = liveJob.completedAt;
        audit(data, { actor: liveJob.actor, action: 'bulk_import_completed', targetType: 'bulk_import', targetId: importId, detail: { total: liveJob.total, createdCandidates: liveJob.createdCandidates } });
      });
      return;
    }
    const fetched = await fetchOfficialDocuments(source, urls, { concurrency: currentJob.retryOf || source.url.includes('npc.gov.cn') ? 1 : 3 });
    await updateStore((data) => {
      const liveJob = data.bulkImports.find((item) => item.id === importId);
      if (!liveJob || liveJob.status !== 'running') return;
      let created = 0;
      for (const input of fetched.documents) if (addCandidateIfNew(data, input, { importId })) created += 1;
      liveJob.cursor += urls.length;
      liveJob.processed += urls.length;
      liveJob.createdCandidates += created;
      liveJob.skippedDuplicates += fetched.documents.length - created;
      liveJob.errors.push(...fetched.errors);
      liveJob.failures = [...(liveJob.failures || []), ...fetched.failures].slice(-2000);
      liveJob.updatedAt = new Date().toISOString();
      audit(data, { actor: liveJob.actor, action: 'bulk_import_batch_processed', targetType: 'bulk_import', targetId: importId, detail: { processed: liveJob.processed, total: liveJob.total, created } });
      const blockedFailure = fetched.failures.find((failure) => [403, 429].includes(failure.status));
      if (blockedFailure) {
        liveJob.status = 'blocked';
        liveJob.phase = 'blocked';
        liveJob.blockedReason = `官方站点返回 ${blockedFailure.status}，已暂停以避免继续请求。`;
        liveJob.retryAfter = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        retryAfter = liveJob.retryAfter;
        audit(data, { actor: liveJob.actor, action: 'bulk_import_rate_limited', targetType: 'bulk_import', targetId: importId, detail: { status: blockedFailure.status, retryAfter: liveJob.retryAfter } });
      } else if (source.url.includes('npc.gov.cn') && fetched.documents.length === 0 && fetched.failures.length === urls.length && fetched.failures.every((failure) => /fetch failed|Unexpected token '<'/.test(failure.message))) {
        liveJob.status = 'blocked';
        liveJob.phase = 'blocked';
        liveJob.blockedReason = '国家法律法规数据库暂时拒绝连接，已暂停以避免重复请求。';
        liveJob.retryAfter = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        retryAfter = liveJob.retryAfter;
        audit(data, { actor: liveJob.actor, action: 'bulk_import_connection_backoff', targetType: 'bulk_import', targetId: importId, detail: { retryAfter: liveJob.retryAfter } });
      } else if (liveJob.cursor >= liveJob.total) {
        liveJob.status = 'completed';
        liveJob.phase = 'completed';
        liveJob.completedAt = new Date().toISOString();
        liveJob.updatedAt = liveJob.completedAt;
        audit(data, { actor: liveJob.actor, action: 'bulk_import_completed', targetType: 'bulk_import', targetId: importId, detail: { total: liveJob.total, createdCandidates: liveJob.createdCandidates } });
      } else {
        shouldContinue = liveJob.status === 'running';
      }
    });
  } catch (error) {
    await updateStore((data) => {
      const job = (data.bulkImports || []).find((item) => item.id === importId);
      if (!job) return;
      job.status = 'failed';
      job.phase = 'failed';
      job.errors.push(error.message);
      job.updatedAt = new Date().toISOString();
      audit(data, { actor: job.actor, action: 'bulk_import_failed', targetType: 'bulk_import', targetId: importId, detail: { error: error.message } });
    });
  } finally {
    activeBulkImports.delete(importId);
    if (retryAfter) scheduleBulkImportRetry(importId, retryAfter);
    else if (shouldContinue) queueBulkImport(importId);
  }
}

function statusFromOfficialPage(status) {
  return ['current', 'revised', 'repealed'].includes(status) ? status : null;
}

function requeueStatusFailures(job) {
  const recorded = Array.isArray(job.retryUrls) && job.retryUrls.length ? job.retryUrls : (job.failures || []).map((failure) => failure.url);
  const urls = [...new Set(recorded.filter(Boolean))];
  if (!urls.length) return 0;
  job.manifest.push(...urls);
  job.total += urls.length;
  job.retryUrls = [];
  job.retryCount = (job.retryCount || 0) + urls.length;
  return urls.length;
}

function queueStatusCheck(checkId, delayMs = 0) {
  if (activeStatusChecks.has(checkId)) return;
  const timer = setTimeout(() => runStatusCheck(checkId), delayMs);
  timer.unref();
}

function scheduleStatusCheckRetry(checkId, retryAfter) {
  if (!retryAfter) return;
  const existing = scheduledStatusRetries.get(checkId);
  if (existing) clearTimeout(existing);
  const delay = Math.max(new Date(retryAfter).getTime() - Date.now(), 0);
  const timer = setTimeout(async () => {
    scheduledStatusRetries.delete(checkId);
    try {
      const job = await updateStore((data) => {
        const value = (data.statusChecks || []).find((item) => item.id === checkId);
        if (!value || value.status !== 'blocked' || (value.retryAfter && new Date(value.retryAfter) > new Date())) return null;
        const retried = requeueStatusFailures(value);
        value.status = 'running';
        value.blockedReason = null;
        value.retryAfter = null;
        value.updatedAt = new Date().toISOString();
        audit(data, { actor: 'status-check-retry', action: 'official_status_check_auto_resumed', targetType: 'status_check', targetId: checkId, detail: { retried } });
        return value;
      });
      if (job) queueStatusCheck(checkId);
    } catch (error) {
      console.error(`Status check retry failed for ${checkId}:`, error.message);
    }
  }, delay);
  timer.unref();
  scheduledStatusRetries.set(checkId, timer);
}

async function runStatusCheck(checkId) {
  if (activeStatusChecks.has(checkId)) return;
  activeStatusChecks.add(checkId);
  let shouldContinue = false;
  let retryAfter = null;
  try {
    const snapshot = await readStore();
    const job = (snapshot.statusChecks || []).find((item) => item.id === checkId);
    if (!job || job.status !== 'running') return;
    const source = snapshot.sources.find((item) => item.id === job.sourceId);
    if (!source) throw new Error('状态核验来源不存在。');
    // 官方站点会对短时间内的并发详情页请求进行保护。状态核验只需要
    // 获取状态标记，采用 5 条一批、串行请求，并在批次间留出间隔。
    const urls = job.manifest.slice(job.cursor, job.cursor + Math.min(job.batchSize, 5));
    if (!urls.length) {
      await updateStore((data) => {
        const liveJob = data.statusChecks.find((item) => item.id === checkId);
        if (!liveJob) return;
        liveJob.status = 'completed';
        liveJob.completedAt = new Date().toISOString();
        liveJob.updatedAt = liveJob.completedAt;
        audit(data, { actor: liveJob.actor, action: 'official_status_check_completed', targetType: 'status_check', targetId: checkId, detail: { total: liveJob.total, updated: liveJob.updated } });
      });
      return;
    }
    const fetched = await fetchChinaTaxDocuments(source, urls, { concurrency: 1 });
    const parsedByUrl = new Map(fetched.documents.map((document) => [document.officialUrl, document]));
    await updateStore((data) => {
      const liveJob = data.statusChecks.find((item) => item.id === checkId);
      if (!liveJob || liveJob.status !== 'running') return;
      let changed = 0;
      let noSignal = 0;
      for (const url of urls) {
        const parsed = parsedByUrl.get(url);
        const nextStatus = statusFromOfficialPage(parsed?.status);
        if (!nextStatus) {
          noSignal += 1;
          continue;
        }
        const document = data.documents.find((item) => item.officialUrl === url);
        if (!document || document.status === 'expired') continue;
        if (document.status === nextStatus) continue;
        const previousStatus = document.status;
        document.status = nextStatus;
        document.statusCheckedAt = new Date().toISOString();
        changed += 1;
        audit(data, { actor: 'official-status-check', action: 'document_status_synchronised', targetType: 'document', targetId: document.id, detail: { previousStatus, status: nextStatus, officialUrl: url } });
      }
      liveJob.cursor += urls.length;
      liveJob.processed += urls.length;
      liveJob.updated += changed;
      liveJob.noSignal += noSignal;
      liveJob.errors.push(...fetched.errors);
      liveJob.failures = [...liveJob.failures, ...fetched.failures].slice(-500);
      liveJob.retryUrls = [...new Set([...(liveJob.retryUrls || []), ...fetched.failures.map((failure) => failure.url).filter(Boolean)])].slice(-100);
      liveJob.updatedAt = new Date().toISOString();
      const blockedFailure = fetched.failures.find((failure) => [403, 429].includes(failure.status));
      if (blockedFailure) {
        liveJob.status = 'blocked';
        liveJob.blockedReason = `官方站点返回 ${blockedFailure.status}，已暂停以避免继续请求。`;
        liveJob.retryAfter = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        retryAfter = liveJob.retryAfter;
      } else if (liveJob.cursor >= liveJob.total) {
        liveJob.status = 'completed';
        liveJob.completedAt = new Date().toISOString();
      } else {
        shouldContinue = true;
      }
    });
  } catch (error) {
    await updateStore((data) => {
      const job = (data.statusChecks || []).find((item) => item.id === checkId);
      if (!job) return;
      job.status = 'failed';
      job.errors.push(error.message);
      job.updatedAt = new Date().toISOString();
    });
  } finally {
    activeStatusChecks.delete(checkId);
    if (shouldContinue) queueStatusCheck(checkId, 2_000);
    if (retryAfter) scheduleStatusCheckRetry(checkId, retryAfter);
  }
}

async function resumeBulkImports() {
  const data = await readStore();
  for (const job of (data.bulkImports || []).filter((item) => ['queued', 'discovering', 'running'].includes(item.status))) queueBulkImport(job.id);
  for (const job of (data.bulkImports || []).filter((item) => item.status === 'blocked' && item.retryAfter)) scheduleBulkImportRetry(job.id, job.retryAfter);
}

async function resumeStatusChecks() {
  const data = await readStore();
  for (const job of data.statusChecks || []) {
    if (job.status === 'running') queueStatusCheck(job.id);
    if (job.status === 'blocked' && job.retryAfter) scheduleStatusCheckRetry(job.id, job.retryAfter);
  }
}

function scheduleDailyCollections() {
  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(8, 15, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const timer = setTimeout(async () => {
      try {
        const data = await readStore();
        for (const source of data.sources.filter((item) => item.enabled && item.scanFrequency === 'daily' && (item.collector || item.url.includes('fgk.chinatax.gov.cn') || item.url.includes('mof.gov.cn')))) {
          try { await collectSource(source.id, 'scheduler', { mode: 'scheduled', maxDocuments: 25 }); } catch (error) { console.error(`Scheduled collection failed for ${source.id}:`, error.message); }
        }
      } finally {
        scheduleNext();
      }
    }, next.getTime() - now.getTime());
    timer.unref();
  };
  scheduleNext();
}

async function api(request, response, url) {
  const { pathname } = url;
  if (request.method === 'GET' && pathname === '/api/health') return send(response, 200, { ok: true });

  if (request.method === 'POST' && pathname === '/api/auth/login') {
    const { username, password } = await jsonBody(request);
    const account = users[username];
    if (!account || account.password !== password) return send(response, 401, { error: '用户名或密码不正确。' });
    const token = crypto.randomUUID();
    const user = { username, role: account.role, displayName: account.displayName };
    sessions.set(token, user);
    return send(response, 200, { token, user });
  }
  if (request.method === 'GET' && pathname === '/api/me') {
    const user = requireUser(request, response);
    if (user) send(response, 200, { user });
    return;
  }
  if (request.method === 'POST' && pathname === '/api/auth/logout') {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (token) sessions.delete(token);
    return send(response, 204, {});
  }

  // These endpoints are public by design: they only expose cards approved for publication.
  if (request.method === 'GET' && pathname === '/api/knowledge/tax-types') {
    const data = await readStore();
    const byTaxType = new Map();
    for (const card of (data.knowledgeCards || []).filter((item) => item.status === 'published')) {
      const current = byTaxType.get(card.taxType) || { label: card.taxType, count: 0, updatedAt: card.updatedAt };
      current.count += 1;
      if (String(card.updatedAt) > String(current.updatedAt)) current.updatedAt = card.updatedAt;
      byTaxType.set(card.taxType, current);
    }
    return send(response, 200, { taxTypes: [...byTaxType.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN')) });
  }
  if (request.method === 'GET' && pathname === '/api/knowledge/cards') {
    const data = await readStore();
    const query = url.searchParams.get('query') || '';
    const taxType = url.searchParams.get('taxType') || '';
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 30, 1), 100);
    const results = searchKnowledgeCards(data.knowledgeCards || [], { query, taxType }).slice(0, limit);
    return send(response, 200, { total: results.length, results: results.map(({ card, score }) => ({ card: publicKnowledgeCard(card), score })) });
  }
  if (request.method === 'GET' && pathname.startsWith('/api/knowledge/cards/')) {
    const id = pathname.split('/').pop();
    const data = await readStore();
    const card = (data.knowledgeCards || []).find((item) => item.id === id && item.status === 'published');
    if (!card) return send(response, 404, { error: '未找到已发布知识卡片。' });
    return send(response, 200, { card: publicKnowledgeCard(card) });
  }

  const user = requireUser(request, response);
  if (!user) return;
  if (request.method === 'GET' && pathname === '/api/documents') {
    const data = await readStore();
    const documents = data.documents.filter((document) => document.publishedToMembersAt);
    const filters = Object.fromEntries(url.searchParams);
    const allResults = searchDocuments(documents, filters);
    const hasPagination = url.searchParams.has('limit') || url.searchParams.has('offset');
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    const results = hasPagination ? allResults.slice(offset, offset + limit) : allResults;
    return send(response, 200, { total: allResults.length, offset: hasPagination ? offset : 0, limit: hasPagination ? limit : allResults.length, hasMore: hasPagination && offset + results.length < allResults.length, results: results.map(({ document, score, matchingSections }) => ({
      document: publicDocument(document, data.sources.find((source) => source.id === document.sourceId)),
      score,
      matchingSections
    })) });
  }
  if (request.method === 'GET' && pathname.startsWith('/api/documents/')) {
    const data = await readStore();
    const document = data.documents.find((item) => item.id === pathname.split('/').pop() && item.publishedToMembersAt);
    if (!document) return send(response, 404, { error: '未找到已发布文件。' });
    const detail = publicDocument(document, data.sources.find((source) => source.id === document.sourceId));
    detail.relatedDocuments = (document.relations || []).map((relation) => {
      const related = data.documents.find((item) => item.id === relation.documentId && item.publishedToMembersAt);
      return related ? { type: relation.type, id: related.id, title: related.title, status: related.status, officialUrl: related.officialUrl } : null;
    }).filter(Boolean);
    return send(response, 200, { document: detail });
  }
  if (request.method === 'GET' && pathname === '/api/topics') return send(response, 200, { topics: Object.entries(TAX_TOPICS).map(([id, value]) => ({ id, label: value.label })) });
  if (request.method === 'GET' && pathname === '/api/taxonomy') {
    const data = await readStore();
    const status = url.searchParams.get('status') || '';
    const publishedYear = url.searchParams.get('publishedYear') || '';
    const documents = data.documents.filter((document) => document.publishedToMembersAt && (!status || document.status === status) && (!publishedYear || String(document.publishedAt || '').startsWith(`${publishedYear}-`)));
    return send(response, 200, { total: documents.length, categories: taxonomySummary(documents) });
  }
  if (request.method === 'GET' && pathname.startsWith('/api/topics/')) {
    const topic = pathname.split('/').pop();
    if (!TAX_TOPICS[topic]) return send(response, 404, { error: '未找到税种专题。' });
    const data = await readStore();
    const scoped = documentsForTopic(data.documents.filter((document) => document.publishedToMembersAt), topic);
    const mapItem = ({ document, score, matchingSections }) => ({ document: publicDocument(document, data.sources.find((source) => source.id === document.sourceId)), score, matchingSections });
    return send(response, 200, { topic: { id: topic, label: TAX_TOPICS[topic].label }, current: scoped.current.map(mapItem), history: scoped.history.map(mapItem), coverage: { publishedDocuments: data.documents.filter((document) => document.publishedToMembersAt).length, currentDocuments: scoped.current.length } });
  }
  if (request.method === 'POST' && pathname === '/api/query') {
    const { question = '', taxType = '', publishedYear = '' } = await jsonBody(request);
    const data = await readStore();
    const candidates = data.documents.filter((document) => document.publishedToMembersAt && document.status === 'current');
    const results = searchDocuments(candidates, { query: question, taxType, publishedYear }).slice(0, 5);
    const responseBody = await answerFromEvidence({ question, results });
    await updateStore((current) => audit(current, { actor: user.username, action: 'query', targetType: 'query', targetId: 'n/a', detail: { question, answered: responseBody.answered } }));
    return send(response, 200, { ...responseBody, results: results.map(({ document, score, matchingSections }) => ({
      document: publicDocument(document, data.sources.find((source) => source.id === document.sourceId)), score, matchingSections
    })) });
  }

  if (user.role !== 'admin') return send(response, 403, { error: '仅管理员可执行此操作。' });
  if (request.method === 'GET' && pathname === '/api/admin/knowledge-cards') return send(response, 200, { cards: (await readStore()).knowledgeCards || [] });
  if (request.method === 'GET' && pathname === '/api/admin/knowledge-card-candidates') return send(response, 200, { candidates: (await readStore()).knowledgeCardCandidates || [] });
  if (request.method === 'POST' && pathname === '/api/admin/knowledge-card-candidates') {
    const input = await jsonBody(request);
    const candidate = await updateStore((data) => {
      const replacesCardId = String(input.replacesCardId || '').trim() || null;
      if (replacesCardId && !(data.knowledgeCards || []).some((card) => card.id === replacesCardId && card.status === 'published')) throw new Error('要更新的已发布知识卡片不存在。');
      const value = { id: newId(data, 'knowledge-card-candidate'), card: buildKnowledgeCard(input, { id: null, status: 'draft' }), replacesCardId, state: 'pending', createdAt: new Date().toISOString(), reviewedAt: null, reviewedBy: null, reviewNote: '' };
      data.knowledgeCardCandidates = data.knowledgeCardCandidates || [];
      data.knowledgeCardCandidates.unshift(value);
      audit(data, { actor: user.username, action: 'knowledge_card_candidate_created', targetType: 'knowledge_card_candidate', targetId: value.id, detail: { taxType: value.card.taxType, topic: value.card.topic, replacesCardId } });
      return value;
    });
    return send(response, 201, { candidate });
  }
  if (request.method === 'POST' && /^\/api\/admin\/knowledge-card-candidates\/[^/]+\/review$/.test(pathname)) {
    const candidateId = pathname.split('/')[4];
    const { action, note = '' } = await jsonBody(request);
    const outcome = await updateStore((data) => {
      const candidate = (data.knowledgeCardCandidates || []).find((item) => item.id === candidateId && item.state === 'pending');
      if (!candidate) throw new Error('待审知识卡片不存在或已处理。');
      if (!['publish', 'reject'].includes(action)) throw new Error('审核动作无效。');
      const now = new Date().toISOString();
      candidate.reviewedAt = now;
      candidate.reviewedBy = user.username;
      candidate.reviewNote = String(note);
      if (action === 'reject') {
        candidate.state = 'rejected';
        audit(data, { actor: user.username, action: 'knowledge_card_rejected', targetType: 'knowledge_card_candidate', targetId: candidate.id, detail: { note } });
        return { candidate };
      }
      data.knowledgeCards = data.knowledgeCards || [];
      let card;
      if (candidate.replacesCardId) {
        const existing = data.knowledgeCards.find((item) => item.id === candidate.replacesCardId && item.status === 'published');
        if (!existing) throw new Error('要更新的已发布知识卡片不存在。');
        const { versions: ignoredVersions, ...snapshot } = existing;
        const versions = [...(existing.versions || []), { version: existing.version, savedAt: now, card: snapshot }];
        card = buildKnowledgeCard({ ...candidate.card, id: existing.id, createdAt: existing.createdAt }, { id: existing.id, status: 'published', now, version: Number(existing.version || 1) + 1, versions });
        Object.assign(existing, card);
      } else {
        const id = newId(data, 'knowledge-card');
        card = buildKnowledgeCard(candidate.card, { id, status: 'published', now, version: 1, versions: [] });
        data.knowledgeCards.unshift(card);
      }
      candidate.state = 'published';
      candidate.publishedCardId = card.id;
      audit(data, { actor: user.username, action: 'knowledge_card_published', targetType: 'knowledge_card', targetId: card.id, detail: { candidateId: candidate.id, version: card.version, updated: Boolean(candidate.replacesCardId) } });
      return { candidate, card };
    });
    return send(response, 200, outcome);
  }
  if (request.method === 'POST' && /^\/api\/admin\/knowledge-cards\/[^/]+\/rollback$/.test(pathname)) {
    const cardId = pathname.split('/')[4];
    const { version } = await jsonBody(request);
    const card = await updateStore((data) => {
      const current = (data.knowledgeCards || []).find((item) => item.id === cardId && item.status === 'published');
      if (!current) throw new Error('已发布知识卡片不存在。');
      const target = (current.versions || []).find((item) => Number(item.version) === Number(version));
      if (!target?.card) throw new Error('找不到要回退的历史版本。');
      const now = new Date().toISOString();
      const { versions: ignoredVersions, ...snapshot } = current;
      const versions = [...(current.versions || []), { version: current.version, savedAt: now, card: snapshot }];
      const restored = buildKnowledgeCard({ ...target.card, id: current.id, createdAt: current.createdAt }, { id: current.id, status: 'published', now, version: Number(current.version || 1) + 1, versions });
      Object.assign(current, restored);
      audit(data, { actor: user.username, action: 'knowledge_card_rolled_back', targetType: 'knowledge_card', targetId: current.id, detail: { restoredVersion: Number(version), version: current.version } });
      return current;
    });
    return send(response, 200, { card });
  }
  if (request.method === 'GET' && pathname === '/api/admin/sources') return send(response, 200, { sources: (await readStore()).sources });
  if (request.method === 'POST' && pathname === '/api/admin/sources') {
    const input = await jsonBody(request);
    const source = await updateStore((data) => {
      if (!input.name || !input.authority || !input.url) throw new Error('来源名称、发布机关和链接均为必填项。');
      if (!isOfficialSourceUrl(input.url)) throw new Error('首期只允许登记国家税务总局、财政部、中国政府网或中国人大网的官方来源。');
      const value = { id: newId(data, 'source'), name: input.name, authority: input.authority, url: input.url, collectionUrl: input.collectionUrl || input.url, collector: input.collector || '', kind: input.kind || '官方来源', enabled: input.enabled !== false, scanFrequency: input.scanFrequency || 'daily', lastScannedAt: null };
      data.sources.push(value);
      audit(data, { actor: user.username, action: 'source_created', targetType: 'source', targetId: value.id });
      return value;
    });
    return send(response, 201, { source });
  }
  if (request.method === 'POST' && /^\/api\/admin\/sources\/[^/]+\/collect$/.test(pathname)) {
    const sourceId = pathname.split('/')[4];
    const { maxDocuments = 25 } = await jsonBody(request);
    const collection = await collectSource(sourceId, user.username, { mode: 'manual', maxDocuments });
    return send(response, 200, { collection });
  }
  if (request.method === 'POST' && /^\/api\/admin\/sources\/[^/]+\/collect-urls$/.test(pathname)) {
    const sourceId = pathname.split('/')[4];
    const { urls = [] } = await jsonBody(request);
    const collection = await collectOfficialUrls(sourceId, user.username, urls);
    return send(response, 200, { collection });
  }
  if (request.method === 'GET' && pathname === '/api/admin/collections') return send(response, 200, { collections: (await readStore()).collections || [] });
  if (request.method === 'GET' && pathname === '/api/admin/bulk-imports') return send(response, 200, { imports: (await readStore()).bulkImports || [] });
  if (request.method === 'GET' && pathname === '/api/admin/status-checks') {
    const checks = ((await readStore()).statusChecks || []).map(({ manifest, failures, ...item }) => ({ ...item, failures: failures.length }));
    return send(response, 200, { checks });
  }
  if (request.method === 'POST' && pathname === '/api/admin/status-checks') {
    const { sourceId = 'source-chinatax', batchSize = 20 } = await jsonBody(request);
    const job = await updateStore((data) => {
      const source = data.sources.find((item) => item.id === sourceId);
      if (!source) throw new Error('来源不存在。');
      if (!source.url.includes('chinatax.gov.cn')) throw new Error('当前自动状态核验仅支持国家税务总局政策法规库。');
      const active = (data.statusChecks || []).find((item) => item.sourceId === sourceId && item.status === 'running');
      if (active) return active;
      const manifest = data.documents.filter((document) => document.sourceId === sourceId && document.publishedToMembersAt && document.officialUrl.includes('chinatax.gov.cn')).map((document) => document.officialUrl);
      if (!manifest.length) throw new Error('该来源没有可核验的已发布文件。');
      data.statusChecks = data.statusChecks || [];
      const now = new Date().toISOString();
      const value = { id: newId(data, 'status-check'), sourceId, actor: user.username, status: 'running', batchSize: Math.min(Math.max(Number(batchSize) || 20, 5), 30), manifest, cursor: 0, total: manifest.length, processed: 0, updated: 0, noSignal: 0, errors: [], failures: [], retryUrls: [], retryCount: 0, blockedReason: null, retryAfter: null, createdAt: now, updatedAt: now, completedAt: null };
      data.statusChecks.unshift(value);
      audit(data, { actor: user.username, action: 'official_status_check_started', targetType: 'status_check', targetId: value.id, detail: { sourceId, total: value.total } });
      return value;
    });
    queueStatusCheck(job.id);
    const { manifest, failures, ...publicJob } = job;
    return send(response, 202, { check: { ...publicJob, failures: failures.length } });
  }
  if (request.method === 'POST' && /^\/api\/admin\/status-checks\/[^/]+\/resume$/.test(pathname)) {
    const checkId = pathname.split('/')[4];
    const job = await updateStore((data) => {
      const value = (data.statusChecks || []).find((item) => item.id === checkId);
      if (!value) throw new Error('状态核验任务不存在。');
      if (!['blocked', 'failed'].includes(value.status)) return value;
      if (value.retryAfter && new Date(value.retryAfter) > new Date()) throw new Error(`官方限制尚未结束，请在 ${value.retryAfter} 后重试。`);
      const retried = requeueStatusFailures(value);
      value.status = 'running';
      value.blockedReason = null;
      value.retryAfter = null;
      value.updatedAt = new Date().toISOString();
      audit(data, { actor: user.username, action: 'official_status_check_resumed', targetType: 'status_check', targetId: checkId, detail: { retried } });
      return value;
    });
    queueStatusCheck(job.id);
    const { manifest, failures, ...publicJob } = job;
    return send(response, 200, { check: { ...publicJob, failures: failures.length } });
  }
  if (request.method === 'POST' && /^\/api\/admin\/sources\/[^/]+\/full-import$/.test(pathname)) {
    const sourceId = pathname.split('/')[4];
    const { batchSize = 25, maxListPages = 240 } = await jsonBody(request);
    const job = await updateStore((data) => {
      const source = data.sources.find((item) => item.id === sourceId);
      if (!source) throw new Error('来源不存在。');
      if (!source.enabled) throw new Error('该来源已停用。');
      const active = (data.bulkImports || []).find((item) => item.sourceId === sourceId && ['queued', 'discovering', 'running'].includes(item.status));
      if (active) return active;
      data.bulkImports = data.bulkImports || [];
      const now = new Date().toISOString();
      const value = { id: newId(data, 'bulk-import'), sourceId, actor: user.username, status: 'discovering', phase: 'discovering', batchSize: Math.min(Math.max(Number(batchSize) || 25, 5), 50), maxListPages: Math.min(Math.max(Number(maxListPages) || 240, 20), 500), manifest: null, cursor: 0, total: null, processed: 0, createdCandidates: 0, skippedDuplicates: 0, discoveredListPages: 0, errors: [], failures: [], createdAt: now, updatedAt: now, completedAt: null };
      data.bulkImports.unshift(value);
      audit(data, { actor: user.username, action: 'bulk_import_started', targetType: 'bulk_import', targetId: value.id, detail: { sourceId, batchSize: value.batchSize } });
      return value;
    });
    queueBulkImport(job.id);
    return send(response, 202, { import: job });
  }
  if (request.method === 'POST' && /^\/api\/admin\/bulk-imports\/[^/]+\/retry$/.test(pathname)) {
    const importId = pathname.split('/')[4];
    const job = await updateStore((data) => {
      const original = (data.bulkImports || []).find((item) => item.id === importId);
      if (!original || !Array.isArray(original.manifest)) throw new Error('找不到可重试的导入任务。');
      const knownUrls = new Set([
        ...data.documents.map((document) => document.officialUrl),
        ...data.candidates.map((candidate) => candidate.document.officialUrl)
      ]);
      const manifest = original.manifest.filter((url) => !knownUrls.has(url));
      if (!manifest.length) throw new Error('没有需要重试的文件。');
      data.bulkImports = data.bulkImports || [];
      const now = new Date().toISOString();
      const value = { id: newId(data, 'bulk-import'), sourceId: original.sourceId, actor: user.username, status: 'running', phase: 'importing', retryOf: original.id, batchSize: 10, maxListPages: 0, manifest, cursor: 0, total: manifest.length, processed: 0, createdCandidates: 0, skippedDuplicates: 0, discoveredListPages: 0, errors: [], failures: [], createdAt: now, updatedAt: now, completedAt: null };
      data.bulkImports.unshift(value);
      audit(data, { actor: user.username, action: 'bulk_import_retry_started', targetType: 'bulk_import', targetId: value.id, detail: { retryOf: original.id, total: manifest.length } });
      return value;
    });
    queueBulkImport(job.id);
    return send(response, 202, { import: job });
  }
  if (request.method === 'POST' && /^\/api\/admin\/bulk-imports\/[^/]+\/(pause|resume)$/.test(pathname)) {
    const [, importId, action] = pathname.match(/^\/api\/admin\/bulk-imports\/([^/]+)\/(pause|resume)$/);
    const job = await updateStore((data) => {
      const value = (data.bulkImports || []).find((item) => item.id === importId);
      if (!value) throw new Error('导入任务不存在。');
      if (action === 'pause' && ['discovering', 'running', 'queued'].includes(value.status)) value.status = 'paused';
      if (action === 'resume' && value.status === 'blocked' && value.retryAfter && new Date(value.retryAfter) > new Date()) throw new Error(`官方站点限制尚未结束，请在 ${value.retryAfter} 后重试。`);
      if (action === 'resume' && ['paused', 'failed', 'blocked'].includes(value.status)) { value.status = value.manifest ? 'running' : 'discovering'; value.phase = value.manifest ? 'importing' : 'discovering'; value.blockedReason = null; value.retryAfter = null; }
      value.updatedAt = new Date().toISOString();
      audit(data, { actor: user.username, action: `bulk_import_${action}d`, targetType: 'bulk_import', targetId: importId });
      return value;
    });
    if (action === 'resume') queueBulkImport(job.id);
    return send(response, 200, { import: job });
  }
  if (request.method === 'GET' && pathname === '/api/admin/candidates') return send(response, 200, { candidates: (await readStore()).candidates });
  if (request.method === 'GET' && pathname === '/api/admin/priority-review') {
    const data = await readStore();
    const queue = priorityReviewQueue(data.documents, { limit: url.searchParams.get('limit') || 20 });
    return send(response, 200, {
      ...queue,
      groups: queue.groups.map((group) => ({
        ...group,
        items: group.items.map((item) => ({
          ...item,
          document: publicDocument(item.document, data.sources.find((source) => source.id === item.document.sourceId))
        }))
      }))
    });
  }
  if (request.method === 'POST' && pathname === '/api/admin/document-review') {
    const { apply = false } = await jsonBody(request);
    const snapshot = await readStore();
    const summary = publishedDocumentReviewSummary(snapshot.documents);
    if (!apply) return send(response, 200, { applied: false, ...summary });
    const outcome = await updateStore((data) => {
      const review = publishedDocumentReviewSummary(data.documents);
      const expirable = new Map(review.decisions.filter((item) => item.decision === 'expire').map((item) => [item.documentId, item]));
      const updated = [];
      const now = new Date().toISOString();
      for (const document of data.documents) {
        const decision = expirable.get(document.id);
        if (!decision || document.status !== 'pending_verification') continue;
        const previousStatus = document.status;
        document.status = 'expired';
        document.statusCheckedAt = now;
        updated.push({ id: document.id, title: document.title, expiryDate: decision.expiryDate });
        audit(data, { actor: 'published-document-review', action: 'document_status_confirmed_expired', targetType: 'document', targetId: document.id, detail: { previousStatus, status: 'expired', expiryDate: decision.expiryDate, evidence: decision.evidence } });
      }
      audit(data, { actor: user.username, action: 'published_document_review_applied', targetType: 'document_batch', targetId: 'published-pending', detail: { examined: review.examined, expired: updated.length, held: review.held, rule: 'explicit-policy-expiry' } });
      return { applied: true, examined: review.examined, expired: updated.length, held: review.held, documents: updated };
    });
    return send(response, 200, outcome);
  }
  if (request.method === 'POST' && pathname === '/api/admin/document-version-review') {
    const { apply = false } = await jsonBody(request);
    const snapshot = await readStore();
    const summary = publishedDocumentVersionReviewSummary(snapshot.documents);
    const unlinked = unlinkedVersionRelations(snapshot.documents, summary.relationLinks);
    if (!apply) return send(response, 200, { applied: false, ...summary, linkable: unlinked.length, updateable: summary.statusUpdates.length });
    const outcome = await updateStore((data) => {
      const review = publishedDocumentVersionReviewSummary(data.documents);
      const pendingLinks = unlinkedVersionRelations(data.documents, review.relationLinks);
      const now = new Date().toISOString();
      let linked = 0;
      for (const link of pendingLinks) {
        const source = data.documents.find((document) => document.id === link.sourceId);
        const target = data.documents.find((document) => document.id === link.targetId);
        if (!source || !target) continue;
        source.relations = source.relations || [];
        target.relations = target.relations || [];
        if (source.relations.some((relation) => relation.documentId === target.id && relation.type === link.type)) continue;
        source.relations.push({ documentId: target.id, type: link.type });
        target.relations.push({ documentId: source.id, type: link.type === 'repeals' ? 'repealed_by' : 'revised_by' });
        linked += 1;
        audit(data, { actor: 'published-version-review', action: 'document_relation_linked', targetType: 'document', targetId: source.id, detail: { relatedDocumentId: target.id, type: link.type, evidence: link.evidence } });
      }
      let updated = 0;
      for (const decision of review.statusUpdates) {
        const target = data.documents.find((document) => document.id === decision.documentId);
        if (!target || target.status === 'expired' || target.status === decision.status) continue;
        const previousStatus = target.status;
        target.status = decision.status;
        target.statusCheckedAt = now;
        updated += 1;
        audit(data, { actor: 'published-version-review', action: 'document_status_confirmed_by_version', targetType: 'document', targetId: target.id, detail: { previousStatus, status: decision.status, sourceDocumentId: decision.sourceId, relationType: decision.type, evidence: 'explicit-version-relation' } });
      }
      audit(data, { actor: user.username, action: 'published_document_version_review_applied', targetType: 'document_batch', targetId: 'published-documents', detail: { examined: review.examined, linked, updated, rule: 'exact-title-nearby-version-marker' } });
      return { applied: true, examined: review.examined, linked, updated, linkable: pendingLinks.length, updateable: review.statusUpdates.length };
    });
    return send(response, 200, outcome);
  }
  if (request.method === 'POST' && pathname === '/api/admin/auto-review') {
    const { apply = false } = await jsonBody(request);
    const snapshot = await readStore();
    const summary = automaticReviewSummary(snapshot.candidates);
    if (!apply) return send(response, 200, { applied: false, ...summary });
    const outcome = await updateStore((data) => {
      const review = automaticReviewSummary(data.candidates);
      const publishable = new Map(review.decisions.filter((item) => item.decision === 'publish').map((item) => [item.candidateId, item]));
      const published = [];
      const now = new Date().toISOString();
      for (const candidate of data.candidates) {
        const decision = publishable.get(candidate.id);
        if (!decision || candidate.state !== 'pending') continue;
        const id = newId(data, 'doc');
        const document = buildDocument({ ...candidate.document, id }, data, { id, publishedToMembersAt: now });
        data.documents.push(document);
        candidate.state = 'published';
        candidate.publishedDocumentId = document.id;
        candidate.reviewedAt = now;
        candidate.reviewedBy = 'auto-review';
        candidate.reviewNote = decision.reason;
        candidate.autoReview = { reviewedAt: now, decision: decision.decision, reason: decision.reason, evidence: decision.evidence };
        published.push({ candidateId: candidate.id, documentId: document.id, title: document.title });
        audit(data, { actor: 'auto-review', action: 'candidate_auto_published', targetType: 'document', targetId: document.id, detail: { candidateId: candidate.id, evidence: decision.evidence } });
      }
      audit(data, { actor: user.username, action: 'automatic_review_applied', targetType: 'candidate_batch', targetId: 'pending-candidates', detail: { examined: review.examined, published: published.length, held: review.held } });
      return { applied: true, examined: review.examined, published: published.length, held: review.held, documents: published };
    });
    return send(response, 200, outcome);
  }
  if (request.method === 'POST' && pathname === '/api/admin/candidate-scope-review') {
    const { apply = false } = await jsonBody(request);
    const snapshot = await readStore();
    const summary = candidateScopeReviewSummary(snapshot.candidates);
    if (!apply) return send(response, 200, { applied: false, ...summary });
    const outcome = await updateStore((data) => {
      const review = candidateScopeReviewSummary(data.candidates);
      const rejectable = new Map(review.decisions.filter((item) => item.decision === 'reject').map((item) => [item.candidateId, item]));
      const now = new Date().toISOString();
      let rejected = 0;
      for (const candidate of data.candidates) {
        const decision = rejectable.get(candidate.id);
        if (!decision || candidate.state !== 'pending') continue;
        candidate.state = 'rejected';
        candidate.reviewedAt = now;
        candidate.reviewedBy = 'scope-review';
        candidate.reviewNote = decision.reason;
        rejected += 1;
        audit(data, { actor: 'scope-review', action: 'candidate_scope_rejected', targetType: 'candidate', targetId: candidate.id, detail: { evidence: decision.evidence, title: candidate.document.title } });
      }
      audit(data, { actor: user.username, action: 'candidate_scope_review_applied', targetType: 'candidate_batch', targetId: 'pending-candidates', detail: { examined: review.examined, rejected, retained: review.retained } });
      return { applied: true, examined: review.examined, rejected, retained: review.retained };
    });
    return send(response, 200, outcome);
  }
  if (request.method === 'POST' && pathname === '/api/admin/reindex-topics') {
    const outcome = await updateStore((data) => {
      let updated = 0;
      for (const container of [...data.documents, ...data.candidates.map((candidate) => candidate.document)]) {
        const topics = inferTaxTopics(container);
        if (JSON.stringify(container.taxTypes || []) === JSON.stringify(topics)) continue;
        container.taxTypes = topics;
        updated += 1;
      }
      audit(data, { actor: user.username, action: 'tax_topics_reindexed', targetType: 'document_index', targetId: 'all', detail: { updated } });
      return { updated };
    });
    return send(response, 200, outcome);
  }
  if (request.method === 'POST' && pathname === '/api/admin/publish-classified') {
    const outcome = await updateStore((data) => {
      const now = new Date().toISOString();
      const published = [];
      for (const candidate of data.candidates) {
        if (candidate.state !== 'pending') continue;
        const id = newId(data, 'doc');
        const document = buildDocument({ ...candidate.document, id }, data, { id, publishedToMembersAt: now });
        data.documents.push(document);
        candidate.state = 'published';
        candidate.publishedDocumentId = id;
        candidate.reviewedAt = now;
        candidate.reviewedBy = 'batch-classification';
        candidate.reviewNote = `批量发布，状态：${document.status}`;
        published.push({ id, status: document.status });
        audit(data, { actor: 'batch-classification', action: 'candidate_published_with_status', targetType: 'document', targetId: id, detail: { candidateId: candidate.id, status: document.status } });
      }
      audit(data, { actor: user.username, action: 'classified_candidates_bulk_published', targetType: 'candidate_batch', targetId: 'all-pending', detail: { published: published.length } });
      const byStatus = {};
      for (const item of published) byStatus[item.status] = (byStatus[item.status] || 0) + 1;
      return { published: published.length, byStatus };
    });
    return send(response, 200, outcome);
  }
  if (request.method === 'POST' && pathname === '/api/admin/secondary-review') {
    const { apply = false } = await jsonBody(request);
    const snapshot = await readStore();
    const summary = secondaryReviewSummary(snapshot.candidates, snapshot.documents);
    if (!apply) return send(response, 200, { applied: false, ...summary });
    const outcome = await updateStore((data) => {
      const review = secondaryReviewSummary(data.candidates, data.documents);
      const decisions = new Map(review.decisions.map((item) => [item.candidateId, item]));
      const archived = [];
      const now = new Date().toISOString();
      for (const candidate of data.candidates) {
        const decision = decisions.get(candidate.id);
        if (!decision || candidate.state !== 'pending') continue;
        candidate.autoReview = { reviewedAt: now, phase: 'secondary', decision: decision.decision, reason: decision.reason, evidence: decision.evidence, relationHint: decision.relationHint || null, expiryDate: decision.expiryDate || null };
        if (decision.decision !== 'archive') continue;
        const id = newId(data, 'doc');
        const document = buildDocument({ ...candidate.document, id }, data, { id, publishedToMembersAt: now });
        data.documents.push(document);
        candidate.state = 'published';
        candidate.publishedDocumentId = document.id;
        candidate.reviewedAt = now;
        candidate.reviewedBy = 'secondary-auto-review';
        candidate.reviewNote = decision.reason;
        archived.push({ candidateId: candidate.id, documentId: document.id, title: document.title, status: document.status });
        audit(data, { actor: 'secondary-auto-review', action: 'candidate_auto_archived', targetType: 'document', targetId: document.id, detail: { candidateId: candidate.id, status: document.status, evidence: decision.evidence } });
      }
      audit(data, { actor: user.username, action: 'secondary_review_applied', targetType: 'candidate_batch', targetId: 'pending-candidates', detail: { examined: review.examined, archived: archived.length, held: review.held, relationHints: review.relationHints } });
      return { applied: true, examined: review.examined, archived: archived.length, held: review.held, relationHints: review.relationHints, documents: archived };
    });
    return send(response, 200, outcome);
  }
  if (request.method === 'POST' && pathname === '/api/admin/third-review') {
    const { apply = false } = await jsonBody(request);
    const snapshot = await readStore();
    const summary = thirdReviewSummary(snapshot.candidates, snapshot.documents);
    if (!apply) return send(response, 200, { applied: false, ...summary, linkable: summary.relationLinks.length });
    const outcome = await updateStore((data) => {
      const review = thirdReviewSummary(data.candidates, data.documents);
      const now = new Date().toISOString();
      let linked = 0;
      for (const link of review.relationLinks) {
        const source = data.documents.find((document) => document.id === link.sourceId);
        const target = data.documents.find((document) => document.id === link.targetId);
        if (!source || !target) continue;
        source.relations = source.relations || [];
        target.relations = target.relations || [];
        if (!source.relations.some((relation) => relation.documentId === target.id && relation.type === link.type)) {
          source.relations.push({ documentId: target.id, type: link.type });
          target.relations.push({ documentId: source.id, type: link.type === 'repeals' ? 'repealed_by' : 'revised_by' });
          linked += 1;
          audit(data, { actor: 'third-auto-review', action: 'document_relation_linked', targetType: 'document', targetId: source.id, detail: { relatedDocumentId: target.id, type: link.type } });
        }
      }
      const expiryIds = new Set(data.candidates.filter((candidate) => candidate.state === 'pending' && candidate.autoReview?.evidence === 'expired-term').map((candidate) => candidate.id));
      const archived = [];
      for (const candidate of data.candidates) {
        if (!expiryIds.has(candidate.id) || candidate.state !== 'pending') continue;
        const id = newId(data, 'doc');
        const document = buildDocument({ ...candidate.document, id, status: 'expired' }, data, { id, publishedToMembersAt: now });
        data.documents.push(document);
        candidate.state = 'published';
        candidate.publishedDocumentId = document.id;
        candidate.reviewedAt = now;
        candidate.reviewedBy = 'third-auto-review';
        candidate.reviewNote = `政策期限届满：${candidate.autoReview.expiryDate}`;
        candidate.autoReview = { ...candidate.autoReview, reviewedAt: now, phase: 'third', decision: 'archive', reason: candidate.reviewNote };
        archived.push({ candidateId: candidate.id, documentId: document.id, title: document.title });
        audit(data, { actor: 'third-auto-review', action: 'candidate_auto_archived_expired', targetType: 'document', targetId: document.id, detail: { candidateId: candidate.id, expiryDate: candidate.autoReview.expiryDate } });
      }
      audit(data, { actor: user.username, action: 'third_review_applied', targetType: 'candidate_batch', targetId: 'pending-candidates', detail: { linked, archivedExpired: archived.length, queuedRelationHints: review.queuedRelationHints } });
      return { applied: true, linked, archivedExpired: archived.length, queuedRelationHints: review.queuedRelationHints, documents: archived };
    });
    return send(response, 200, outcome);
  }
  if (request.method === 'POST' && pathname === '/api/admin/third-review/repair-relations') {
    const outcome = await updateStore((data) => {
      const generated = data.audit.filter((item) => item.actor === 'third-auto-review' && item.action === 'document_relation_linked');
      let removed = 0;
      for (const item of generated) {
        const source = data.documents.find((document) => document.id === item.targetId);
        const target = data.documents.find((document) => document.id === item.detail?.relatedDocumentId);
        const type = item.detail?.type;
        if (!source || !target || !type) continue;
        const before = (source.relations || []).length;
        source.relations = (source.relations || []).filter((relation) => !(relation.documentId === target.id && relation.type === type));
        target.relations = (target.relations || []).filter((relation) => !(relation.documentId === source.id && relation.type === (type === 'repeals' ? 'repealed_by' : 'revised_by')));
        if (source.relations.length !== before) removed += 1;
      }
      for (const candidate of data.candidates) {
        if (candidate.autoReview?.phase === 'secondary' && 'relationHint' in candidate.autoReview) candidate.autoReview.relationHint = null;
      }
      audit(data, { actor: user.username, action: 'third_review_relations_repaired', targetType: 'document_relation', targetId: 'auto-generated', detail: { removed, rule: 'relation-marker-must-be-near-mentioned-title' } });
      return { repaired: true, removed };
    });
    return send(response, 200, outcome);
  }
  if (request.method === 'POST' && pathname === '/api/admin/candidates') {
    const input = await jsonBody(request);
    const candidate = await updateStore((data) => {
      const document = buildDocument(input, data);
      const value = { id: newId(data, 'candidate'), document, state: 'pending', discoveredAt: new Date().toISOString(), reviewedAt: null, reviewedBy: null, reviewNote: '' };
      data.candidates.unshift(value);
      audit(data, { actor: user.username, action: 'candidate_created', targetType: 'candidate', targetId: value.id, detail: { title: document.title } });
      return value;
    });
    return send(response, 201, { candidate });
  }
  if (request.method === 'POST' && /^\/api\/admin\/candidates\/[^/]+\/review$/.test(pathname)) {
    const candidateId = pathname.split('/')[4];
    const { action, note = '', overrides = {} } = await jsonBody(request);
    const outcome = await updateStore((data) => {
      const candidate = data.candidates.find((item) => item.id === candidateId && item.state === 'pending');
      if (!candidate) throw new Error('待审候选不存在或已处理。');
      if (!['publish', 'reject'].includes(action)) throw new Error('审核动作无效。');
      candidate.reviewedAt = new Date().toISOString();
      candidate.reviewedBy = user.username;
      candidate.reviewNote = String(note);
      if (action === 'reject') {
        candidate.state = 'rejected';
        audit(data, { actor: user.username, action: 'candidate_rejected', targetType: 'candidate', targetId: candidate.id, detail: { note } });
        return { candidate };
      }
      const merged = { ...candidate.document, ...overrides, id: newId(data, 'doc'), status: allowedStatus(overrides.status) ? overrides.status : candidate.document.status };
      const document = buildDocument(merged, data, { id: merged.id, publishedToMembersAt: new Date().toISOString() });
      data.documents.push(document);
      candidate.state = 'published';
      candidate.publishedDocumentId = document.id;
      audit(data, { actor: user.username, action: 'candidate_published', targetType: 'document', targetId: document.id, detail: { candidateId: candidate.id } });
      return { candidate, document };
    });
    return send(response, 200, outcome);
  }
  if (request.method === 'POST' && /^\/api\/admin\/documents\/[^/]+\/status$/.test(pathname)) {
    const documentId = pathname.split('/')[4];
    const input = await jsonBody(request);
    const { status } = input;
    if (!allowedStatus(status)) return send(response, 400, { error: '状态无效。' });
    const document = await updateStore((data) => {
      const value = data.documents.find((item) => item.id === documentId);
      if (!value) throw new Error('文件不存在。');
      value.status = status;
      if ('relations' in input && Array.isArray(input.relations)) value.relations = input.relations;
      audit(data, { actor: user.username, action: 'document_status_changed', targetType: 'document', targetId: documentId, detail: { status } });
      return value;
    });
    return send(response, 200, { document });
  }
  if (request.method === 'GET' && pathname === '/api/admin/audit') return send(response, 200, { audit: (await readStore()).audit });
  return send(response, 404, { error: '接口不存在。' });
}

async function serveStatic(request, response, pathname) {
  const requested = pathname === '/' ? '/knowledge.html' : pathname;
  const file = normalize(resolve(publicDir, `.${requested}`));
  if (!file.startsWith(publicDir)) return send(response, 403, { error: '禁止访问。' });
  try {
    const content = await readFile(file);
    response.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    response.end(content);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}

export async function createApp() {
  await initialiseStore();
  await resumeBulkImports();
  await resumeStatusChecks();
  scheduleDailyCollections();
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) await api(request, response, url);
      else await serveStatic(request, response, url.pathname);
    } catch (error) {
      const status = error instanceof SyntaxError ? 400 : 422;
      send(response, status, { error: error.message || '请求处理失败。' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().then((server) => server.listen(port, () => console.log(`Tax policy knowledge base is listening on http://localhost:${port}`)));
}
