const state = { token: localStorage.getItem('taxkb-token'), user: null, sources: [], autoReview: null, secondaryReview: null, thirdReview: null, documentReview: null, documentVersionReview: null, browseTaxType: '', priorityExpanded: new Set() };
const $ = (selector) => document.querySelector(selector);
const statusNames = { current: '现行有效', revised: '已修订', repealed: '已废止', expired: '期限届满', pending_verification: '待核验' };

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(state.token ? { authorization: `Bearer ${state.token}` } : {}), ...options.headers } });
  const body = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(body.error || '请求失败');
  return body;
}
function escapeHtml(value = '') { const element = document.createElement('span'); element.textContent = value; return element.innerHTML; }
function compactPreview(value = '') { const marker = value.indexOf('注释'); const body = marker >= 0 ? value.slice(marker + 2) : value; const cleaned = body.replace(/国家税务总局政策法规库[\s\S]{0,500}?当前位置：[\s\S]{0,160}?>/g, '').replace(/\s+/g, ' ').trim(); return cleaned.length >= 24 ? cleaned.slice(0, 220) : ''; }
function setUserBar() { $('#user-bar').innerHTML = state.user ? `<span>${escapeHtml(state.user.displayName)} · ${state.user.role === 'admin' ? '管理员' : '成员'}</span><button id="logout">退出</button>` : ''; $('#logout')?.addEventListener('click', logout); }
function showApp() { $('#login-view').hidden = true; $('#app-view').hidden = false; $('.admin-only').hidden = state.user.role !== 'admin'; setUserBar(); switchView('workspace'); if (state.user.role === 'admin') loadAdmin(); }
async function restoreSession() { if (!state.token) return; try { state.user = (await api('/api/me')).user; showApp(); } catch { localStorage.removeItem('taxkb-token'); state.token = null; } }
async function logout() { try { await api('/api/auth/logout', { method: 'POST' }); } finally { state.token = null; state.user = null; localStorage.removeItem('taxkb-token'); $('#app-view').hidden = true; $('#login-view').hidden = false; setUserBar(); } }
function renderDocuments(results, { append = false } = {}) {
  const list = $('#document-list'); if (!append) list.innerHTML = '';
  if (!results.length) { list.innerHTML = '<p class="query-result empty">没有匹配文件。可以换用税种、文件名称或条款关键词。</p>'; return; }
  const template = $('#document-template');
  results.forEach(({ document, matchingSections }) => {
    const node = template.content.cloneNode(true); const status = node.querySelector('.status'); const showHistoricalStatus = ['repealed', 'expired'].includes(document.status); status.hidden = !showHistoricalStatus; if (showHistoricalStatus) { status.textContent = statusNames[document.status]; status.classList.add(document.status); }
    const link = node.querySelector('.title'); link.textContent = document.title; link.href = document.officialUrl; link.target = '_blank'; link.rel = 'noreferrer';
    node.querySelector('.meta').textContent = [document.publishedAt?.startsWith('2026-') ? '2026 年新发布' : '', `成文日期：${document.publishedAt || '待补充'}`, document.documentNumber, document.authority, document.effectiveAt ? `施行：${document.effectiveAt}` : '', document.taxTypes.join('、')].filter(Boolean).join(' · ');
    node.querySelector('.summary').hidden = true;
    const matches = node.querySelector('.matches');
    matches.innerHTML = '';
    matches.hidden = true;
    list.append(node);
  });
}
function renderDocumentDetail(document) {
  const detail = $('#document-detail');
  const relationNames = { repeals: '废止关联', revises: '修订关联', repealed_by: '被后续文件废止', revised_by: '被后续文件修订' };
  const statusMarkup = ['repealed', 'expired'].includes(document.status) ? `<span class="status ${escapeHtml(document.status)}">${escapeHtml(statusNames[document.status])}</span> ` : '';
  detail.innerHTML = `<div class="card-head"><h2>${escapeHtml(document.title)}</h2><button id="close-document-detail" class="secondary">关闭</button></div><p class="meta">${escapeHtml([document.documentNumber, document.authority, document.publishedAt ? `发布：${document.publishedAt}` : '', document.effectiveAt ? `施行：${document.effectiveAt}` : ''].filter(Boolean).join(' · '))}</p><p>${statusMarkup}<a href="${escapeHtml(document.officialUrl)}" target="_blank" rel="noreferrer">查看官方原文</a></p>${document.summary ? `<p>${escapeHtml(document.summary)}</p>` : ''}<h3>条款正文</h3><div class="matches">${document.sections.map((section) => `<strong>${escapeHtml(section.label)}</strong><p>${escapeHtml(section.text)}</p>`).join('<hr />')}</div>${document.relatedDocuments?.length ? `<h3>版本关系</h3><ul>${document.relatedDocuments.map((item) => `<li>${escapeHtml(relationNames[item.type] || item.type)}：<a href="#document-detail" data-related-document-id="${escapeHtml(item.id)}">${escapeHtml(item.title)}</a></li>`).join('')}</ul>` : ''}`;
  detail.hidden = false;
  $('#close-document-detail').onclick = () => { detail.hidden = true; };
  detail.querySelectorAll('[data-related-document-id]').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); openDocument(link.dataset.relatedDocumentId).catch(console.error); }));
  detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function openDocument(id) { renderDocumentDetail((await api(`/api/documents/${encodeURIComponent(id)}`)).document); }
