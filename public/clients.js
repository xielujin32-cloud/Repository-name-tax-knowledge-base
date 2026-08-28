const clientStorageKey = 'finance-workbench-clients-v1';
const clientsLayout = document.querySelector('#clients-layout');
const clientEditor = document.querySelector('#client-editor');
const clientForm = document.querySelector('#client-form');
const clientFormTitle = document.querySelector('#client-form-title');
const cancelEdit = document.querySelector('#client-cancel-edit');
const list = document.querySelector('#client-list');
const count = document.querySelector('#client-count');
const search = document.querySelector('#client-search');
const addClientButton = document.querySelector('#client-add');

let clients = loadClients();
let editingId = '';

function loadClients() {
  try {
    const saved = JSON.parse(localStorage.getItem(clientStorageKey) || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveClients() {
  localStorage.setItem(clientStorageKey, JSON.stringify(clients));
}

function makeElement(tag, text, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function serviceStatus(item) {
  if (!item.endDate) return ['未填写到期日', ''];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(item.endDate + 'T00:00:00');
  const days = Math.ceil((end - today) / 86400000);
  if (days < 0) return ['已到期', 'expired'];
  if (days <= 30) return ['距到期 ' + days + ' 天', 'expiring'];
  return ['服务中', ''];
}

function formatFee(value) {
  if (value === '' || value === undefined) return '未填写';
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(value));
}

function addDetail(container, label, value) {
  if (!value) return;
  const detail = document.createElement('p');
  detail.append(makeElement('strong', label + '：'), document.createTextNode(value));
  container.append(detail);
}

function addSecret(container, label, account, password) {
  if (!account && !password) return;
  const row = document.createElement('div');
  row.className = 'client-secret';
  const text = makeElement('span', label + '：' + (account || '未填写账号') + '｜密码：' + (password ? '••••••' : '未填写'));
  row.append(text);
  if (password) {
    const reveal = makeElement('button', '显示密码');
    reveal.type = 'button';
    let shown = false;
    reveal.addEventListener('click', () => {
      shown = !shown;
      text.textContent = label + '：' + (account || '未填写账号') + '｜密码：' + (shown ? password : '••••••');
      reveal.textContent = shown ? '隐藏密码' : '显示密码';
    });
    row.append(reveal);
  }
  container.append(row);
}

function renderClients() {
  const keyword = search.value.trim().toLowerCase();
  const sorted = [...clients].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const matches = sorted.filter((item) => Object.values(item).join(' ').toLowerCase().includes(keyword));
  count.textContent = clients.length + ' 位客户';
  list.replaceChildren();
  if (!matches.length) {
    list.append(makeElement('p', keyword ? '未找到匹配客户。' : '尚未录入客户，请从左侧新增第一位客户。', 'client-empty'));
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'client-table-wrap';
  const table = document.createElement('table');
  table.className = 'client-table';
  const headers = ['客户名称', '状态', '税号', '开始日期', '到期日期', '收费', '联系人', '电子税务局账号', '电子税务局密码', '个税账号', '个税密码', '备注', '操作'];
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  headers.forEach((header) => headRow.append(makeElement('th', header)));
  head.append(headRow);
  const body = document.createElement('tbody');
  const displayValue = (value) => value || '—';
  matches.forEach((item) => {
    const row = document.createElement('tr');
    row.append(makeElement('td', displayValue(item.name)));
    const [status, statusClass] = serviceStatus(item);
    const statusCell = document.createElement('td');
    statusCell.append(makeElement('span', status, 'client-status ' + statusClass));
    row.append(statusCell, makeElement('td', displayValue(item.taxId)), makeElement('td', displayValue(item.startDate)), makeElement('td', displayValue(item.endDate)), makeElement('td', formatFee(item.fee)), makeElement('td', displayValue(item.contact)), makeElement('td', displayValue(item.etaxAccount)), makeElement('td', displayValue(item.etaxPassword)), makeElement('td', displayValue(item.iitAccount)), makeElement('td', displayValue(item.iitPassword)), makeElement('td', displayValue(item.notes)));
    const actionCell = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'client-table-actions';
    const edit = makeElement('button', '编辑', 'client-edit');
    edit.type = 'button';
    edit.addEventListener('click', () => startEdit(item));
    const remove = makeElement('button', '删除', 'client-delete');
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      if (!confirm('确定删除“' + item.name + '”及其资料吗？')) return;
      clients = clients.filter((client) => client.id !== item.id);
      saveClients();
      if (editingId === item.id) resetClientForm();
      renderClients();
    });
    actions.append(edit, remove);
    actionCell.append(actions);
    row.append(actionCell);
    body.append(row);
  });
  table.append(head, body);
  wrap.append(table);
  list.append(wrap);
}

function resetClientForm() {
  editingId = '';
  clientForm.reset();
  clientFormTitle.textContent = '新增客户';
  document.querySelector('#client-save').textContent = '保存客户';
  cancelEdit.hidden = true;
}

function showEditor() {
  clientEditor.hidden = false;
  clientsLayout.classList.remove('list-only');
}

function hideEditor() {
  resetClientForm();
  clientEditor.hidden = true;
  clientsLayout.classList.add('list-only');
}

function startEdit(item) {
  showEditor();
  editingId = item.id;
  Object.entries(item).forEach(([key, value]) => {
    if (clientForm.elements[key]) clientForm.elements[key].value = value || '';
  });
  clientFormTitle.textContent = '编辑客户';
  document.querySelector('#client-save').textContent = '保存修改';
  cancelEdit.hidden = false;
  clientEditor.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

clientForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(clientForm).entries());
  const item = { ...data, name: data.name.trim(), contact: data.contact.trim(), notes: data.notes.trim() };
  if (editingId) clients = clients.map((client) => client.id === editingId ? { ...client, ...item, updatedAt: new Date().toISOString() } : client);
  else clients.push({ id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), ...item, createdAt: new Date().toISOString() });
  saveClients();
  hideEditor();
  renderClients();
});

addClientButton.addEventListener('click', () => {
  resetClientForm();
  showEditor();
  clientEditor.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
cancelEdit.addEventListener('click', hideEditor);
search.addEventListener('input', renderClients);

resetClientForm();
clientEditor.hidden = true;
clientsLayout.classList.add('list-only');
renderClients();
