const $ = (selector) => document.querySelector(selector);
const state = { taxType: '', query: '', cards: [], policies: [] };

function escapeHtml(value = '') { const node = document.createElement('span'); node.textContent = value; return node.innerHTML; }
function formatDate(value) { return value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(value)) : '待核验'; }
async function api(path) { const response = await fetch(path, { headers: { accept: 'application/json' } }); const body = await response.json(); if (!response.ok) throw new Error(body.error || '加载失败'); return body; }

function renderTaxTypes(taxTypes) {
  const root = $('#tax-types');
  root.innerHTML = taxTypes.map((item) => `<button type="button" data-tax-type="${escapeHtml(item.label)}" class="${state.taxType === item.label ? 'active' : ''}">${escapeHtml(item.label)}<small>${item.count}</small></button>`).join('');
  root.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => { state.taxType = button.dataset.taxType === state.taxType ? '' : button.dataset.taxType; $('#clear-filter').hidden = !state.taxType; loadCards(); renderTaxTypes(taxTypes); }));
}
function renderCards(results) {
  const root = $('#card-list'); state.cards = results.map((item) => item.card);
  $('#results-heading').textContent = state.query ? `“${state.query}”的查询结果` : state.taxType ? `${state.taxType}知识卡片` : '常用知识卡片';
  $('#result-note').textContent = state.query || state.taxType ? '优先展示最匹配的已审核内容。' : '以下内容适用于全国通用基础规则。';
  if (!results.length) { root.innerHTML = '<p class="empty">没有找到匹配的知识卡片。试试“个人所得税”“工资”或“经营所得”。</p>'; return; }
  root.innerHTML = results.map(({ card }) => `<button class="knowledge-card" type="button" data-card-id="${escapeHtml(card.id)}"><span class="card-tax">${escapeHtml(card.taxType)}</span><h3>${escapeHtml(card.topic)}</h3><p class="formula-preview">${escapeHtml(card.formula)}</p><span class="card-foot"><span>核验：${formatDate(card.verifiedAt)}</span><b>查看详情 →</b></span></button>`).join('');
  root.querySelectorAll('[data-card-id]').forEach((button) => button.addEventListener('click', () => openCard(button.dataset.cardId)));
}
async function loadCards() {
  const params = new URLSearchParams(); if (state.query) params.set('query', state.query); if (state.taxType) params.set('taxType', state.taxType);
  $('#card-list').innerHTML = '<p class="empty">正在加载已审核知识卡片…</p>';
  try { renderCards((await api(`/api/knowledge/cards?${params}`)).results); } catch (error) { $('#card-list').innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; }
}
function openCard(id) {
  const card = state.cards.find((item) => item.id === id); if (!card) return;
  $('#card-detail').innerHTML = `<header class="detail-head"><p>${escapeHtml(card.taxType)} · 已审核发布</p><h2 id="detail-title">${escapeHtml(card.topic)}</h2><button class="close-detail" aria-label="关闭">×</button></header><div class="detail-body"><span class="scope">${escapeHtml(card.regionScope)}</span><h3>计算公式</h3><p class="formula">${escapeHtml(card.formula)}</p><h3>税率／级距</h3><div class="rate-scroll"><table><thead><tr><th>级距或适用情形</th><th>税率／征收率</th><th>速算扣除数／说明</th></tr></thead><tbody>${card.rateTable.map((row) => `<tr><td>${escapeHtml(row.bracket)}</td><td>${escapeHtml(row.rate)}</td><td>${escapeHtml(row.quickDeduction)}</td></tr>`).join('')}</tbody></table></div><h3>适用条件</h3><ul>${card.conditions.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul><h3>简短示例</h3><p>${escapeHtml(card.example)}</p><h3>官方依据</h3><div class="basis-list">${card.officialBases.map((basis) => `<a href="${escapeHtml(basis.url)}" target="_blank" rel="noreferrer">${escapeHtml(basis.title)} ↗<small>${escapeHtml(basis.authority)}</small></a>`).join('')}</div><p class="detail-note">生效日期：${escapeHtml(card.effectiveAt)} · 最后核验：${formatDate(card.verifiedAt)}。正式申报以主管税务机关和电子税务局口径为准。</p></div>`;
  const dialog = $('#card-dialog'); dialog.showModal(); $('.close-detail').addEventListener('click', () => dialog.close());
}

const policyStatusLabel = (status) => ({ effective: '现行有效', partially_effective: '部分有效', repealed: '已废止', expired: '已失效', pending: '待核验' }[status] || '待核验');
const policyStatusClass = (status) => ['effective', 'partially_effective'].includes(status) ? 'status-current' : `status-${escapeHtml(status || 'pending')}`;

function policyParams() {
  const params = new URLSearchParams();
  const add = (key, selector) => { const value = $(selector).value.trim(); if (value) params.set(key, value); };
  add('query', '#policy-query'); add('documentNo', '#policy-document-no'); add('taxCategory', '#policy-tax-category'); add('status', '#policy-status');
  add('authority', '#policy-authority'); add('source', '#policy-source'); add('region', '#policy-region');
  add('publishedFrom', '#policy-published-from'); add('publishedTo', '#policy-published-to'); add('effectiveFrom', '#policy-effective-from'); add('effectiveTo', '#policy-effective-to');
  params.set('limit', '30');
  return params;
}

