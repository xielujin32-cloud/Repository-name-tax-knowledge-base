const databaseName = 'finance-workbench-form-templates';
const storeName = 'templates';
const form = document.querySelector('#business-template-form');
const categoryInput = document.querySelector('#business-template-category');
const subcategoryInput = document.querySelector('#business-template-subcategory');
const subcategoryRow = document.querySelector('#business-template-subcategory-row');
const filter = document.querySelector('#business-template-filter');
const subcategoryFilter = document.querySelector('#business-template-subcategory-filter');
const search = document.querySelector('#business-template-search');
const list = document.querySelector('#business-template-list');
const count = document.querySelector('#business-template-count');
const previewDialog = document.querySelector('#business-template-preview');
const previewTitle = document.querySelector('#template-preview-title');
const previewBody = document.querySelector('#template-preview-body');
const previewClose = document.querySelector('#template-preview-close');
const previewDownload = document.querySelector('#template-preview-download');
let previewUrl = '';
const categoryName = { industry: '工商业务', tax: '税务业务' };
const subcategoryName = { importExport: '进出口业务', compliance: '税务合规', financialStatements: '财务报表', other: '其他' };

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function databaseOperation(mode, action) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error);
  });
}

const readTemplates = () => databaseOperation('readonly', (store) => store.getAll());
const saveTemplate = (item) => databaseOperation('readwrite', (store) => store.put(item));
const deleteTemplate = (id) => databaseOperation('readwrite', (store) => store.delete(id));

async function getTemplates() {
  const templates = await readTemplates();
  const legacyTaxTemplates = templates.filter((item) => item.category === 'tax' && !item.taxSubcategory);
  await Promise.all(legacyTaxTemplates.map((item) => saveTemplate({ ...item, taxSubcategory: 'importExport' })));
  return templates.map((item) => item.category === 'tax' && !item.taxSubcategory ? { ...item, taxSubcategory: 'importExport' } : item);
}

function syncSubcategoryControls() {
  const tax = categoryInput.value === 'tax';
  subcategoryRow.hidden = !tax;
  subcategoryInput.disabled = !tax;
  subcategoryFilter.disabled = filter.value !== 'tax';
  if (filter.value !== 'tax') subcategoryFilter.value = '';
}