function renderTaxonomy(data) {
  state.browseTaxType = '';
  const root = $('#query-result'); root.classList.remove('empty');
  const yearNote = $('#published-year-filter').value ? '（仅 2026 年新发布）' : '';
  root.innerHTML = `<strong>按税种浏览法规${yearNote}</strong><p>请选择一个税种查看相关文件。每类只在点击后加载，避免页面一次显示全部 ${data.total} 条法规。</p>`;
  const list = $('#document-list');
  list.innerHTML = `<div class="taxonomy-grid">${data.categories.map((category) => { const confirmedHistory = [`${category.repealed ? `已废止 ${category.repealed} 条` : ''}`, `${category.expired ? `期限届满 ${category.expired} 条` : ''}`].filter(Boolean).join(' · '); return `<button class="taxonomy-card" data-tax-category="${escapeHtml(category.label)}"><strong>${escapeHtml(category.label)}</strong><small>共 ${category.count} 条${confirmedHistory ? ` · ${confirmedHistory}` : ''}</small></button>`; }).join('')}</div>`;
  document.querySelectorAll('[data-tax-category]').forEach((button) => button.addEventListener('click', () => browseDocuments(button.dataset.taxCategory).catch(console.error)));
}
function renderBrowsePage(data, taxType, append = false) {
  if (!append) {
    const root = $('#query-result'); root.classList.remove('empty');
    root.innerHTML = `<div class="browse-heading"><div><strong>${escapeHtml(taxType)}法规</strong><p>共 ${data.total} 条；当前显示 ${data.offset + 1}–${data.offset + data.results.length} 条。点击标题可查看官方原文。</p></div><button id="back-to-taxonomy" class="secondary back-to-taxonomy">返回税种分类</button></div>`;
    $('#back-to-taxonomy').addEventListener('click', () => browseDocuments().catch(console.error));
  }
  renderDocuments(data.results, { append });
  const list = $('#document-list');
  list.querySelector('.load-more')?.remove();
  if (data.hasMore) {
    const more = document.createElement('button');
    more.className = 'secondary load-more';
    more.textContent = `继续加载（剩余 ${data.total - data.offset - data.results.length} 条）`;
    more.addEventListener('click', () => browseDocuments(taxType, data.offset + data.results.length).catch(console.error));
    list.append(more);
  }
}
async function browseDocuments(taxType = '', offset = 0) {
  const status = $('#status-filter').value;
  const publishedYear = $('#published-year-filter').value;
  if (!taxType) { renderTaxonomy(await api(`/api/taxonomy?status=${encodeURIComponent(status)}&publishedYear=${encodeURIComponent(publishedYear)}`)); return; }
  state.browseTaxType = taxType;
  const data = await api(`/api/documents?status=${encodeURIComponent(status)}&publishedYear=${encodeURIComponent(publishedYear)}&taxType=${encodeURIComponent(taxType)}&limit=50&offset=${offset}`);
  renderBrowsePage(data, taxType, offset > 0);
}
function renderQuery(data) {
  const root = $('#query-result'); root.classList.remove('empty');
  if (!data.answered) { root.innerHTML = `<strong>暂不生成结论</strong><br />${escapeHtml(data.reason)}`; renderDocuments(data.results); return; }
  const citedDocuments = new Set();
  const citations = data.citations.filter((citation) => {
    if (citedDocuments.has(citation.documentId)) return false;
    citedDocuments.add(citation.documentId);
    return true;
  });
  root.innerHTML = `<strong>检索摘要</strong><p>${escapeHtml(data.answer)}</p><div class="matches">${citations.map((citation) => `<strong>依据：${escapeHtml(citation.title)}${citation.documentNumber ? `（${escapeHtml(citation.documentNumber)}）` : ''}</strong><a href="${escapeHtml(citation.officialUrl)}" target="_blank" rel="noreferrer">查看官方原文</a>`).join('<hr />')}</div>`;
  renderDocuments(data.results);
}
function renderTopic(data) {
  const root = $('#query-result'); root.classList.remove('empty');
  const basis = data.current.slice(0, 5).flatMap((item) => item.matchingSections.slice(0, 2).map((section) => `<strong>${escapeHtml(item.document.title)} · ${escapeHtml(section.label)}</strong>${escapeHtml(section.text)}`));
  root.innerHTML = `<strong>${escapeHtml(data.topic.label)}专题</strong><p>现行有效依据 ${data.current.length} 条；历史政策 ${data.history.length} 条。下列条款可作为检索依据，请以官方原文为准。</p>${basis.length ? `<div class="matches">${basis.join('<hr />')}</div>` : '<p>当前资料中尚未找到可直接引用的现行条款。</p>'}`;
  renderDocuments([...data.current, ...data.history]);
}
async function openTopic() { const topic = $('#topic-selector').value; renderTopic(await api(`/api/topics/${encodeURIComponent(topic)}`)); }
async function runQuery(event) { event.preventDefault(); const question = $('#question').value; const taxType = $('#tax-type').value; const publishedYear = $('#published-year-filter').value; renderQuery(await api('/api/query', { method: 'POST', body: JSON.stringify({ question, taxType, publishedYear }) })); }
function switchView(view) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === view));
  $('#workspace-view').hidden = view !== 'workspace';
  $('#search-view').hidden = view !== 'search';
  $('#admin-view').hidden = view !== 'admin';
  $('#app-view').classList.toggle('workspace-active', view === 'workspace');
  const isSearch = view === 'search';
  $('#hero-title').textContent = isSearch ? '查询税法政策' : view === 'admin' ? '管理工作台' : '财务工作台';
  $('#hero-summary').textContent = isSearch ? '用业务语言提问，或直接按文件名称、文号和条款关键词检索。' : view === 'admin' ? '管理官方来源、采集任务与审核记录。' : '政策、实务工具与学习入口，集中在一个工作页面。';
  if (isSearch && !$('#document-list').children.length) browseDocuments().catch(console.error);
}
function parseSections(text) { return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line, index) => { const [label, ...rest] = line.split('｜'); return { label: rest.length ? label.trim() : `第${index + 1}段`, text: (rest.length ? rest.join('｜') : label).trim() }; }); }
function formData(form) { return Object.fromEntries(new FormData(form).entries()); }
function renderPriorityReview(groups) {
  const root = $('#priority-review-list');
  root.innerHTML = groups.map((group) => {
    const expanded = state.priorityExpanded.has(group.id);
    const visibleItems = expanded ? group.items : group.items.slice(0, 8);
    const more = group.total > visibleItems.length ? `<button class="secondary small-action" data-priority-toggle="${escapeHtml(group.id)}">展开全部 ${group.total} 条</button>` : expanded && group.total > 8 ? `<button class="secondary small-action" data-priority-toggle="${escapeHtml(group.id)}">收起，仅显示前 8 条</button>` : '';
    return `<div class="compact-item"><strong>${escapeHtml(group.label)} · 待核验 ${group.total} 条</strong>${visibleItems.length ? `<div class="compact-list">${visibleItems.map((item) => `<div class="compact-item"><strong>${escapeHtml(item.document.title)}</strong><br /><small>${escapeHtml(item.document.authority)}${item.document.publishedAt ? ` · ${escapeHtml(item.document.publishedAt)}` : ''} · ${escapeHtml(item.reviewHint)}</small><div class="candidate-actions"><a href="${escapeHtml(item.document.officialUrl)}" target="_blank" rel="noreferrer">官方原文</a><select data-priority-select="${item.document.id}"><option value="pending_verification">暂不改动</option><option value="current">现行有效</option><option value="revised">已修订</option><option value="repealed">已废止</option><option value="expired">期限届满</option></select><button class="secondary small-action" data-priority-save="${item.document.id}">保存状态</button></div></div>`).join('')}</div>${more ? `<div class="candidate-actions">${more}</div>` : ''}` : '<p class="hint">暂无待核验文件。</p>'}</div>`;
  }).join('');
  document.querySelectorAll('[data-priority-toggle]').forEach((button) => button.addEventListener('click', async () => { const id = button.dataset.priorityToggle; if (state.priorityExpanded.has(id)) state.priorityExpanded.delete(id); else state.priorityExpanded.add(id); await loadAdmin(); }));
  document.querySelectorAll('[data-priority-save]').forEach((button) => button.addEventListener('click', async () => { const documentId = button.dataset.prioritySave; const status = document.querySelector(`[data-priority-select="${documentId}"]`).value; if (status === 'pending_verification') return; if (!confirm(`确认将该文件标记为“${status === 'current' ? '现行有效' : status === 'revised' ? '已修订' : status === 'repealed' ? '已废止' : '期限届满'}”？请先核对官方原文。`)) return; button.disabled = true; try { await api(`/api/admin/documents/${documentId}/status`, { method: 'POST', body: JSON.stringify({ status }) }); await browseDocuments(); } catch (error) { alert(`保存失败：${error.message}`); } finally { await loadAdmin(); } }));
}
async function loadAdmin() {
  const [sourceData, candidateData, auditData, collectionData, bulkImportData, statusCheckData, priorityReviewData] = await Promise.all([api('/api/admin/sources'), api('/api/admin/candidates'), api('/api/admin/audit'), api('/api/admin/collections'), api('/api/admin/bulk-imports'), api('/api/admin/status-checks'), api('/api/admin/priority-review?limit=500')]); state.sources = sourceData.sources;
  $('#candidate-source').innerHTML = state.sources.map((source) => `<option value="${escapeHtml(source.id)}">${escapeHtml(source.name)}</option>`).join('');
  const supportsCollection = (source) => source.collector || ['chinatax.gov.cn', 'mof.gov.cn', 'gov.cn', 'npc.gov.cn'].some((domain) => source.url.includes(domain));
  $('#source-list').innerHTML = state.sources.map((source) => `<div class="compact-item"><strong>${escapeHtml(source.name)}</strong><br /><small>${escapeHtml(source.authority)} · ${escapeHtml(source.scanFrequency)} 扫描 · 最近：${source.lastScannedAt ? new Date(source.lastScannedAt).toLocaleString('zh-CN') : '尚未采集'} · <a href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">官方站点</a></small><div class="candidate-actions">${supportsCollection(source) ? `<button data-collect="${source.id}">采集最新</button><button class="secondary small-action" data-full-import="${source.id}" data-import-pages="${source.url.includes('mof.gov.cn') ? 50 : source.url.includes('npc.gov.cn') ? 120 : 20}">全量导入</button>${source.url.includes('fgk.chinatax.gov.cn') ? `<button class="secondary small-action" data-status-check="${source.id}">核验有效状态</button>` : ''}` : ''}<button class="secondary small-action" data-collect-urls="${source.id}">补充官方链接</button></div></div>`).join('');
  document.querySelectorAll('[data-collect]').forEach((button) => button.addEventListener('click', async () => { const sourceName = button.closest('.compact-item').querySelector('strong').textContent; button.disabled = true; button.textContent = '采集中…'; try { const response = await api(`/api/admin/sources/${button.dataset.collect}/collect`, { method: 'POST', body: JSON.stringify({ maxDocuments: 25 }) }); const item = response.collection; alert(`${sourceName}采集完成：新增 ${item.createdCandidates} 条待审候选，跳过 ${item.skippedDuplicates} 条重复项。`); } catch (error) { alert(`采集失败：${error.message}`); } finally { await loadAdmin(); } }));
  document.querySelectorAll('[data-full-import]').forEach((button) => button.addEventListener('click', async () => { const sourceName = button.closest('.compact-item').querySelector('strong').textContent; if (!confirm(`将从${sourceName}按分类和分页建立全量导入清单，并分批写入待审区。导入不会自动发布，是否继续？`)) return; button.disabled = true; button.textContent = '正在创建任务…'; try { await api(`/api/admin/sources/${button.dataset.fullImport}/full-import`, { method: 'POST', body: JSON.stringify({ batchSize: 25, maxListPages: Number(button.dataset.importPages || 20) }) }); } catch (error) { alert(`创建导入任务失败：${error.message}`); } finally { await loadAdmin(); } }));
  document.querySelectorAll('[data-status-check]').forEach((button) => button.addEventListener('click', async () => { if (!confirm('将逐条读取国家税务总局官方页面，按“全文有效、已修订、已废止”标识更新库内状态。任务会在后台分批执行，是否继续？')) return; button.disabled = true; button.textContent = '正在创建任务…'; try { await api('/api/admin/status-checks', { method: 'POST', body: JSON.stringify({ sourceId: button.dataset.statusCheck, batchSize: 20 }) }); } catch (error) { alert(`创建状态核验任务失败：${error.message}`); } finally { await loadAdmin(); } }));
  document.querySelectorAll('[data-collect-urls]').forEach((button) => button.addEventListener('click', async () => { const value = prompt('每行粘贴一个官方原文链接（单次最多 50 个）：'); if (!value) return; const urls = value.split(/\r?\n/).map((url) => url.trim()).filter(Boolean); button.disabled = true; try { const result = await api(`/api/admin/sources/${button.dataset.collectUrls}/collect-urls`, { method: 'POST', body: JSON.stringify({ urls }) }); alert(`补充完成：新增 ${result.collection.createdCandidates} 条待审核文件，重复 ${result.collection.skippedDuplicates} 条。`); } catch (error) { alert(`补充失败：${error.message}`); } finally { await loadAdmin(); } }));
  $('#collection-list').innerHTML = collectionData.collections.length ? collectionData.collections.slice(0, 6).map((item) => `<div class="compact-item"><strong>新增 ${item.createdCandidates} 条待审候选</strong><br /><small>${new Date(item.completedAt).toLocaleString('zh-CN')} · 发现 ${item.discoveredDetailUrls} 个详情页 · 重复 ${item.skippedDuplicates} · 异常 ${item.errors.length}</small></div>`).join('') : '<p class="hint">尚未执行采集。国家税务总局来源可点击“立即采集”。</p>';
  $('#bulk-import-list').innerHTML = bulkImportData.imports.length ? bulkImportData.imports.slice(0, 5).map((item) => { const progress = item.total === null ? '正在建立文件清单…' : `${item.processed} / ${item.total} 个详情页`; const canResumeBlocked = !item.retryAfter || new Date(item.retryAfter) <= new Date(); const action = item.status === 'running' || item.status === 'discovering' ? `<button class="reject" data-import-action="pause" data-import-id="${item.id}">暂停</button>` : item.status === 'paused' || item.status === 'failed' ? `<button data-import-action="resume" data-import-id="${item.id}">继续</button>` : item.status === 'blocked' ? `<button data-import-action="resume" data-import-id="${item.id}" ${canResumeBlocked ? '' : 'disabled'}>${canResumeBlocked ? '重试' : '官方限制中'}</button>` : ''; const retry = item.status === 'completed' && item.errors.length ? `<button data-retry-import="${item.id}">重试失败 ${item.errors.length} 条</button>` : ''; const blocked = item.blockedReason ? `<br /><small>${escapeHtml(item.blockedReason)} ${item.retryAfter ? `建议重试：${new Date(item.retryAfter).toLocaleString('zh-CN')}` : ''}</small>` : ''; return `<div class="compact-item"><strong>${escapeHtml(item.status)} · ${progress}</strong><br /><small>新增待审 ${item.createdCandidates} · 重复 ${item.skippedDuplicates} · 分类页 ${item.discoveredListPages} · 异常 ${item.errors.length}</small>${blocked}<div class="candidate-actions">${action}${retry}</div></div>`; }).join('') : '<p class="hint">点击“全量导入”后，系统会生成可断点续传的批量任务。</p>';
  $('#status-check-list').innerHTML = statusCheckData.checks.length ? statusCheckData.checks.slice(0, 3).map((item) => { const progress = `${item.processed} / ${item.total} 份文件`; const canResume = !item.retryAfter || new Date(item.retryAfter) <= new Date(); const action = ['blocked', 'failed'].includes(item.status) ? `<button data-resume-status-check="${item.id}" ${canResume ? '' : 'disabled'}>${canResume ? '继续核验' : '官方限制中'}</button>` : ''; const note = item.blockedReason ? `<br /><small>${escapeHtml(item.blockedReason)}${item.retryAfter ? `，建议重试：${new Date(item.retryAfter).toLocaleString('zh-CN')}` : ''}</small>` : ''; return `<div class="compact-item"><strong>${escapeHtml(item.status)} · ${progress}</strong><br /><small>状态更新 ${item.updated} · 无明确标识 ${item.noSignal} · 异常 ${item.errors.length}</small>${note}<div class="candidate-actions">${action}</div></div>`; }).join('') : '<p class="hint">点击“核验有效状态”后，系统会读取官方页面并后台更新状态。</p>';
  document.querySelectorAll('[data-import-action]').forEach((button) => button.addEventListener('click', async () => { await api(`/api/admin/bulk-imports/${button.dataset.importId}/${button.dataset.importAction}`, { method: 'POST', body: '{}' }); await loadAdmin(); }));
  document.querySelectorAll('[data-retry-import]').forEach((button) => button.addEventListener('click', async () => { if (!confirm('将以较低并发重新请求尚未成功入库的官方文件，是否继续？')) return; button.disabled = true; button.textContent = '重试中…'; try { await api(`/api/admin/bulk-imports/${button.dataset.retryImport}/retry`, { method: 'POST', body: '{}' }); } catch (error) { alert(`创建重试任务失败：${error.message}`); } finally { await loadAdmin(); } }));
  document.querySelectorAll('[data-resume-status-check]').forEach((button) => button.addEventListener('click', async () => { button.disabled = true; try { await api(`/api/admin/status-checks/${button.dataset.resumeStatusCheck}/resume`, { method: 'POST', body: '{}' }); } catch (error) { alert(`继续核验失败：${error.message}`); } finally { await loadAdmin(); } }));
  renderPriorityReview(priorityReviewData.groups);
  const documentReviewResult = $('#document-review-result');
  const documentReviewApply = $('#document-review-apply');
  if (state.documentReview) {
    documentReviewResult.textContent = `预览：检查 ${state.documentReview.examined} 条已发布待核验文件；可归档期限届满 ${state.documentReview.expirable} 条；保留 ${state.documentReview.held} 条。`;
    documentReviewApply.disabled = state.documentReview.expirable === 0;
  } else {
    documentReviewResult.textContent = '请先预览。';
    documentReviewApply.disabled = true;
  }
  $('#document-review-preview').onclick = async () => { state.documentReview = await api('/api/admin/document-review', { method: 'POST', body: JSON.stringify({ apply: false }) }); await loadAdmin(); };
  documentReviewApply.onclick = async () => { if (!state.documentReview?.expirable || !confirm(`将把 ${state.documentReview.expirable} 条正文明确写明期限届满的文件归档为历史资料，是否继续？`)) return; const result = await api('/api/admin/document-review', { method: 'POST', body: JSON.stringify({ apply: true }) }); alert(`期限复核完成：归档 ${result.expired} 条；保留 ${result.held} 条。`); state.documentReview = null; await loadAdmin(); await browseDocuments(); };
  const documentVersionReviewResult = $('#document-version-review-result');
  const documentVersionReviewApply = $('#document-version-review-apply');
  if (state.documentVersionReview) {
    documentVersionReviewResult.textContent = `预览：检查 ${state.documentVersionReview.examined} 条已发布文件；可建立版本关系 ${state.documentVersionReview.linkable} 条；可更新历史状态 ${state.documentVersionReview.updateable} 条。`;
    documentVersionReviewApply.disabled = state.documentVersionReview.linkable === 0;
  } else {
    documentVersionReviewResult.textContent = '请先预览。';
    documentVersionReviewApply.disabled = true;
  }
  $('#document-version-review-preview').onclick = async () => { state.documentVersionReview = await api('/api/admin/document-version-review', { method: 'POST', body: JSON.stringify({ apply: false }) }); await loadAdmin(); };
  documentVersionReviewApply.onclick = async () => { if (!state.documentVersionReview?.linkable || !confirm(`将建立 ${state.documentVersionReview.linkable} 条有明确原文依据的版本关系，并更新 ${state.documentVersionReview.updateable} 条历史状态，是否继续？`)) return; const result = await api('/api/admin/document-version-review', { method: 'POST', body: JSON.stringify({ apply: true }) }); alert(`版本复核完成：建立关系 ${result.linked} 条；更新状态 ${result.updated} 条。`); state.documentVersionReview = null; await loadAdmin(); await browseDocuments(); };
  $('#candidate-list').innerHTML = candidateData.candidates.length ? candidateData.candidates.map((candidate) => `<div class="compact-item"><strong>${escapeHtml(candidate.document.title)}</strong><br /><small>${escapeHtml(candidate.document.authority)} · ${escapeHtml(candidate.state)} · ${new Date(candidate.discoveredAt).toLocaleString('zh-CN')}</small>${candidate.state === 'pending' ? `<div class="candidate-actions"><button data-review="publish" data-id="${candidate.id}">审核发布</button><button class="reject" data-review="reject" data-id="${candidate.id}">驳回</button></div>` : ''}</div>`).join('') : '<p class="hint">暂无待审候选。</p>';
  document.querySelectorAll('[data-review]').forEach((button) => button.addEventListener('click', async () => { await api(`/api/admin/candidates/${button.dataset.id}/review`, { method: 'POST', body: JSON.stringify({ action: button.dataset.review }) }); await loadAdmin(); await browseDocuments(); }));
  const autoResult = $('#auto-review-result');
  const applyButton = $('#auto-review-apply');
  if (state.autoReview) {
    autoResult.textContent = `预览：检查 ${state.autoReview.examined} 条；可自动发布 ${state.autoReview.publishable} 条；保留人工审核 ${state.autoReview.held} 条。`;
    applyButton.disabled = state.autoReview.publishable === 0;
  } else {
    autoResult.textContent = '请先预览。';
    applyButton.disabled = true;
  }
  $('#auto-review-preview').onclick = async () => { state.autoReview = await api('/api/admin/auto-review', { method: 'POST', body: JSON.stringify({ apply: false }) }); await loadAdmin(); };
  applyButton.onclick = async () => { if (!state.autoReview?.publishable || !confirm(`将自动发布 ${state.autoReview.publishable} 条有明确现行有效依据的文件，是否继续？`)) return; const result = await api('/api/admin/auto-review', { method: 'POST', body: JSON.stringify({ apply: true }) }); alert(`自动初审完成：发布 ${result.published} 条；保留 ${result.held} 条人工审核。`); state.autoReview = null; await loadAdmin(); await browseDocuments(); };
  const secondaryResult = $('#secondary-review-result');
  const secondaryApplyButton = $('#secondary-review-apply');
  if (state.secondaryReview) {
    secondaryResult.textContent = `预览：检查 ${state.secondaryReview.examined} 条；可归档历史文件 ${state.secondaryReview.archivable} 条；保留 ${state.secondaryReview.held} 条；发现版本关系线索 ${state.secondaryReview.relationHints} 条。`;
    secondaryApplyButton.disabled = state.secondaryReview.archivable === 0;
  } else {
    secondaryResult.textContent = '请先预览。';
    secondaryApplyButton.disabled = true;
  }
  $('#secondary-review-preview').onclick = async () => { state.secondaryReview = await api('/api/admin/secondary-review', { method: 'POST', body: JSON.stringify({ apply: false }) }); await loadAdmin(); };
  secondaryApplyButton.onclick = async () => { if (!state.secondaryReview?.archivable || !confirm(`将归档 ${state.secondaryReview.archivable} 条已修订或已废止文件。它们仍可检索，但不会用于自动问答结论，是否继续？`)) return; const result = await api('/api/admin/secondary-review', { method: 'POST', body: JSON.stringify({ apply: true }) }); alert(`第二轮复核完成：归档 ${result.archived} 条；保留 ${result.held} 条；记录版本关系线索 ${result.relationHints} 条。`); state.secondaryReview = null; await loadAdmin(); await browseDocuments(); };
  const thirdResult = $('#third-review-result');
  const thirdApplyButton = $('#third-review-apply');
  if (state.thirdReview) {
    thirdResult.textContent = `预览：可归档期限届满文件 ${state.thirdReview.expiryArchivable} 条；可建立版本关系 ${state.thirdReview.linkable} 条；其余待补全关系线索 ${state.thirdReview.queuedRelationHints} 条。`;
    thirdApplyButton.disabled = state.thirdReview.expiryArchivable === 0 && state.thirdReview.linkable === 0;
  } else {
    thirdResult.textContent = '请先预览。';
    thirdApplyButton.disabled = true;
  }
  $('#third-review-preview').onclick = async () => { state.thirdReview = await api('/api/admin/third-review', { method: 'POST', body: JSON.stringify({ apply: false }) }); await loadAdmin(); };
  thirdApplyButton.onclick = async () => { if ((!state.thirdReview?.expiryArchivable && !state.thirdReview?.linkable) || !confirm(`将归档 ${state.thirdReview.expiryArchivable} 条期限届满文件，并建立 ${state.thirdReview.linkable} 条版本关系，是否继续？`)) return; const result = await api('/api/admin/third-review', { method: 'POST', body: JSON.stringify({ apply: true }) }); alert(`第三轮复核完成：归档 ${result.archivedExpired} 条期限届满文件；建立 ${result.linked} 条版本关系。`); state.thirdReview = null; await loadAdmin(); await browseDocuments(); };
  $('#audit-list').innerHTML = auditData.audit.length ? auditData.audit.map((item) => `<div class="compact-item"><strong>${escapeHtml(item.action)}</strong> · ${escapeHtml(item.actor)}<br /><small>${new Date(item.at).toLocaleString('zh-CN')} · ${escapeHtml(item.targetType)} / ${escapeHtml(item.targetId)}</small></div>`).join('') : '<p class="hint">暂无操作记录。</p>';
}

