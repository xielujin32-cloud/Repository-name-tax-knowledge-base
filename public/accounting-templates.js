const storageKey = 'finance-workbench-accounting-templates';
const form = document.querySelector('#accounting-template-form');
const list = document.querySelector('#accounting-template-list');
const search = document.querySelector('#template-search');
const count = document.querySelector('#template-count');
const standardSearch = document.querySelector('#standard-subject-search');
const standardList = document.querySelector('#standard-subject-list');
const standardCount = document.querySelector('#standard-subject-count');
const smallBusinessSubjects = [
  ['资产', '1001', '库存现金'], ['资产', '1002', '银行存款'], ['资产', '1012', '其他货币资金'], ['资产', '1101', '短期投资'],
  ['资产', '1121', '应收票据'], ['资产', '1122', '应收账款'], ['资产', '1123', '预付账款'], ['资产', '1131', '应收股利'],
  ['资产', '1132', '应收利息'], ['资产', '1221', '其他应收款'], ['资产', '1401', '材料采购'], ['资产', '1402', '在途物资'],
  ['资产', '1403', '原材料'], ['资产', '1404', '材料成本差异'], ['资产', '1405', '库存商品'], ['资产', '1407', '商品进销差价'],
  ['资产', '1408', '委托加工物资'], ['资产', '1411', '周转材料'], ['资产', '1421', '消耗性生物资产'], ['资产', '1501', '长期债券投资'],
  ['资产', '1511', '长期股权投资'], ['资产', '1601', '固定资产'], ['资产', '1602', '累计折旧'], ['资产', '1604', '在建工程'],
  ['资产', '1605', '工程物资'], ['资产', '1606', '固定资产清理'], ['资产', '1621', '生产性生物资产'], ['资产', '1622', '生产性生物资产累计折旧'],
  ['资产', '1701', '无形资产'], ['资产', '1702', '累计摊销'], ['资产', '1801', '长期待摊费用'], ['资产', '1901', '待处理财产损溢'],
  ['负债', '2001', '短期借款'], ['负债', '2201', '应付票据'], ['负债', '2202', '应付账款'], ['负债', '2203', '预收账款'],
  ['负债', '2211', '应付职工薪酬'], ['负债', '2221', '应交税费'], ['负债', '2231', '应付利息'], ['负债', '2232', '应付利润'],
  ['负债', '2241', '其他应付款'], ['负债', '2401', '递延收益'], ['负债', '2501', '长期借款'], ['负债', '2701', '长期应付款'],
  ['权益', '3001', '实收资本'], ['权益', '3002', '资本公积'], ['权益', '3101', '盈余公积'], ['权益', '3103', '本年利润'], ['权益', '3104', '利润分配'],
  ['成本与存货', '4001', '生产成本'], ['成本与存货', '4101', '制造费用'], ['成本与存货', '4301', '研发支出'], ['成本与存货', '4401', '工程施工'], ['成本与存货', '4403', '机械作业'],
  ['收入', '5001', '主营业务收入'], ['收入', '5051', '其他业务收入'], ['收入', '5111', '投资收益'], ['收入', '5301', '营业外收入'],
  ['成本与存货', '5401', '主营业务成本'], ['成本与存货', '5402', '其他业务成本'], ['税费', '5403', '营业税金及附加'],
  ['期间费用', '5601', '销售费用'], ['期间费用', '5602', '管理费用'], ['期间费用', '5603', '财务费用'],
  ['其他', '5711', '营业外支出'], ['税费', '5801', '所得税费用']
];

function loadTemplates() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveTemplates(templates) {
  localStorage.setItem(storageKey, JSON.stringify(templates));
}

function textElement(tag, text, className) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function addDetail(card, label, value) {
  if (!value) return;
  const detail = document.createElement('p');
  detail.className = 'template-detail';
  detail.append(textElement('strong', label + '：'), document.createTextNode(value));
  card.append(detail);
}

function renderTemplates() {
  const keyword = search.value.trim().toLowerCase();
  const templates = loadTemplates();
  const matches = templates.filter((item) => Object.values(item).join(' ').toLowerCase().includes(keyword));
  count.textContent = templates.length + ' 个模板';
  list.innerHTML = '';

  if (!matches.length) {
    list.append(textElement('p', keyword ? '没有匹配的会计模板。' : '尚未保存模板。请从左侧录入第一条常用分录。', 'template-empty'));
    return;
  }

  matches.forEach((item) => {
    const card = document.createElement('article');
    card.className = 'accounting-template-card';
    const head = document.createElement('div');
    head.className = 'template-card-head';
    const heading = document.createElement('div');
    heading.append(textElement('h3', item.title), textElement('span', item.category || '未分类', 'template-category'));
    const remove = textElement('button', '删除', 'template-remove');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      if (!confirm('确定删除“' + item.title + '”吗？')) return;
      saveTemplates(loadTemplates().filter((template) => template.id !== item.id));
      renderTemplates();
    });
    head.append(heading, remove);
    card.append(head);
    addDetail(card, '会计准则 / 制度', item.standard);
    addDetail(card, '业务场景', item.scenario);
    const entry = document.createElement('div');
    entry.className = 'template-entry';
    entry.append(textElement('strong', '借：' + item.debitAccount), textElement('span', item.debitNote || ''));
    entry.append(textElement('strong', '贷：' + item.creditAccount), textElement('span', item.creditNote || ''));
    card.append(entry);
    addDetail(card, '税务口径 / 依据', item.taxBasis);
    addDetail(card, '复核备注', item.notes);
    list.append(card);
  });
}

function renderStandardSubjects() {
  const keyword = standardSearch.value.trim().toLowerCase();
  const subjects = smallBusinessSubjects.filter((item) => item.join(' ').toLowerCase().includes(keyword));
  standardCount.textContent = '显示 ' + subjects.length + ' / 66 个科目';
  standardList.innerHTML = '';
  const groups = new Map();
  subjects.forEach((subject) => {
    const group = groups.get(subject[0]) || [];
    group.push(subject);
    groups.set(subject[0], group);
  });
  groups.forEach((subjectsInGroup, category) => {
    const section = document.createElement('section');
    section.className = 'subject-group';
    section.append(textElement('h3', category + '类'));
    const items = document.createElement('div');
    items.className = 'subject-items';
    subjectsInGroup.forEach(([, code, name]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.append(textElement('small', code), document.createTextNode(name));
      button.addEventListener('click', () => {
        form.elements.standard.value = '小企业会计准则｜' + code + ' ' + name;
        if (!form.elements.debitAccount.value) form.elements.debitAccount.value = code + ' ' + name;
        if ([...form.elements.category.options].some((option) => option.value === category)) form.elements.category.value = category;
        form.elements.title.focus();
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      items.append(button);
    });
    section.append(items);
    standardList.append(section);
  });
  if (!subjects.length) standardList.append(textElement('p', '没有匹配的会计科目。', 'template-empty'));
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  const templates = loadTemplates();
  templates.unshift({
    id: globalThis.crypto?.randomUUID?.() || String(Date.now()),
    ...data,
    createdAt: new Date().toISOString()
  });
  saveTemplates(templates);
  form.reset();
  renderTemplates();
});

search.addEventListener('input', renderTemplates);
standardSearch.addEventListener('input', renderStandardSubjects);
renderTemplates();
renderStandardSubjects();
