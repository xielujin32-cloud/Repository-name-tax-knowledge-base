import { createHash } from 'node:crypto';

export const CANDIDATE_RELATION_RULE_VERSION = 'candidate-relation-rules-v2';

const RELATION_RULES = Object.freeze([
  { type: 'repeals', expression: /废止|停止执行/g },
  { type: 'amends', expression: /修订|修改/g },
  { type: 'supersedes', expression: /替代|取代/g },
  { type: 'extends', expression: /延续执行|继续执行|延期/g },
  { type: 'interprets', expression: /解释|解读/g }
]);

const DOCUMENT_NO = /(?:国家税务总局|财政部|税务总局|中国证监会|海关总署|国务院)(?:[、，,\s]+(?:国家税务总局|财政部|税务总局|中国证监会|海关总署|国务院))*\s*(?:公告|令|通知|决定)\s*(?:〔\d{4}〕\d+号|\d{4}年第\d+号|第\d+号)/;
const TITLE_REFERENCE = /《([^》]{4,160})》/;

const sha256 = (value) => createHash('sha256').update(String(value || '')).digest('hex');

function sentences(body) {
  const items = [];
  let start = 0;
  for (const match of String(body || '').matchAll(/[。！？\n]/g)) {
    const end = match.index + match[0].length;
    const value = String(body).slice(start, end).trim();
    if (value) items.push({ text: value, start, end });
    start = end;
  }
  const tail = String(body || '').slice(start).trim();
  if (tail) items.push({ text: tail, start, end: String(body || '').length });
  return items;
}

function targetReference(sentence) {
  // When a sentence lists several instruments, an action at its end applies
  // most directly to the nearest preceding title/number. Keeping the last
  // explicit reference is safer than pairing it with the first list item.
  const documentNo = [...sentence.text.matchAll(new RegExp(DOCUMENT_NO.source, 'g'))].at(-1)?.[0] || null;
  const title = [...sentence.text.matchAll(new RegExp(TITLE_REFERENCE.source, 'g'))].at(-1)?.[1] || null;
  if (!documentNo && !title) return null;
  return { document_no: documentNo, title, text: documentNo || title };
}

function escapeExpression(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function targetText(target) {
  return target.title ? `《${target.title}》` : target.document_no || '';
}

function isActionForTarget(sentence, target, hit, relationType) {
  const reference = targetText(target);
  const targetStart = sentence.text.indexOf(reference);
  if (targetStart < 0) return false;
  const targetEnd = targetStart + reference.length;
  const hitStart = hit.index;
  const distance = Math.abs(hitStart - targetStart);
  // The legacy matcher chose the first cited title. If another title follows
  // the action word, this first title is not a safe relation target.
  if (targetStart < hitStart && /《[^》]{4,160}》/.test(sentence.text.slice(hitStart + hit[0].length))) return false;
  if (relationType === 'interprets') {
    const escaped = escapeExpression(reference);
    return new RegExp(`(?:是对|对)\\s*${escaped}[^。；]{0,100}(?:的)?(?:解释|解读)`).test(sentence.text);
  }
  return distance <= 180;
}

function implementationHitForTarget(sentence, target) {
  const reference = targetText(target);
  const targetStart = sentence.text.indexOf(reference);
  if (targetStart < 0) return null;
  const before = sentence.text.slice(Math.max(0, targetStart - 120), targetStart);
  // An implementation proposal is safe only when “为贯彻执行” is immediately
  // attached to the cited target. A wider window can bind the verb to a prior
  // citation in the same sentence, which is not an auditable relation.
  if (/(?:为贯彻|贯彻|为)\s*执行\s*$/.test(before)) {
    const index = sentence.text.lastIndexOf('执行', targetStart);
    return { index, text: '执行' };
  }
  const after = sentence.text.slice(targetStart + reference.length, targetStart + reference.length + 240);
  if (/(?:按|按照|依照)\s*$/.test(before) && /(?:规定)?执行/.test(after)) {
    const match = after.match(/(?:规定)?执行/);
    return { index: targetStart + reference.length + match.index + match[0].lastIndexOf('执行'), text: '执行' };
  }
  return null;
}

/**
 * Finds only explicit, citable relation clues. It deliberately does not
 * decide a legal relationship and returns no proposal when a relation word
 * lacks a nearby identified target instrument.
 */
export function proposeCandidateRelations({ normalized_text = '', rule_version = CANDIDATE_RELATION_RULE_VERSION } = {}) {
  const body = String(normalized_text || '');
  const inputBodyHash = sha256(body);
  const proposals = [];
  for (const sentence of sentences(body)) {
    const target = targetReference(sentence);
    if (!target) continue;
    for (const rule of RELATION_RULES) {
      rule.expression.lastIndex = 0;
      const hit = rule.expression.exec(sentence.text);
      if (!hit) continue;
      if (!isActionForTarget(sentence, target, hit, rule.type)) continue;
      const start = sentence.start + hit.index;
      proposals.push({
        relation_type: rule.type,
        rule_version,
        input_body_sha256: inputBodyHash,
        target_reference: target,
        confidence: 70,
        evidence: [{ start, end: start + hit[0].length, text: sentence.text, matched_term: hit[0] }]
      });
    }
    const implementation = implementationHitForTarget(sentence, target);
    if (implementation) {
      const start = sentence.start + implementation.index;
      proposals.push({
        relation_type: 'implements', rule_version, input_body_sha256: inputBodyHash, target_reference: target, confidence: 70,
        evidence: [{ start, end: start + implementation.text.length, text: sentence.text, matched_term: implementation.text }]
      });
    }
  }
  const unique = new Map();
  for (const proposal of proposals) {
    const key = `${proposal.relation_type}:${proposal.target_reference.document_no || ''}:${proposal.target_reference.title || ''}`;
    if (!unique.has(key)) unique.set(key, proposal);
  }
  return Object.freeze([...unique.values()]);
}
