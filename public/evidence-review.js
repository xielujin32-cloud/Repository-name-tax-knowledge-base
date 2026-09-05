let adminToken = '';
let selectedCandidateId = '';

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
  inputValue('tax_categories', arrayText(fields.tax_categories)); inputValue('keywords', arrayText(fields.keywords)); inputValue('summary', fields.summary);
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
  try { await loadCandidates(); $('#login-panel').hidden = true; $('#review-panel').hidden = false; }
  catch (error) { adminToken = ''; message('#login-message', `验证失败：${error.message}`, 'error'); }
});
$('#reload').addEventListener('click', () => loadCandidates().catch((error) => message('#list-message', error.message, 'error')));
$('#review-form').addEventListener('submit', (event) => { event.preventDefault(); submitReview('approve'); });
$('#reject').addEventListener('click', () => submitReview('reject'));
$('#return').addEventListener('click', () => submitReview('return'));
