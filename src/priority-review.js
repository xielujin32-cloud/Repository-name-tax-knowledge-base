const PRIORITY_TAX_TYPES = [
  { id: 'vat', label: '增值税', taxType: '增值税' },
  { id: 'eit', label: '企业所得税', taxType: '企业所得税' },
  { id: 'iit', label: '个人所得税', taxType: '个人所得税' },
  { id: 'consumption', label: '消费税', taxType: '消费税' },
  { id: 'collection', label: '征收管理', taxType: '征收管理' }
];

function valueOfDate(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function priorityFor(document, hasCurrentTwin) {
  let value = document.sourceId === 'source-chinatax' ? 40 : document.sourceId === 'source-mof' ? 30 : 20;
  if (/(?:法|条例|实施细则|办法)/.test(document.title)) value += 25;
  if (valueOfDate(document.publishedAt) >= Date.UTC(2023, 0, 1)) value += 15;
  // 同名的现行文本不能直接替代该文件，但通常说明管理员可先核对版本关系，
  // 因此排在需要独立判断的文件之后。
  if (hasCurrentTwin) value -= 20;
  return value;
}

/**
 * 将已发布但尚待核验的文件按高频税种整理为人工审核队列。
 * 该函数只提供优先级和提示，不会自行改变文件的有效状态。
 */
export function priorityReviewQueue(documents, { limit = 20 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 500);
  const currentTitles = new Set(documents.filter((document) => document.status === 'current').map((document) => document.title.trim()));
  const pending = documents.filter((document) => document.publishedToMembersAt && document.status === 'pending_verification');
  const groups = PRIORITY_TAX_TYPES.map((topic) => {
    const entries = pending.filter((document) => document.taxTypes.includes(topic.taxType)).map((document) => {
      const hasCurrentTwin = currentTitles.has(document.title.trim());
      const priority = priorityFor(document, hasCurrentTwin);
      return {
        document,
        priority,
        hasCurrentTwin,
        reviewHint: hasCurrentTwin ? '已存在同名现行文件，请先核对是否为同一版本或后续版本。' : '未找到同名现行文件，请以官方原文、修订决定或废止目录核验。'
      };
    }).sort((left, right) => (right.priority - left.priority) || (valueOfDate(right.document.publishedAt) - valueOfDate(left.document.publishedAt)) || left.document.title.localeCompare(right.document.title, 'zh-CN'));
    return { id: topic.id, label: topic.label, total: entries.length, items: entries.slice(0, safeLimit) };
  });
  return { total: groups.reduce((total, group) => total + group.total, 0), groups };
}
