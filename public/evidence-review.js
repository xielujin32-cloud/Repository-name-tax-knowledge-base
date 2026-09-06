let adminToken = '';
let selectedCandidateId = '';
const requestedCandidateId = new URLSearchParams(window.location.search).get('candidate') || '';

const $ = (selector) => document.querySelector(selector);
const arrayText = (value) => Array.isArray(value) ? value.join('\n') : '';
const textArray = (value) => String(value || '').split(/\r?\n|[,，]/).map((item) => item.trim()).filter(Boolean);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function message(id, value = '', type = '') { const node = $(id); node.textContent = value; node.className = `message ${type}`; }
function inputValue(name, value) { $(`[name="${name}"]`).value = value || ''; }
function preferredSuggestion(fields, field) {
  if (field === 'summary' && String(fields[field] || '').trim()) return fields[field];
  if (Array.isArray(fields[field]) && fields[field].length) return fields[field];
  const suggestion = fields.metadata_suggestion || {};
  return suggestion[field]?.values || (field === 'summary' ? suggestion.summary?.value : null);
}

function renderCandidates(candidates) {
  const root = $('#candidate-list');
  root.replaceChildren();
  const pending = candidates.filter((item) => item.verification_state === 'pending_review');
  message('#list-message', pending.length ? `待审核 ${pending.length} 条。` : '暂无待审核 Candidate。');
  for (const candidate of pending) {
    const card = document.createElement('article'); card.className = 'candidate';
    const title = document.createElement('h3'); title.textContent = candidate.parsed_fields?.title || '未解析标题';
    const meta = document.createElement('p'); meta.textContent = `${candidate.source_name || candidate.source_id} · ${candidate.parsed_fields?.publish_date || '日期待确认'} · ${candidate.legal_status}`;
    const link = document.createElement('a'); link.href = candidate.official_url; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = '官方原文';
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '进入审核'; button.addEventListener('click', () => loadDetail(candidate.candidate_id));
    card.append(title, meta, link, document.createTextNode(' '), button); root.append(card);
  }
}

async function loadCandidates() {
  const body = await api('/api/admin/evidence/candidates');
  renderCandidates(body.candidates || []);
}