function renderPolicies(payload) {
  const root = $('#policy-list'); const results = payload.results || [];
  state.policies = results;
  const explicitStatus = $('#policy-status').value;
  $('#policy-result-note').textContent = results.length
    ? `找到 ${payload.total} 条${explicitStatus ? '已核验政策' : '已核验现行政策'}；每条均可追溯至官方 Evidence。`
    : explicitStatus ? '没有符合筛选条件的已核验政策。待核验、关系未决或风险待审政策不会在这里显示。' : '当前没有符合条件的已核验现行政策；待核验和历史数据不会混入结果。';
  if (!results.length) { root.innerHTML = '<p class="empty">暂无可公开的已核验政策。请调整筛选条件，或稍后在审核完成后再查询。</p>'; return; }
  root.innerHTML = results.map((policy) => `<button class="policy-card" type="button" data-policy-id="${escapeHtml(policy.id)}"><div class="policy-card-head"><span class="policy-status ${policyStatusClass(policy.status)}">${escapeHtml(policyStatusLabel(policy.status))}</span><span>${escapeHtml(policy.publish_date || '发布日期待核验')}</span></div><h3>${escapeHtml(policy.title)}</h3><p class="policy-document-no">${escapeHtml(policy.document_no || '文号待核验')}</p><p class="policy-meta">${escapeHtml((policy.issuing_authority || []).join('、') || policy.source_name || '官方来源')} · ${escapeHtml((policy.tax_categories || []).join('、') || '税种待审核')}</p><p class="policy-summary">${escapeHtml(policy.summary || '已完成 Evidence 与审核链，查看详情获取官方原文与版本信息。')}</p><span class="policy-card-foot">官方 Evidence · Level 3 已审核 <b>查看依据 →</b></span></button>`).join('');
  root.querySelectorAll('[data-policy-id]').forEach((button) => button.addEventListener('click', () => openPolicy(button.dataset.policyId)));
}

async function loadPolicies() {
  $('#policy-list').innerHTML = '<p class="empty">正在加载已核验政策…</p>';
  try { renderPolicies(await api(`/api/policies?${policyParams()}`)); }
  catch (error) { $('#policy-list').innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; }
}

function renderRelations(relations) {
  if (!relations?.length) return '<p>未发现已确认的替代、修订或废止关系。</p>';
  return `<ul>${relations.map((item) => `<li>${escapeHtml(item.relation_type || '关联')}：${escapeHtml(item.title || item.document_no || item.policy_id || '已确认关联政策')}</li>`).join('')}</ul>`;
}

async function openPolicy(id) {
  try {
    const { policy } = await api(`/api/policies/${encodeURIComponent(id)}`);
    const dialog = $('#policy-dialog');
    $('#policy-detail').innerHTML = `<header class="detail-head"><p>${escapeHtml(policyStatusLabel(policy.status))} · Level 3 已审核 · ${escapeHtml(policy.source_name || '官方来源')}</p><h2 id="policy-detail-title">${escapeHtml(policy.title)}</h2><button class="close-detail" aria-label="关闭">×</button></header><div class="detail-body"><span class="scope">${escapeHtml(policy.document_no || '文号待核验')}</span><h3>效力与适用</h3><p>效力状态：<strong>${escapeHtml(policyStatusLabel(policy.status))}</strong><br>发布日期：${escapeHtml(policy.publish_date || '待核验')} · 施行日期：${escapeHtml(policy.effective_date || '待核验')} · 截止日期：${escapeHtml(policy.expiry_date || '未记录')}</p><h3>政策摘要</h3><p>${escapeHtml(policy.summary || '无公开摘要。请以官方原文为准。')}</p><h3>税种与关键词</h3><p>${escapeHtml([...(policy.tax_categories || []), ...(policy.keywords || [])].join(' · ') || '待审核')}</p><h3>官方依据</h3><div class="basis-list"><a href="${escapeHtml(policy.source_url)}" target="_blank" rel="noreferrer">查看官方原文 ↗<small>${escapeHtml(policy.source_name || '')} · ${escapeHtml((policy.issuing_authority || []).join('、'))}</small></a></div><h3>Evidence 与审核</h3><p>Evidence Candidate：${escapeHtml(policy.evidence?.candidate_id || '—')}<br>Policy Version：${escapeHtml(policy.evidence?.policy_version_id || policy.policy_version_id || '—')}<br>正文校验 Hash：${escapeHtml(policy.evidence?.body_hash || '—')}<br>审核：Level ${escapeHtml(String(policy.review?.reviewer_level || '—'))} · ${escapeHtml(policy.last_verified_date || '—')}</p><h3>版本 / 替代关系</h3>${renderRelations(policy.version_relations)}<p class="detail-note">本条仅在官方 Evidence 完整、来源可信且 Level 3 审核通过后公开。正式申报仍应以主管税务机关和电子税务局口径为准。</p></div>`;
    dialog.showModal(); $('.close-detail').addEventListener('click', () => dialog.close());
  } catch (error) { $('#policy-list').insertAdjacentHTML('afterbegin', `<p class="empty">${escapeHtml(error.message)}</p>`); }
}

$('#search-form').addEventListener('submit', (event) => { event.preventDefault(); state.query = $('#search-input').value.trim(); loadCards(); });
$('#clear-filter').addEventListener('click', () => { state.taxType = ''; $('#clear-filter').hidden = true; loadCards(); });
$('#card-dialog').addEventListener('click', (event) => { if (event.target === $('#card-dialog')) $('#card-dialog').close(); });
$('#policy-search-form').addEventListener('submit', (event) => { event.preventDefault(); loadPolicies(); });
$('#policy-dialog').addEventListener('click', (event) => { if (event.target === $('#policy-dialog')) $('#policy-dialog').close(); });

let installPrompt;
window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); installPrompt = event; $('#install-app').hidden = false; });
$('#install-app').addEventListener('click', async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('#install-app').hidden = true; });
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));

Promise.all([api('/api/knowledge/tax-types'), loadCards(), loadPolicies()]).then(([types]) => renderTaxTypes(types.taxTypes)).catch((error) => { $('#tax-types').innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; });
