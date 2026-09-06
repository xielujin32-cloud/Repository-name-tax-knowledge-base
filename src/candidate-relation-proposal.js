import { createHash } from 'node:crypto';

export const CANDIDATE_RELATION_RULE_VERSION = 'candidate-relation-rules-v1';

const RELATION_RULES = Object.freeze([
  { type: 'repeals', expression: /废止|停止执行/g },
  { type: 'amends', expression: /修订|修改/g },
  { type: 'supersedes', expression: /替代|取代/g },
  { type: 'extends', expression: /延续执行|继续执行|延期/g },
  { type: 'interprets', expression: /解释|解读/g },
  { type: 'implements', expression: /实施|执行/g }
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
  const documentNo = sentence.text.match(DOCUMENT_NO)?.[0] || null;
  const title = sentence.text.match(TITLE_REFERENCE)?.[1] || null;
  if (!documentNo && !title) return null;
  return { document_no: documentNo, title, text: documentNo || title };
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
  }
  const unique = new Map();
  for (const proposal of proposals) {
    const key = `${proposal.relation_type}:${proposal.target_reference.document_no || ''}:${proposal.target_reference.title || ''}`;
    if (!unique.has(key)) unique.set(key, proposal);
  }
  return Object.freeze([...unique.values()]);
}
