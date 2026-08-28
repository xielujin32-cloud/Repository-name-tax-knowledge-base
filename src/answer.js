/**
 * 只允许向适配器传入已经发布且已检索到的证据。生产环境可在此处替换为
 * 企业批准的云端模型，但不得让模型自行检索互联网或跳过引用校验。
 */
const FILLER_PHRASES = ['请问', '是什么', '有哪些', '多少', '如何', '怎么', '是否', '可以', '一个', '什么', '有关', '相关', '政策', '规定', '税收', '税法', '优惠', '依据', '条款', '问题', '的', '吗', '呢', '？', '?'];
const BROAD_TERMS = new Set(['税收', '税法', '政策', '规定', '优惠', '有关', '相关', '依据', '条款']);

function normalize(value = '') {
  return String(value).toLowerCase().replace(/\s+/g, '');
}

function evidenceAnchors(question) {
  let compact = normalize(question);
  for (const phrase of FILLER_PHRASES) compact = compact.replaceAll(phrase, '');
  if (compact.length < 2) return [];
  const terms = new Set();
  if (compact.length >= 3) terms.add(compact);
  for (let index = 0; index < compact.length - 1; index += 1) terms.add(compact.slice(index, index + 2));
  return [...terms].filter((term) => !BROAD_TERMS.has(term));
}

function matchedAnchors(anchors, { document, section }) {
  const text = normalize(`${document.title}\n${document.documentNumber}\n${section.label}\n${section.text}`);
  return anchors.filter((anchor) => text.includes(anchor));
}

function sectionAnchorCount(anchors, { section }) {
  const text = normalize(`${section.label}\n${section.text}`);
  return anchors.filter((anchor) => text.includes(anchor)).length;
}

function supportedBySpecificEvidence(question, evidence) {
  const anchors = evidenceAnchors(question);
  if (!anchors.length) return false;
  const matched = new Set();
  for (const { document, section } of evidence) {
    for (const anchor of matchedAnchors(anchors, { document, section })) matched.add(anchor);
  }
  // 单个二字泛匹配（例如“税收”或“扣除”）不足以支持问答；至少需要
  // 两个独立的业务锚点，或完整的三字以上业务短语。
  return matched.size >= 2 || anchors.some((anchor) => anchor.length >= 3 && matched.has(anchor));
}

export async function answerFromEvidence({ question, results }) {
  const evidence = results.flatMap((result) => result.matchingSections.map((section) => ({
    document: result.document,
    section
  })));
  if (!question.trim() || evidence.length === 0 || !supportedBySpecificEvidence(question, evidence)) {
    return {
      answered: false,
      reason: '当前已发布的官方资料中没有找到足以支持该问题的条款。请调整关键词，或联系管理员补充并审核权威文件。',
      answer: null,
      citations: []
    };
  }
  const anchors = evidenceAnchors(question);
  const citations = [...evidence].sort((left, right) => sectionAnchorCount(anchors, right) - sectionAnchorCount(anchors, left)).slice(0, 4).map(({ document, section }) => ({
    documentId: document.id,
    title: document.title,
    documentNumber: document.documentNumber,
    status: document.status,
    officialUrl: document.officialUrl,
    sectionId: section.id,
    sectionLabel: section.label,
    excerpt: section.text
  }));
  return {
    answered: true,
    answer: `已在已发布的官方原文中找到与“${question.trim()}”相关的依据。以下内容仅作检索摘要，请以所列原文及其现行有效状态为准。`,
    reason: null,
    citations
  };
}
