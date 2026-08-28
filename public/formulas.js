const formulaGroups = [
  ['盈利与利润类公式', [
    ['营业收入', '营业收入 = 主营业务收入 + 其他业务收入'], ['营业成本', '营业成本 = 主营业务成本 + 其他业务成本'], ['毛利', '毛利 = 营业收入 - 营业成本'], ['毛利率', '毛利率 = （毛利 ÷ 营业收入）× 100%'], ['利润总额', '利润总额 = 营业利润 + 营业外收入 - 营业外支出'], ['净利润', '净利润 = 利润总额 - 所得税费用'], ['销售净利率', '销售净利率 = （净利润 ÷ 营业收入）× 100%'], ['营业利润率', '营业利润率 = （营业利润 ÷ 营业收入）× 100%'], ['每股收益（EPS）', '每股收益（EPS）= 归属于普通股股东的净利润 ÷ 发行在外普通股加权平均数'], ['市盈率（PE）', '市盈率（PE）= 每股市价 ÷ 每股收益']
  ]],
  ['短期偿债能力类公式', [
    ['营运资金', '营运资金 = 流动资产 - 流动负债'], ['流动比率', '流动比率 = 流动资产 ÷ 流动负债'], ['现金资产', '现金资产 = 货币资金 + 交易性金融资产'], ['现金比率', '现金比率 = 现金资产 ÷ 流动负债'], ['现金流量比率', '现金流量比率 = 经营活动现金流量净额 ÷ 流动负债'], ['到期债务本息偿付比率', '到期债务本息偿付比率 = 经营活动现金流量净额 ÷ （本期到期债务本金 + 现金利息支出）'], ['营运资本配置比率', '营运资本配置比率 = 营运资金 ÷ 流动资产 × 100%']
  ]],
  ['长期偿债能力类公式', [
    ['资产负债率', '资产负债率 = （负债总额 ÷ 资产总额）× 100%'], ['产权比率', '产权比率 = （负债总额 ÷ 所有者权益）× 100%'], ['权益乘数', '权益乘数 = 资产总额 ÷ 所有者权益总额 = 1 ÷ （1 - 资产负债率）'], ['长期资本负债率', '长期资本负债率 = 非流动负债 ÷ （非流动负债 + 所有者权益）× 100%'], ['现金流量债务比', '现金流量债务比 = 经营活动现金流量净额 ÷ 债务总额 × 100%'], ['有形净值债务率', '有形净值债务率 = 负债总额 ÷ （所有者权益 - 无形资产净值）× 100%'], ['带息负债比率', '带息负债比率 = 带息负债总额 ÷ 负债总额 × 100%'], ['或有负债比率', '或有负债比率 = 或有负债余额 ÷ 所有者权益总额 × 100%']
  ]],
  ['营运效率类公式', [
    ['流动资产平均余额', '流动资产平均余额 = （期初流动资产 + 期末流动资产）÷ 2'], ['流动资产周转率', '流动资产周转率 = 营业收入 ÷ 流动资产平均余额'], ['营运资金平均余额', '营运资金平均余额 = （期初营运资金 + 期末营运资金）÷ 2'], ['营运资金周转率', '营运资金周转率 = 营业收入 ÷ 营运资金平均余额'], ['总资产平均余额', '总资产平均余额 = （期初资产总额 + 期末资产总额）÷ 2'], ['总资产周转率', '总资产周转率 = 营业收入 ÷ 总资产平均余额']
  ]],
  ['现金流质量类公式', [
    ['经营活动现金流量净额', '经营活动现金流量净额 = 经营现金流入 - 经营现金流出'], ['投资活动现金流量净额', '投资活动现金流量净额 = 投资现金流入 - 投资现金流出'], ['筹资活动现金流量净额', '筹资活动现金流量净额 = 筹资现金流入 - 筹资现金流出'], ['营业现金比率', '营业现金比率 = 经营活动现金流量净额 ÷ 营业收入'], ['净利润现金比率', '净利润现金比率 = 经营活动现金流量净额 ÷ 净利润'], ['全部资产现金回收率', '全部资产现金回收率 = 经营活动现金流量净额 ÷ 平均总资产 × 100%'], ['现金股利保障倍数', '现金股利保障倍数 = 每股经营活动现金流量 ÷ 每股现金股利'], ['净收益营运指数', '净收益营运指数 = 经营净收益 ÷ 净利润'], ['现金营运指数', '现金营运指数 = 经营活动现金流量净额 ÷ 经营所得现金']
  ]],
  ['成长能力类公式', [
    ['营业收入增长率', '营业收入增长率 = （本期营业收入 - 上期营业收入）÷ 上期营业收入 × 100%'], ['营业收入三年复合增长率', '营业收入三年复合增长率 = [（本期营业收入 ÷ 三年前营业收入）^(1/3) - 1] × 100%'], ['净利润增长率', '净利润增长率 = （本期净利润 - 上期净利润）÷ 上期净利润 × 100%'], ['净利润三年复合增长率', '净利润三年复合增长率 = [（本期净利润 ÷ 三年前净利润）^(1/3) - 1] × 100%'], ['总资产增长率', '总资产增长率 = （本期资产总额 - 上期资产总额）÷ 上期资产总额 × 100%'], ['净资产增长率', '净资产增长率 = （本期所有者权益 - 上期所有者权益）÷ 上期所有者权益 × 100%'], ['营业利润增长率', '营业利润增长率 = （本期营业利润 - 上期营业利润）÷ 上期营业利润 × 100%']
  ]],
  ['成本与本量利分析类', [
    ['总成本', '总成本 = 固定成本总额 + 变动成本总额 = 固定成本总额 + （单位变动成本 × 业务量）'], ['边际贡献总额', '边际贡献总额 = 销售收入总额 - 变动成本总额'], ['单位边际贡献', '单位边际贡献 = 单价 - 单位变动成本'], ['边际贡献率', '边际贡献率 = （边际贡献总额 ÷ 销售收入总额）× 100%'], ['变动成本率', '变动成本率 = （变动成本总额 ÷ 销售收入总额）× 100% = 1 - 边际贡献率'], ['保本点销售量', '保本点销售量 = 固定成本总额 ÷ （单价 - 单位变动成本）= 固定成本 ÷ 单位边际贡献'], ['保本点销售额', '保本点销售额 = 保本点销售量 × 单价 = 固定成本总额 ÷ 边际贡献率'], ['保本作业率', '保本作业率 = 保本点销售量 ÷ 实际（或预计）销售量 × 100%'], ['安全边际量', '安全边际量 = 实际（预计）销售量 - 保本点销售量'], ['安全边际额', '安全边际额 = 实际（预计）销售额 - 保本点销售额'], ['安全边际率', '安全边际率 = 安全边际量 ÷ 实际（预计）销售量 × 100%'], ['敏感系数', '敏感系数 = 利润变动百分比 ÷ 因素变动百分比'], ['销售成本率', '销售成本率 = 销售成本 ÷ 销售收入 × 100%'], ['期间费用率', '期间费用率 = 期间费用总额 ÷ 营业收入 × 100%'], ['销售费用率', '销售费用率 = 销售费用 ÷ 营业收入 × 100%'], ['管理费用率', '管理费用率 = 管理费用 ÷ 营业收入 × 100%'], ['财务费用率', '财务费用率 = 财务费用 ÷ 营业收入 × 100%']
  ]],
  ['综合分析常用公式', [
    ['管理用报表权益净利率', '管理用报表权益净利率 = 净经营资产净利率 + （净经营资产净利率 - 税后利息率）× 净财务杠杆'], ['营业现金毛流量', '营业现金毛流量 = 税后经营净利润 + 折旧与摊销'], ['营业现金净流量', '营业现金净流量 = 营业现金毛流量 - 经营营运资本增加'], ['实体现金流量', '实体现金流量 = 营业现金净流量 - 资本支出'], ['股权现金流量', '股权现金流量 = 实体现金流量 - 债务现金流量'], ['月末一次加权平均单位成本', '月末一次加权平均单位成本 = （月初存货成本 + 本月购入存货总成本）÷ （月初存货数量 + 本月购入存货总数量）'], ['移动加权平均单位成本', '移动加权平均单位成本 = （原有库存存货成本 + 本次进货成本）÷ （原有库存存货数量 + 本次进货数量）']
  ]]
];