async function loadDetail(candidateId) {
  const { detail } = await api(`/api/admin/evidence/candidates/${encodeURIComponent(candidateId)}`);
  selectedCandidateId = candidateId;
  const fields = detail.candidate.parsed_fields || {};
  $('#detail-panel').hidden = false;
  $('#detail-title').textContent = fields.title || '政策审核详情';
  $('#official-link').href = detail.candidate.official_url;
  $('#detail-meta').textContent = `${detail.source.source_name} · Snapshot ${detail.raw_snapshot.snapshot_id} · HTTP ${detail.raw_snapshot.http_status} · ${detail.raw_snapshot.fetched_at}`;
  inputValue('title', fields.title); inputValue('document_no', fields.document_no);
  inputValue('issuing_authority', arrayText(fields.issuing_authority)); inputValue('publish_date', fields.publish_date);
  inputValue('effective_date', fields.effective_date); inputValue('expiry_date', fields.expiry_date);
  inputValue('tax_categories', arrayText(preferredSuggestion(fields, 'tax_categories')));
  inputValue('keywords', arrayText(preferredSuggestion(fields, 'keywords'))); inputValue('summary', preferredSuggestion(fields, 'summary'));
  const suggestion = fields.metadata_suggestion;
  message('#suggestion-message', suggestion
    ? `系统建议 / 待人工确认：规则 ${suggestion.rule_version}；可直接修改、删除或清空后再发布。`
    : '尚未生成系统建议；税种、关键词和摘要可由管理员手动填写。');
  $('[name="legal_status"]').value = detail.candidate.legal_status || 'pending';
  $('#normalized-text').value = detail.raw_snapshot.normalized_text || '';
  $('#raw-html').value = detail.raw_snapshot.raw_html || '';
  message('#review-message');
  $('#detail-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function reviewPayload(action) {
  const form = $('#review-form');
  return {
    action,
    legal_status: form.legal_status.value,
    note: form.note.value,
    fields: {
      title: form.title.value,
      document_no: form.document_no.value,
      issuing_authority: textArray(form.issuing_authority.value),
      publish_date: form.publish_date.value || null,
      effective_date: form.effective_date.value || null,
      expiry_date: form.expiry_date.value || null,
      tax_categories: textArray(form.tax_categories.value),
      keywords: textArray(form.keywords.value),
      summary: form.summary.value
    }
  };
}

async function reparsePhase2B() {
  const confirmation = prompt('此操作只会从已保存的原始 HTML 重新解析两条 Phase 2B Candidate，不会抓取网页或发布政策。请输入确认短语：');
  if (confirmation !== 'REPARSE_PHASE2B_TWO_CANDIDATES') return message('#list-message', '未执行重新解析：确认短语不匹配。', 'error');
  const button = $('#reparse-phase2b');
  button.disabled = true;
  try {
    const result = await api('/api/admin/evidence/reparse-phase2b', {
      method: 'POST',
      body: JSON.stringify({ apply: true, confirmation })
    });
    message('#list-message', `重新解析完成：${result.reparsed_candidates} 条 Candidate；未创建新 Candidate。`, 'success');
    await loadCandidates();
    if (selectedCandidateId) await loadDetail(selectedCandidateId);
  } catch (error) { message('#list-message', `重新解析失败：${error.message}`, 'error'); }
  finally { button.disabled = false; }
}

async function suggestPhase2BMetadata() {
  const confirmation = prompt('此操作只会从当前已解析正文生成两条 Phase 2B 的税种、关键词和摘要建议，不会抓取、发布或改变效力状态。请输入确认短语：');
  if (confirmation !== 'SUGGEST_PHASE2B_TWO_CANDIDATES') return message('#list-message', '未生成建议：确认短语不匹配。', 'error');
  const button = $('#suggest-phase2b-metadata');
  button.disabled = true;
  try {
    const result = await api('/api/admin/evidence/suggest-phase2b-metadata', {
      method: 'POST',
      body: JSON.stringify({ apply: true, confirmation })
    });
    message('#list-message', `审核建议已生成：${result.suggested_candidates} 条 Candidate；仍待人工确认。`, 'success');
    await loadCandidates();
    if (selectedCandidateId) await loadDetail(selectedCandidateId);
  } catch (error) { message('#list-message', `生成建议失败：${error.message}`, 'error'); }
  finally { button.disabled = false; }
}

async function submitReview(action) {
  if (!selectedCandidateId) return;
  if (!confirm(action === 'approve' ? '确认已完成 Level 3 人工核验并发布？' : `确认执行 ${action}？`)) return;
  const buttons = [...document.querySelectorAll('#review-form button')]; buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await api(`/api/admin/evidence/candidates/${encodeURIComponent(selectedCandidateId)}/review`, { method: 'POST', body: JSON.stringify(reviewPayload(action)) });
    message('#review-message', `审核完成：${result.execution}${result.policy ? ` · ${result.policy.policy_id}` : ''}`, 'success');
    await loadCandidates();
  } catch (error) { message('#review-message', `审核失败：${error.message}`, 'error'); }
  finally { buttons.forEach((button) => { button.disabled = false; }); }
}

$('#connect').addEventListener('click', async () => {
  adminToken = $('#admin-token').value;
  $('#admin-token').value = '';
  if (!adminToken) return message('#login-message', '请输入管理员 Token。', 'error');
  try {
    await loadCandidates();
    $('#login-panel').hidden = true;
    $('#review-panel').hidden = false;
    if (requestedCandidateId) await loadDetail(requestedCandidateId);
  }
  catch (error) { adminToken = ''; message('#login-message', `验证失败：${error.message}`, 'error'); }
});
$('#reload').addEventListener('click', () => loadCandidates().catch((error) => message('#list-message', error.message, 'error')));
$('#reparse-phase2b').addEventListener('click', reparsePhase2B);
$('#suggest-phase2b-metadata').addEventListener('click', suggestPhase2BMetadata);
$('#review-form').addEventListener('submit', (event) => { event.preventDefault(); submitReview('approve'); });
$('#reject').addEventListener('click', () => submitReview('reject'));
$('#return').addEventListener('click', () => submitReview('return'));
