import { createHash } from 'node:crypto';
import { classifyTaxTypes } from './collector.js';

export const EVIDENCE_METADATA_RULE_VERSION = 'evidence-metadata-rules-v1';

// These are formal policy tax categories. Operational subjects such as 发票
// and 征收管理 are useful search topics, but are not taxes themselves.
const NON_TAX_CLASSIFICATIONS = new Set(['发票', '征收管理', '其他税收法规']);

const KEYWORD_RULES = Object.freeze([
  { term: '限售股', weight: 100 },
  { term: '财产转让所得', weight: 96 },
  { term: '成本原值', weight: 92 },
  { term: '清算申报', weight: 92 },
  { term: '预扣预缴', weight: 90 },
  { term: '证券登记结算公司', weight: 88 },
  { term: '证券机构', weight: 84 },
  { term: '非应税交易', weight: 100 },
  { term: '进项税额', weight: 96 },
  { term: '增值税扣税凭证', weight: 94 },
  { term: '农产品销售发票', weight: 92 },
  { term: '资产重组', weight: 90 },
  { term: '放弃增值税优惠', weight: 88 },
  { term: '一般纳税人', weight: 82 },
  { term: '小规模纳税人', weight: 82 },
  { term: '出口退税', weight: 90 },
  { term: '税前扣除', weight: 90 },
  { term: '汇算清缴', weight: 88 },
  { term: '专项附加扣除', weight: 88 },
  { term: '纳税申报', weight: 84 },
  { term: '税务机关', weight: 64 }
]);

const GENERIC_TERMS = new Set(['公告', '规定', '有关', '事项', '通知', '办法', '政策', '文件', '内容']);

const sha256 = (value) => createHash('sha256').update(String(value || '')).digest('hex');

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function firstOccurrence(title, body, term) {
  const inTitle = title.indexOf(term);
  if (inTitle >= 0) return { term, source: 'title', start: inTitle, end: inTitle + term.length };
  const inBody = body.indexOf(term);
  return inBody >= 0 ? { term, source: 'body', start: inBody, end: inBody + term.length } : null;
}

function formalTaxCategories(title, body) {
  const corpus = `${title}\n${body}`;
  const values = classifyTaxTypes(corpus).filter((value) => !NON_TAX_CLASSIFICATIONS.has(value));
  return [...new Set(values)].map((term) => ({ term, evidence: firstOccurrence(title, body, term) })).filter((item) => item.evidence);
}

function keywordSuggestions(title, body, taxCategories) {
  const candidates = [];
  for (const tax of taxCategories) candidates.push({ term: tax.term, weight: 110, evidence: tax.evidence });
  for (const rule of KEYWORD_RULES) {
    if (GENERIC_TERMS.has(rule.term)) continue;
    const evidence = firstOccurrence(title, body, rule.term);
    if (evidence) candidates.push({ term: rule.term, weight: rule.weight + (evidence.source === 'title' ? 12 : 0), evidence });
  }
  return [...new Map(candidates
    .sort((left, right) => right.weight - left.weight || left.term.localeCompare(right.term, 'zh-CN'))
    .map((item) => [item.term, item]))
    .values()]
    .slice(0, 8);
}

function policySentences(body) {
  const result = [];
  let start = 0;
  for (const match of body.matchAll(/[。！？]/g)) {
    const end = match.index + match[0].length;
    const text = cleanText(body.slice(start, end));
    if (text.length >= 12) result.push({ text, start, end });
    start = end;
  }
  const tail = cleanText(body.slice(start));
  if (tail.length >= 12) result.push({ text: tail, start, end: body.length });
  return result;
}

function extractiveSummary(body, keywords) {
  const sentences = policySentences(body);
  const ranked = sentences.map((sentence, index) => {
    const score = keywords.reduce((total, keyword) => total + (sentence.text.includes(keyword.term) ? 10 : 0), 0)
      + (/^(?:一、|二、|三、|第一条|第二条)/.test(sentence.text) ? 2 : 0)
      + (index === 0 ? 3 : 0);
    return { ...sentence, index, score };
  }).filter((sentence) => sentence.score > 0 || sentence.index === 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const selected = [];
  let length = 0;
  for (const sentence of ranked) {
    if (selected.some((item) => item.index === sentence.index)) continue;
    if (length && length + sentence.text.length > 150) continue;
    selected.push(sentence);
    length += sentence.text.length;
    if (length >= 60 || selected.length >= 2) break;
  }
  const ordered = selected.sort((left, right) => left.start - right.start);
  return {
    value: ordered.map((sentence) => sentence.text).join(''),
    evidence: ordered.map(({ text, start, end, index }) => ({ paragraph_or_sentence_index: index, start, end, text }))
  };
}

/**
 * Deterministic, extractive-only metadata suggestions. The result contains no
 * legal-status inference and every value is tied to a direct title/body match.
 */
export function suggestEvidenceMetadata({ title = '', normalized_text = '', generated_at = new Date().toISOString() } = {}) {
  const cleanTitle = cleanText(title);
  const body = String(normalized_text || '').trim();
  if (!cleanTitle) throw new Error('metadata suggestion 需要政策标题。');
  if (!body) throw new Error('metadata suggestion 需要已解析的政策正文。');
  const taxMatches = formalTaxCategories(cleanTitle, body);
  const keywords = keywordSuggestions(cleanTitle, body, taxMatches);
  const summary = extractiveSummary(body, keywords);
  return Object.freeze({
    rule_version: EVIDENCE_METADATA_RULE_VERSION,
    input_body_sha256: sha256(body),
    generated_at,
    tax_categories: {
      values: taxMatches.map((item) => item.term),
      matches: taxMatches.map((item) => item.evidence)
    },
    keywords: {
      values: keywords.map((item) => item.term),
      matches: keywords.map((item) => item.evidence)
    },
    summary
  });
}