const categoryNav = document.querySelector('#formula-categories');
const groupsNode = document.querySelector('#formula-groups');
const search = document.querySelector('#formula-search');
const count = document.querySelector('#formula-count');
let activeCategory = '';

function makeElement(tag, text, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function renderCategories() {
  categoryNav.replaceChildren();
  [['', '全部分类'], ...formulaGroups.map(([name]) => [name, name])].forEach(([key, label]) => {
    const button = makeElement('button', label);
    button.type = 'button';
    button.classList.toggle('active', activeCategory === key);
    button.addEventListener('click', () => { activeCategory = key; renderCategories(); renderFormulas(); });
    categoryNav.append(button);
  });
}

function renderFormulas() {
  const keyword = search.value.trim().toLowerCase();
  const groups = formulaGroups.map(([name, formulas]) => [name, formulas.filter(([title, formula]) => (!keyword || (title + formula).toLowerCase().includes(keyword)))])
    .filter(([name, formulas]) => (!activeCategory || name === activeCategory) && formulas.length);
  const formulaCount = groups.reduce((total, [, formulas]) => total + formulas.length, 0);
  count.textContent = keyword || activeCategory ? '找到 ' + formulaCount + ' 条公式' : '71 条公式 · 8 个分类';
  groupsNode.replaceChildren();
  if (!groups.length) {
    groupsNode.append(makeElement('p', '未找到匹配公式，请更换关键词。', 'formula-empty'));
    return;
  }
  let index = 0;
  groups.forEach(([name, formulas]) => {
    const section = document.createElement('section');
    section.className = 'formula-group';
    section.append(makeElement('h2', name));
    const grid = document.createElement('div');
    grid.className = 'formula-grid';
    formulas.forEach(([title, formula]) => {
      index += 1;
      const card = document.createElement('article');
      card.className = 'formula-card';
      const titleLine = document.createElement('div');
      titleLine.append(makeElement('span', String(index).padStart(2, '0'), 'formula-number'), makeElement('h3', title));
      card.append(titleLine, makeElement('p', formula));
      grid.append(card);
    });
    section.append(grid);
    groupsNode.append(section);
  });
}

search.addEventListener('input', renderFormulas);
renderCategories();
renderFormulas();
