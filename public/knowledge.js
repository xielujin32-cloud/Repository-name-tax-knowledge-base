const $ = (selector) => document.querySelector(selector);
const state = { taxType: '', query: '', cards: [] };

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

$('#search-form').addEventListener('submit', (event) => { event.preventDefault(); state.query = $('#search-input').value.trim(); loadCards(); });
$('#clear-filter').addEventListener('click', () => { state.taxType = ''; $('#clear-filter').hidden = true; loadCards(); });
$('#card-dialog').addEventListener('click', (event) => { if (event.target === $('#card-dialog')) $('#card-dialog').close(); });

let installPrompt;
window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); installPrompt = event; $('#install-app').hidden = false; });
$('#install-app').addEventListener('click', async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('#install-app').hidden = true; });
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));

Promise.all([api('/api/knowledge/tax-types'), loadCards()]).then(([types]) => renderTaxTypes(types.taxTypes)).catch((error) => { $('#tax-types').innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`; });
