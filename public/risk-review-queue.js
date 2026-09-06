let adminToken = '';
let activeManifestId = '';

const $ = (selector) => document.querySelector(selector);

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
function filters() {
  const data = new FormData($('#filter-form'));
  return Object.fromEntries([...data.entries()].filter(([, value]) => String(value).trim()));
}
function queryString(value) { const params = new URLSearchParams(value); return params.size ? `?${params}` : ''; }

function renderQueue(results = []) {
  const root = $('#queue-list'); root.replaceChildren();
  for (const item of results) {
    const card = document.createElement('article'); card.className = 'candidate';
    const fields = item.candidate.parsed_fields || {};
    const title = document.createElement('h3'); title.textContent = fields.title || '未解析标题';
    const meta = document.createElement('p'); meta.textContent = `${item.assessment.risk_level.toUpperCase()} · ${item.assessment.risk_score} 分 · ${item.source.source_name || item.candidate.source_id}`;
    const reasons = document.createElement('p'); reasons.className = 'metadata'; reasons.textContent = `规则 ${item.assessment.rule_version}；${item.assessment.risk_reasons.map((reason) => reason.code).join('、') || '无风险原因'}；正文 hash ${item.assessment.input_body_sha256}`;
    const action = document.createElement('a'); action.href = `/evidence-review.html?candidate=${encodeURIComponent(item.candidate.candidate_id)}`; action.textContent = item.assessment.risk_level === 'high' ? '进入完整 Level 3 审核' : '进入单条审核';
    card.append(title, meta, reasons, action); root.append(card);
  }
}

async function loadQueue() {
  const result = await api(`/api/admin/evidence/risk-queue${queryString(filters())}`);
  renderQueue(result.results || []);
  message('#queue-message', `当前筛选命中 ${result.total || 0} 条。`);
}

async function createManifest() {
  const button = $('#create-manifest'); button.disabled = true;
  try {
    const result = await api('/api/admin/evidence/risk-queue/manifests', { method: 'POST', body: JSON.stringify({ filters: { ...filters(), risk_level: 'low' } }) });
    activeManifestId = result.manifest.manifest_id;
    $('#manifest-panel').hidden = false;
    $('#manifest-summary').textContent = JSON.stringify({ manifest_id: activeManifestId, state: result.manifest.manifest_state, batch_size: result.manifest.batch_size, sample_size: result.manifest.sample_size, sampled_candidates: result.items.filter((item) => item.is_sample).map((item) => item.candidate.candidate_id) }, null, 2);
    message('#manifest-message', 'manifest 已冻结。请先逐条完成所有抽样 Candidate 的现有 Level 3 审核；抽样不通过将自动阻断整批。');
  } catch (error) { message('#queue-message', `创建 manifest 失败：${error.message}`, 'error'); }
  finally { button.disabled = false; }
}

async function applyManifest() {
  if (!activeManifestId) return;
  const confirmation = prompt('此操作会在服务器重新校验 manifest，并只处理已完成抽样审核的剩余 Low Risk Candidate。请输入固定确认短语：');
  if (confirmation !== 'CONFIRM_LOW_RISK_BATCH') return message('#manifest-message', '未执行：确认短语不匹配。', 'error');
  const button = $('#apply-manifest'); button.disabled = true;
  try {
    const result = await api(`/api/admin/evidence/risk-queue/manifests/${encodeURIComponent(activeManifestId)}/apply`, { method: 'POST', body: JSON.stringify({ apply: true, confirmation }) });
    message('#manifest-message', `执行结果：${result.execution}`, result.execution === 'completed' ? 'success' : '');
  } catch (error) { message('#manifest-message', `执行失败：${error.message}`, 'error'); }
  finally { button.disabled = false; }
}

$('#connect').addEventListener('click', async () => {
  adminToken = $('#admin-token').value; $('#admin-token').value = '';
  if (!adminToken) return message('#login-message', '请输入管理员 Token。', 'error');
  try { await loadQueue(); $('#login-panel').hidden = true; $('#queue-panel').hidden = false; }
  catch (error) { adminToken = ''; message('#login-message', `验证失败：${error.message}`, 'error'); }
});
$('#filter-form').addEventListener('submit', (event) => { event.preventDefault(); loadQueue().catch((error) => message('#queue-message', error.message, 'error')); });
$('#reload').addEventListener('click', () => loadQueue().catch((error) => message('#queue-message', error.message, 'error')));
$('#create-manifest').addEventListener('click', createManifest);
$('#apply-manifest').addEventListener('click', applyManifest);