$('#login-form').addEventListener('submit', async (event) => { event.preventDefault(); $('#login-error').textContent = ''; try { const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(formData(event.currentTarget)) }); state.token = data.token; state.user = data.user; localStorage.setItem('taxkb-token', state.token); showApp(); } catch (error) { $('#login-error').textContent = error.message; } });
$('#query-form').addEventListener('submit', (event) => runQuery(event).catch((error) => { $('#query-result').textContent = error.message; }));
$('#browse-documents').addEventListener('click', () => browseDocuments().catch(console.error));
$('#status-filter').addEventListener('change', () => browseDocuments(state.browseTaxType).catch(console.error));
$('#published-year-filter').addEventListener('change', () => browseDocuments(state.browseTaxType).catch(console.error));
$('#open-topic').addEventListener('click', () => openTopic().catch((error) => { $('#query-result').textContent = error.message; }));
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => switchView(tab.dataset.view)));
document.querySelectorAll('[data-open-search]').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); switchView('search'); }));
$('#source-form').addEventListener('submit', async (event) => { event.preventDefault(); try { await api('/api/admin/sources', { method: 'POST', body: JSON.stringify(formData(event.currentTarget)) }); event.currentTarget.reset(); await loadAdmin(); } catch (error) { alert(error.message); } });
$('#candidate-form').addEventListener('submit', async (event) => { event.preventDefault(); const input = formData(event.currentTarget); input.taxTypes = input.taxTypes.split(',').map((value) => value.trim()).filter(Boolean); input.sections = parseSections(input.sections); try { await api('/api/admin/candidates', { method: 'POST', body: JSON.stringify(input) }); event.currentTarget.reset(); await loadAdmin(); } catch (error) { alert(error.message); } });
restoreSession();
