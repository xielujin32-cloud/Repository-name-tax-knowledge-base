const EXPLICIT_CURRENT = /(?:\u5168\u6587\u6709\u6548|\u73b0\u884c\u6709\u6548)/;
const EXPLICIT_REPEALED = /(?:\u5df2\u5e9f\u6b62|\u5e9f\u6b62\u672c\u6587\u4ef6)/;
const EXPLICIT_REVISED = /(?:\u5df2\u4fee\u8ba2|\u5df2\u4fee\u6539|\u4fee\u8ba2\u672c\u6587\u4ef6|\u4fee\u6539\u672c\u6587\u4ef6)/;
const TAX_POLICY_TITLE = /\u7a0e|\u53d1\u7968|\u5173\u7a0e|\u6d77\u5173/;
const CENTRAL_NPC_AUTHORITY = /\u5168\u56fd\u4eba\u6c11\u4ee3\u8868\u5927\u4f1a|\u56fd\u52a1\u9662/;

function documentText(document) {
  return [document.title, document.summary, ...(document.sections || []).map((section) => section.text)].filter(Boolean).join('\n');
}

function dateFromParts(year, month, day) {
  return new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T23:59:59.999Z`);
}

export function findExpiryDate(text = '') {
  const range = text.match(/\u81ea\s*\d{4}\u5e74\d{1,2}\u6708\d{1,2}\u65e5[\s\S]{0,80}?(?:\u81f3|\u5230)\s*(\d{4})\u5e74(\d{1,2})\u6708(\d{1,2})\u65e5\s*(?:\u6b62|\u622a\u6b62|\u6709\u6548)/);
  const deadline = text.match(/(?:\u622a\u81f3|\u6709\u6548\u671f\u81f3|\u6267\u884c\u81f3)\s*(\d{4})\u5e74(\d{1,2})\u6708(\d{1,2})\u65e5/);
  const match = range || deadline;
  return match ? dateFromParts(match[1], match[2], match[3]) : null;
}

// 已发布文件的状态调整使用更严格的规则：必须是文件自身明确写明
// “本公告/通知/办法……执行（施行、有效）至某日”。普通办理截止日、
// 统计时点或正文中引用其他文件的日期均不作为本文件失效依据。
export function findExplicitPolicyExpiry(text = '') {
  const match = text.match(/本(?:公告|通知|办法|规定|政策|决定)[^。；\n]{0,120}?(?:执行|施行|有效)[^。；\n]{0,36}?(?:至|截止)\s*(20\d{2})年(\d{1,2})月(\d{1,2})日/);
  return match ? dateFromParts(match[1], match[2], match[3]) : null;
}

export function automaticReviewDecision(document, now = new Date()) {
  const text = documentText(document);
  const expiryDate = findExpiryDate(text);
  const hasExpiredTerm = expiryDate && expiryDate < now;
  if (document.status === 'repealed' || EXPLICIT_REPEALED.test(text)) return { decision: 'hold', reason: '\u5df2\u5e9f\u6b62\u6216\u542b\u5e9f\u6b62\u6807\u8bb0', expiryDate: null, evidence: 'status/repeal-marker' };
  if (document.status === 'revised' || EXPLICIT_REVISED.test(text)) return { decision: 'hold', reason: '\u5df2\u4fee\u8ba2\u6216\u542b\u4fee\u8ba2\u6807\u8bb0', expiryDate: null, evidence: 'status/revision-marker' };
  if (hasExpiredTerm) return { decision: 'hold', reason: `\u6b63\u6587\u8f7d\u660e\u622a\u6b62\u65e5\u671f ${expiryDate.toISOString().slice(0, 10)}\uff0c\u9700\u4eba\u5de5\u786e\u8ba4\u540e\u7eed\u653f\u7b56`, expiryDate: expiryDate.toISOString().slice(0, 10), evidence: 'expired-term' };
  if (document.status === 'current' && EXPLICIT_CURRENT.test(text)) return { decision: 'publish', reason: '\u5b98\u65b9\u539f\u6587\u660e\u793a\u73b0\u884c\u6709\u6548', expiryDate: expiryDate ? expiryDate.toISOString().slice(0, 10) : null, evidence: 'explicit-current-marker' };
  if (document.status === 'current' && document.sourceId === 'source-npc') return { decision: 'publish', reason: '\u56fd\u5bb6\u6cd5\u5f8b\u6cd5\u89c4\u6570\u636e\u5e93\u5b98\u65b9\u6709\u6548\u6027\u4ee3\u7801\u6807\u6ce8\u4e3a\u73b0\u884c\u6709\u6548', expiryDate: expiryDate ? expiryDate.toISOString().slice(0, 10) : null, evidence: 'npc-official-current-code' };
  return { decision: 'hold', reason: '\u7f3a\u5c11\u5b98\u65b9\u201c\u73b0\u884c\u6709\u6548/\u5168\u6587\u6709\u6548\u201d\u660e\u786e\u4f9d\u636e', expiryDate: expiryDate ? expiryDate.toISOString().slice(0, 10) : null, evidence: 'insufficient-evidence' };
}

export function automaticReviewSummary(candidates, now = new Date()) {
  const decisions = candidates.filter((candidate) => candidate.state === 'pending').map((candidate) => ({ candidateId: candidate.id, title: candidate.document.title, ...automaticReviewDecision(candidate.document, now) }));
  return { examined: decisions.length, publishable: decisions.filter((item) => item.decision === 'publish').length, held: decisions.filter((item) => item.decision === 'hold').length, decisions };
}

/**
 * The first release only contains national tax policy.  This guard removes
 * false-positive catalogue hits (for example local consumer rules that happen
 * to mention receipts) before they can enter the member-facing corpus.
 */
export function candidateScopeReviewSummary(candidates) {
  const decisions = candidates.filter((candidate) => candidate.state === 'pending').map((candidate) => {
    const document = candidate.document;
    if (!TAX_POLICY_TITLE.test(document.title || '')) {
      return { candidateId: candidate.id, title: document.title, decision: 'reject', reason: '标题未体现税收、发票、关税或海关事项', evidence: 'outside-tax-scope' };
    }
    if (document.sourceId === 'source-npc' && !CENTRAL_NPC_AUTHORITY.test(document.authority || '')) {
      return { candidateId: candidate.id, title: document.title, decision: 'reject', reason: '全国人大来源仅保留全国人大及国务院发布的中央法规', evidence: 'outside-central-scope' };
    }
    return { candidateId: candidate.id, title: document.title, decision: 'keep', reason: '属于中央税收法规候选范围', evidence: 'tax-scope-match' };
  });
  return { examined: decisions.length, rejectable: decisions.filter((item) => item.decision === 'reject').length, retained: decisions.filter((item) => item.decision === 'keep').length, decisions };
}

function relationHint(document, allDocuments) {
  const text = documentText(document);
  for (const target of allDocuments) {
    if (target.id === document.id || target.title.length < 8 || (document.publishedAt && target.publishedAt && target.publishedAt > document.publishedAt)) continue;
    const mention = `\u300a${target.title}\u300b`;
    let start = text.indexOf(mention);
    while (start >= 0) {
      const sentenceStart = Math.max(text.lastIndexOf('\u3002', start), text.lastIndexOf('\uff1b', start), text.lastIndexOf('\n', start)) + 1;
      const sentenceEnds = [text.indexOf('\u3002', start), text.indexOf('\uff1b', start), text.indexOf('\n', start)].filter((index) => index >= 0);
      const sentenceEnd = sentenceEnds.length ? Math.min(...sentenceEnds) : text.length;
      const context = text.slice(sentenceStart, sentenceEnd);
      const mentionStart = start - sentenceStart;
      const mentionEnd = mentionStart + mention.length;
      let type = '';
      for (const marker of context.matchAll(/\u5e9f\u6b62|\u4fee\u8ba2|\u4fee\u6539/g)) {
        const distance = marker.index < mentionStart ? mentionStart - (marker.index + marker[0].length) : marker.index - mentionEnd;
        if (distance > 16) continue;
        type = marker[0] === '\u5e9f\u6b62' ? 'repeals' : 'revises';
        break;
      }
      if (type) return { type, title: target.title, officialUrl: target.officialUrl };
      start = text.indexOf(mention, start + mention.length);
    }
  }
  return null;
}

/**
 * The second pass makes historical records searchable without treating them as
 * current law.  Ambiguous records are annotated with expiry/relation signals
 * but remain pending for a human reviewer.
 */
export function secondaryReviewSummary(candidates, documents = [], now = new Date()) {
  const catalog = [...documents, ...candidates.map((candidate) => candidate.document)];
  const decisions = candidates.filter((candidate) => candidate.state === 'pending').map((candidate) => {
    const document = candidate.document;
    const hint = relationHint(document, catalog);
    if (document.status === 'repealed') return { candidateId: candidate.id, title: document.title, decision: 'archive', reason: '\u5b98\u65b9\u539f\u6587\u6807\u6ce8\u5df2\u5e9f\u6b62\uff0c\u5f52\u5165\u5386\u53f2\u5e93', evidence: 'status/repeal-marker', relationHint: hint };
    if (document.status === 'revised') return { candidateId: candidate.id, title: document.title, decision: 'archive', reason: '\u5b98\u65b9\u539f\u6587\u6807\u6ce8\u5df2\u4fee\u8ba2\uff0c\u5f52\u5165\u5386\u53f2\u5e93', evidence: 'status/revision-marker', relationHint: hint };
    const firstPass = automaticReviewDecision(document, now);
    return { candidateId: candidate.id, title: document.title, decision: 'hold', reason: firstPass.reason, evidence: firstPass.evidence, expiryDate: firstPass.expiryDate, relationHint: hint };
  });
  return {
    examined: decisions.length,
    archivable: decisions.filter((item) => item.decision === 'archive').length,
    held: decisions.filter((item) => item.decision === 'hold').length,
    relationHints: decisions.filter((item) => item.relationHint).length,
    decisions
  };
}

export function thirdReviewSummary(candidates, documents = []) {
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  const documentsByUrl = new Map(documents.map((document) => [document.officialUrl, document]));
  const catalog = [...documents, ...candidates.map((candidate) => candidate.document)];
  const expiryCandidates = candidates.filter((candidate) => candidate.state === 'pending' && candidate.autoReview?.evidence === 'expired-term');
  const relationLinks = [];
  let queuedRelationHints = 0;
  for (const candidate of candidates) {
    const hint = relationHint(candidate.document, catalog);
    if (!hint) continue;
    const source = documentsById.get(candidate.publishedDocumentId);
    const target = documentsByUrl.get(hint.officialUrl);
    if (source && target && source.id !== target.id) relationLinks.push({ sourceId: source.id, targetId: target.id, type: hint.type, sourceTitle: source.title, targetTitle: target.title });
    else queuedRelationHints += 1;
  }
  return { examined: candidates.filter((candidate) => candidate.state === 'pending').length, expiryArchivable: expiryCandidates.length, relationLinks, queuedRelationHints };
}

/**
 * 对已发布、尚待核验的文件进行保守的期限复核。
 * 仅将文件自身明确载明且已经届满的期限写入“期限届满”状态。
 */
export function publishedDocumentReviewSummary(documents, now = new Date()) {
  const decisions = documents.filter((document) => document.publishedToMembersAt && document.status === 'pending_verification').map((document) => {
    const expiryDate = findExplicitPolicyExpiry(documentText(document));
    if (expiryDate && expiryDate < now) {
      return { documentId: document.id, title: document.title, decision: 'expire', expiryDate: expiryDate.toISOString().slice(0, 10), evidence: 'explicit-policy-expiry' };
    }
    return { documentId: document.id, title: document.title, decision: 'hold', evidence: 'insufficient-expiry-evidence' };
  });
  return {
    examined: decisions.length,
    expirable: decisions.filter((item) => item.decision === 'expire').length,
    held: decisions.filter((item) => item.decision === 'hold').length,
    decisions
  };
}

function sentenceAround(text, position) {
  const before = [text.lastIndexOf('。', position), text.lastIndexOf('；', position), text.lastIndexOf('\n', position)].reduce((largest, value) => Math.max(largest, value), -1) + 1;
  const afterCandidates = [text.indexOf('。', position), text.indexOf('；', position), text.indexOf('\n', position)].filter((value) => value >= 0);
  const after = afterCandidates.length ? Math.min(...afterCandidates) : text.length;
  return text.slice(before, after).trim();
}

function nearbyVersionMarker(sentence, mentionStart, mentionLength) {
  const markers = [...sentence.matchAll(/废止|停止执行|不再执行|修订|修改/g)];
  for (const marker of markers) {
    const markerStart = marker.index;
    const markerEnd = markerStart + marker[0].length;
    const mentionEnd = mentionStart + mentionLength;
    const distance = markerEnd <= mentionStart ? mentionStart - markerEnd : markerStart >= mentionEnd ? markerStart - mentionEnd : 0;
    if (distance > 16) continue;
    return /废止|停止执行|不再执行/.test(marker[0]) ? 'repeals' : 'revises';
  }
  return null;
}

/**
 * 从已发布官方原文中提取版本关系。需要同时满足：
 * 1) 后发文件以《完整文件标题》明确点名已入库文件；
 * 2) 同一句内、距标题 16 个字符内出现废止/修订/修改等关系词；
 * 3) 被提及文件的发布日期早于该后发文件。
 */
export function publishedDocumentVersionReviewSummary(documents) {
  const published = documents.filter((document) => document.publishedToMembersAt);
  const byTitle = new Map(published.filter((document) => (document.title || '').length >= 8).map((document) => [document.title.trim(), document]));
  const links = [];
  const dedupe = new Set();
  for (const source of published) {
    const text = documentText(source);
    for (const match of text.matchAll(/《([^》]{8,180})》/g)) {
      const target = byTitle.get(match[1].trim());
      if (!target || target.id === source.id) continue;
      if (!source.publishedAt || !target.publishedAt || String(source.publishedAt) <= String(target.publishedAt)) continue;
      const sentence = sentenceAround(text, match.index);
      const mentionStart = sentence.indexOf(match[0]);
      const type = nearbyVersionMarker(sentence, mentionStart, match[0].length);
      if (!type) continue;
      const key = `${source.id}:${target.id}:${type}`;
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      links.push({ sourceId: source.id, targetId: target.id, type, sourceTitle: source.title, targetTitle: target.title, evidence: sentence.slice(0, 280) });
    }
  }
  const statusUpdates = new Map();
  for (const link of links) {
    const target = published.find((document) => document.id === link.targetId);
    if (!target || target.status === 'expired') continue;
    const nextStatus = link.type === 'repeals' ? 'repealed' : 'revised';
    if (target.status === nextStatus || (target.status === 'repealed' && nextStatus === 'revised')) continue;
    const previous = statusUpdates.get(target.id);
    if (!previous || (link.type === 'repeals' && previous.status !== 'repealed')) statusUpdates.set(target.id, { documentId: target.id, status: nextStatus, sourceId: link.sourceId, type: link.type });
  }
  return { examined: published.length, relationLinks: links, statusUpdates: [...statusUpdates.values()] };
}
