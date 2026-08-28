const STATUS_ORDER = { current: 0, revised: 1, repealed: 2, expired: 3, pending_verification: 4 };

function normalize(value = '') {
  return value.toLowerCase().replace(/\s+/g, '');
}

function queryTerms(query) {
  const cleaned = normalize(query);
  const chunks = cleaned.split(/[，。！？、；：,.!?;:()（）\[\]{}]+/).filter(Boolean);
  return [...new Set(chunks.flatMap((chunk) => {
    if (chunk.length <= 3) return [chunk];
    return [chunk, ...Array.from({ length: chunk.length - 1 }, (_, index) => chunk.slice(index, index + 2))];
  }))].filter((term) => term.length > 1);
}

export function searchDocuments(documents, { query = '', status = '', taxType = '', publishedYear = '' } = {}) {
  const terms = queryTerms(query);
  const filtered = documents.filter((document) => {
    if (status && document.status !== status) return false;
    if (publishedYear && !String(document.publishedAt || '').startsWith(`${publishedYear}-`)) return false;
    return !taxType || document.taxTypes.includes(taxType);
  });
  return filtered.map((document) => {
    const title = normalize(`${document.title}${document.documentNumber}`);
    const summary = normalize(document.summary);
    const matchingSections = document.sections.map((section) => {
      const text = normalize(section.text);
      const score = terms.reduce((total, term) => total + (text.includes(term) ? 3 : 0), 0);
      return { ...section, score };
    }).filter((section) => section.score > 0).sort((a, b) => b.score - a.score);
    const titleScore = terms.reduce((total, term) => total + (title.includes(term) ? 8 : summary.includes(term) ? 2 : 0), 0);
    return {
      document,
      score: titleScore + matchingSections.reduce((total, section) => total + section.score, 0),
      matchingSections: matchingSections.slice(0, 3)
    };
  }).filter((item) => !query || item.score > 0)
    .sort((a, b) => String(b.document.publishedAt || '').localeCompare(String(a.document.publishedAt || '')) || (STATUS_ORDER[a.document.status] - STATUS_ORDER[b.document.status]) || (b.score - a.score) || a.document.title.localeCompare(b.document.title, 'zh-CN'));
}

export function statusLabel(status) {
  return {
    current: '现行有效',
    revised: '已修订',
    repealed: '已废止',
    pending_verification: '待核验'
  }[status] || status;
}