function formatSize(size) {
  if (size < 1024 * 1024) return Math.ceil(size / 1024) + ' KB';
  return (size / 1024 / 1024).toFixed(1) + ' MB';
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function downloadTemplate(item) {
  const href = URL.createObjectURL(item.file);
  const link = document.createElement('a');
  link.href = href;
  link.download = item.fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function extensionOf(item) {
  return (item.fileName || '').split('.').pop().toLowerCase();
}

function clearPreview() {
  previewBody.replaceChildren();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = '';
}

function closePreview() {
  clearPreview();
  previewDialog.close();
}

function previewTemplate(item) {
  clearPreview();
  previewTitle.textContent = item.title;
  previewUrl = URL.createObjectURL(item.file);
  const extension = extensionOf(item);
  if (item.file.type === 'application/pdf' || extension === 'pdf') {
    const frame = document.createElement('iframe');
    frame.className = 'template-preview-frame';
    frame.src = previewUrl;
    frame.title = item.fileName;
    previewBody.append(frame);
  } else if (item.file.type.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(extension)) {
    const image = document.createElement('img');
    image.className = 'template-preview-image';
    image.src = previewUrl;
    image.alt = item.fileName;
    previewBody.append(image);
  } else if (item.file.type.startsWith('text/') || ['txt', 'csv'].includes(extension)) {
    const text = document.createElement('pre');
    text.className = 'template-preview-text';
    item.file.text().then((content) => { text.textContent = content; }).catch(() => { text.textContent = '此文件无法读取预览，请下载后查看。'; });
    previewBody.append(text);
  } else {
    previewBody.append(element('p', '此类 Word、Excel 或压缩文件暂不支持网页预览，请下载后使用相应软件打开。', 'template-preview-unavailable'));
  }
  previewDownload.onclick = () => downloadTemplate(item);
  previewDialog.showModal();
}

async function renderTemplates() {
  try {
    const keyword = search.value.trim().toLowerCase();
    const selectedCategory = filter.value;
    const selectedSubcategory = subcategoryFilter.value;
    const templates = (await getTemplates()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const matches = templates.filter((item) => (!selectedCategory || item.category === selectedCategory)
      && (!selectedSubcategory || item.taxSubcategory === selectedSubcategory)
      && (!keyword || [item.title, item.description, item.fileName].join(' ').toLowerCase().includes(keyword)));
    count.textContent = templates.length + ' 个模板';
    list.innerHTML = '';
    if (!matches.length) {
      list.append(element('p', keyword || selectedCategory ? '没有匹配的表格模板。' : '尚未导入表格模板。请从左侧上传第一份工商或税务资料。', 'business-template-empty'));
      return;
    }
    matches.forEach((item) => {
      const card = document.createElement('article');
      card.className = 'business-template-card';
      const head = document.createElement('div');
      head.className = 'business-template-card-head';
      const title = document.createElement('div');
      const label = item.category === 'tax'
        ? categoryName[item.category] + ' · ' + subcategoryName[item.taxSubcategory || 'importExport']
        : categoryName[item.category];
      title.append(element('h3', item.title), element('span', label, 'business-template-category'));
      const actions = document.createElement('div');
      const preview = element('button', '预览', 'template-preview');
      preview.type = 'button';
      preview.addEventListener('click', () => previewTemplate(item));
      const download = element('button', '下载', 'template-download');
      download.type = 'button';
      download.addEventListener('click', () => downloadTemplate(item));
      const remove = element('button', '删除', 'template-remove');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        if (!confirm('确定删除“' + item.title + '”吗？')) return;
        await deleteTemplate(item.id);
        renderTemplates();
      });
      actions.append(preview, download, remove);
      head.append(title, actions);
      card.append(head);
      if (item.description) card.append(element('p', item.description, 'business-template-description'));
      card.append(element('small', item.fileName + ' · ' + formatSize(item.file.size), 'business-template-file'));
      list.append(card);
    });
  } catch (error) {
    list.innerHTML = '';
    list.append(element('p', '本浏览器无法打开本地模板资料库：' + error.message, 'business-template-empty'));
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = form.elements.file.files[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) {
    alert('单个文件请控制在 20 MB 以内。');
    return;
  }
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    await saveTemplate({
      id: globalThis.crypto?.randomUUID?.() || String(Date.now()),
      title: data.title.trim(),
      category: data.category,
      taxSubcategory: data.category === 'tax' ? data.taxSubcategory : '',
      description: data.description.trim(),
      file,
      fileName: file.name,
      createdAt: new Date().toISOString()
    });
    form.reset();
    categoryInput.value = new URLSearchParams(window.location.search).get('category') === 'tax' ? 'tax' : 'industry';
    subcategoryInput.value = new URLSearchParams(window.location.search).get('subcategory') || 'importExport';
    syncSubcategoryControls();
    await renderTemplates();
  } catch (error) {
    alert('导入失败：' + error.message);
  }
});

categoryInput.addEventListener('change', syncSubcategoryControls);
filter.addEventListener('change', () => {
  syncSubcategoryControls();
  renderTemplates();
});
subcategoryFilter.addEventListener('change', renderTemplates);
search.addEventListener('input', renderTemplates);
previewClose.addEventListener('click', closePreview);
previewDialog.addEventListener('close', clearPreview);
previewDialog.addEventListener('click', (event) => {
  if (event.target === previewDialog) closePreview();
});
const requestedCategory = new URLSearchParams(window.location.search).get('category');
const requestedSubcategory = new URLSearchParams(window.location.search).get('subcategory');
if (requestedCategory === 'industry' || requestedCategory === 'tax') {
  categoryInput.value = requestedCategory;
  filter.value = requestedCategory;
}
if (subcategoryName[requestedSubcategory]) {
  subcategoryInput.value = requestedSubcategory;
  subcategoryFilter.value = requestedSubcategory;
}
syncSubcategoryControls();
renderTemplates();
