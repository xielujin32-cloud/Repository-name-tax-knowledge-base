export const TAX_TOPICS = {
  vat: { label: '增值税', terms: ['增值税', '营改增', '一般纳税人', '小规模纳税人'] },
  eit: { label: '企业所得税', terms: ['企业所得税', '小型微利企业', '税前扣除'] },
  iit: { label: '个人所得税', terms: ['个人所得税', '综合所得', '居民个人'] },
  consumption: { label: '消费税', terms: ['消费税'] },
  customs: { label: '关税', terms: ['关税', '进口关税'] },
  resource: { label: '资源税', terms: ['资源税'] },
  environment: { label: '环境保护税', terms: ['环境保护税'] },
  property: { label: '房产税', terms: ['房产税'] },
  urban_land: { label: '城镇土地使用税', terms: ['城镇土地使用税', '城市土地使用税'] },
  land_appreciation: { label: '土地增值税', terms: ['土地增值税'] },
  deed: { label: '契税', terms: ['契税'] },
  stamp: { label: '印花税', terms: ['印花税'] },
  vehicle_purchase: { label: '车辆购置税', terms: ['车辆购置税'] },
  vehicle_vessel: { label: '车船税', terms: ['车船税', '车船使用税'] },
  collection: { label: '征收管理', terms: ['税收征收管理', '税务登记', '纳税申报'] },
  invoice: { label: '发票', terms: ['发票', '增值税专用发票'] }
};

function policyBody(document) {
  const raw = (document.sections || []).map((section) => section.text).join('\n');
  const annotation = raw.indexOf('注释');
  const start = annotation >= 0 ? raw.slice(annotation + 2) : raw;
  const print = start.indexOf('【打印】');
  return (print >= 0 ? start.slice(0, print) : start).replace(/\s+/g, ' ');
}

function occurrences(text, term) {
  let count = 0;
  let index = text.indexOf(term);
  while (index >= 0) { count += 1; index = text.indexOf(term, index + term.length); }
  return count;
}

export function topicScore(document, topic) {
  const definition = TAX_TOPICS[topic];
  if (!definition) return 0;
  const title = document.title || '';
  const body = policyBody(document);
  let score = 0;
  for (const term of definition.terms) {
    if (title.includes(term)) score += 100;
    score += Math.min(occurrences(body, term), 8) * 8;
  }
  return score;
}

export function inferTaxTopics(document) {
  return Object.entries(TAX_TOPICS).filter(([topic]) => topicScore(document, topic) >= 16).map(([, definition]) => definition.label);
}

export function documentsForTopic(documents, topic) {
  const current = [];
  const history = [];
  for (const document of documents) {
    const score = topicScore(document, topic);
    if (!score) continue;
    const matchingSections = (document.sections || []).filter((section) => TAX_TOPICS[topic].terms.some((term) => section.text.includes(term))).slice(0, 4);
    const item = { document, score, matchingSections };
    if (document.status === 'current') current.push(item);
    else history.push(item);
  }
  const order = (left, right) => (right.score - left.score) || String(right.document.publishedAt || '').localeCompare(String(left.document.publishedAt || '')) || left.document.title.localeCompare(right.document.title, 'zh-CN');
  current.sort(order);
  history.sort(order);
  return { current, history };
}
