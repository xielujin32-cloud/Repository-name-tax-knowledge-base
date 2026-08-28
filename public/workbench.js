const money = new Intl.NumberFormat('zh-CN', {
  style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 2
});

const personalRates = [
  [36000, 0.03, 0, '第一级'], [144000, 0.1, 2520, '第二级'], [300000, 0.2, 16920, '第三级'],
  [420000, 0.25, 31920, '第四级'], [660000, 0.3, 52920, '第五级'], [960000, 0.35, 85920, '第六级'],
  [Infinity, 0.45, 181920, '第七级']
];
const businessRates = [
  [30000, 0.05, 0, '第一级'], [90000, 0.1, 1500, '第二级'], [300000, 0.2, 10500, '第三级'],
  [500000, 0.3, 40500, '第四级'], [Infinity, 0.35, 65500, '第五级']
];
const filingDeadlines2026 = [20, 24, 16, 20, 22, 15, 15, 17, 15, 26, 16, 15];

const formatPercent = (value) => (value * 100).toFixed(value * 100 % 1 ? 2 : 0) + '%';
const safeNumber = (value) => Math.max(Number(value) || 0, 0);
const rateFor = (rates, income) => rates.find((item) => income <= item[0]) || rates[rates.length - 1];
const field = (key, label, type, value, options, hint) => ({ key, label, type, value, options, hint });

function renderCalendar() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const today = now.getDate();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const calendar = document.querySelector('#month-calendar');
  if (!calendar) return;
  document.querySelector('#calendar-year').textContent = String(year);
  document.querySelector('#dashboard-date').textContent = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  }).format(now);
  const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
  const blanks = Array.from({ length: firstDay }, () => '<span class="outside"></span>').join('');
  const days = Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    return '<span class="' + (day === today ? 'today' : '') + '">' + day + '</span>';
  }).join('');
  calendar.innerHTML = '<div class="calendar-month-label">' + year + '年' + (month + 1) + '月</div>'
    + '<div class="calendar-weekdays">' + weekDays.map((day) => '<span>' + day + '</span>').join('') + '</div>'
    + '<div class="calendar-days">' + blanks + days + '</div>';
  document.querySelector('#annual-reminder-list').innerHTML = Array.from({ length: 12 }, (_, index) => {
    const active = index === month;
    const deadline = new Date(2026, index, filingDeadlines2026[index]);
    const dateLabel = String(index + 1).padStart(2, '0') + '-' + String(filingDeadlines2026[index]).padStart(2, '0');
    const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(deadline).replace('周', '周');
    return '<p class="' + (active ? 'current' : '') + '"><span>' + (index + 1) + '月</span><span>'
      + dateLabel + ' ' + weekday + '</span></p>';
  }).join('');
  const monthlyTitle = document.querySelector('#monthly-filing-title');
  const monthlyDetail = document.querySelector('#monthly-filing-detail');
  if (year === 2026) {
    const deadline = new Date(2026, month, filingDeadlines2026[month]);
    const start = new Date(year, month, today);
    start.setHours(0, 0, 0, 0);
    deadline.setHours(0, 0, 0, 0);
    const daysLeft = Math.ceil((deadline - start) / 86400000);
    const label = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(filingDeadlines2026[month]).padStart(2, '0');
    monthlyTitle.textContent = (month + 1) + '月报税 → 截止 ' + label;
    monthlyDetail.textContent = daysLeft >= 0
      ? '距截止日还有 ' + daysLeft + ' 天。依据：税总办征科函〔2025〕64号。'
      : '本月申报期限已过，请以电子税务局和主管税务机关通知为准。';
  } else {
    monthlyTitle.textContent = '本月报税提醒';
    monthlyDetail.textContent = '2026年度截止日已按税总办征科函〔2025〕64号列示；其他年度请以最新通知为准。';
  }
}

const taxConfigs = {
  personal: {
    label: '个人所得税',
    fields: () => [
      field('mode', '计税方式', 'select', 'monthly', [['monthly', '工资薪金累计预扣'], ['annual', '年度综合所得']]),
      field('months', '累计月份', 'select', String(new Date().getMonth() + 1), Array.from({ length: 12 }, (_, i) => [String(i + 1), '累计 ' + (i + 1) + ' 个月'])),
      field('income', '累计工资薪金 / 全年综合所得收入', 'number', '', null, '月度模式请填写截至本月的累计金额。'),
      field('social', '专项扣除（三险一金等）', 'number', ''),
      field('special', '专项附加扣除及其他扣除', 'number', ''),
      field('prepaid', '累计已预扣 / 已预缴税额', 'number', '')
    ],
    calculate(v) {
      const monthly = v.mode === 'monthly';
      const deduction = monthly ? Number(v.months) * 5000 : 60000;
      const taxable = Math.max(v.income - v.social - v.special - deduction, 0);
      const bracket = rateFor(personalRates, taxable);
      const gross = Math.max(taxable * bracket[1] - bracket[2], 0);
      const net = gross - v.prepaid;
      const amount = monthly ? Math.max(net, 0) : Math.abs(net);
      return {
        label: monthly ? '本期预计应预扣个人所得税' : net >= 0 ? '年度预计应补个人所得税' : '年度预计可退个人所得税',
        amount,
        lines: [['收入额', v.income], ['基本减除费用', deduction], ['专项扣除', v.social], ['专项附加及其他扣除', v.special], ['应纳税所得额', taxable], ['适用税率', formatPercent(bracket[1])], ['速算扣除数', bracket[2]], ['已预缴税额', v.prepaid]],
        formula: '应纳税所得额 = 收入 - 基本减除费用 - 专项扣除 - 专项附加及其他扣除。'
      };
    },
    info: ['个人所得税综合所得适用 3% 至 45% 七级超额累进税率。', 'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5196787/5196787/files/%E4%B8%AA%E4%BA%BA%E6%89%80%E5%BE%97%E7%A8%8E%E7%A8%8E%E7%8E%87%E8%A1%A8%EF%BC%88%E7%BB%BC%E5%90%88%E6%89%80%E5%BE%97%E9%80%82%E7%94%A8%EF%BC%89.pdf', '查看个人所得税税率表'],
    rateTable: {
      title: '个人所得税税率表（综合所得适用）',
      rows: [['1', '不超过 36,000 元', '3%', '0'], ['2', '超过 36,000 元至 144,000 元', '10%', '2,520'], ['3', '超过 144,000 元至 300,000 元', '20%', '16,920'], ['4', '超过 300,000 元至 420,000 元', '25%', '31,920'], ['5', '超过 420,000 元至 660,000 元', '30%', '52,920'], ['6', '超过 660,000 元至 960,000 元', '35%', '85,920'], ['7', '超过 960,000 元', '45%', '181,920']]
    }
  },
  vat: {
    label: '增值税及附加税费',
    fields: () => [
      field('taxpayer', '纳税人类型', 'select', 'small', [['small', '增值税小规模纳税人'], ['general', '增值税一般纳税人']]),
      field('period', '申报周期', 'select', 'quarterly', [['monthly', '按月申报（10万元）'], ['quarterly', '按季申报（30万元）']]),
      field('priceMode', '销售额口径', 'select', 'exclusive', [['exclusive', '不含税销售额'], ['inclusive', '含税销售额']]),
      field('sales', '本期销售额', 'number', '', null, '小规模纳税人起征点按不含税销售额判断。'),
      field('rate', '适用税率 / 征收率', 'select', '0.01', [['0.01', '1%（小规模）'], ['0.03', '3%（小规模）'], ['0.13', '13%'], ['0.09', '9%'], ['0.06', '6%']]),
      field('inputTax', '可抵扣进项税额', 'number', '', null, '一般纳税人按实际可抵扣金额填写。'),
      field('reduction', '减免税额', 'number', ''),
      field('urbanRate', '城建税适用地区', 'select', '0.07', [['0.07', '市区 7%'], ['0.05', '县城、镇 5%'], ['0.01', '其他地区 1%']]),
      field('relief', '附加税费减按 50%', 'select', 'no', [['no', '不适用'], ['yes', '符合条件，减按50%']]),
      field('exemption', '小规模起征点免税', 'select', 'yes', [['yes', '符合条件时自动免征'], ['no', '本期不适用']]),
      field('consumption', '本期实际缴纳消费税额', 'number', '')
    ],
    calculate(v) {
      const small = v.taxpayer === 'small';
      const requestedRate = Number(v.rate);
      const allowed = small ? [0.01, 0.03] : [0.13, 0.09, 0.06];
      const rate = allowed.includes(requestedRate) ? requestedRate : allowed[0];
      const sales = v.priceMode === 'inclusive' ? v.sales / (1 + rate) : v.sales;
      const threshold = v.period === 'monthly' ? 100000 : 300000;
      const exempt = small && v.exemption === 'yes' && sales < threshold;
      const vat = exempt ? 0 : Math.max(sales * rate - (small ? 0 : v.inputTax) - v.reduction, 0);
      const base = vat + v.consumption;
      const factor = v.relief === 'yes' ? 0.5 : 1;
      const urban = base * Number(v.urbanRate) * factor;
      const educationExempt = sales <= threshold;
      const education = educationExempt ? 0 : base * 0.03 * factor;
      const localEducation = educationExempt ? 0 : base * 0.02 * factor;
      const surcharge = urban + education + localEducation;
      return {
        label: '预计应纳增值税及附加税费',
        amount: vat + surcharge,
        lines: [['不含税销售额', sales], ['适用税率 / 征收率', formatPercent(rate)], ['增值税', vat], ['城建税', urban], ['教育费附加', education], ['地方教育附加', localEducation], ['附加税费合计', surcharge]],
        formula: exempt ? '销售额未达到所选申报周期起征点，按免征增值税测算。' : '增值税 = 销售额 × 税率 - 可抵扣进项税额 - 减免税额；附加税费以实际缴纳的增值税和消费税为基础测算。'
      };
    },
    info: ['小规模纳税人起征点与减按 1% 等政策有适用条件，请按实际业务确认。', 'https://zhejiang.chinatax.gov.cn/art/2026/2/2/art_8409_84403.html', '查看增值税优惠衔接公告']
  },
  enterprise: {
    label: '企业所得税',
    fields: () => [
      field('revenue', '累计营业收入', 'number', ''),
      field('cost', '累计成本费用', 'number', ''),
      field('increase', '纳税调整增加额', 'number', ''),
      field('decrease', '纳税调整减少额 / 弥补亏损', 'number', ''),
      field('entity', '企业类型 / 优惠口径', 'select', 'small', [['small', '小型微利企业（符合条件）'], ['standard', '一般企业 25%'], ['hightech', '高新技术企业 15%'], ['other20', '其他优惠税率 20%']]),
      field('restricted', '属于限制或禁止行业', 'select', 'no', [['no', '否'], ['yes', '是']]),
      field('employees', '从业人数（季度平均值）', 'number', '', null, '小型微利企业需同时满足人数、资产和所得额等条件。'),
      field('assets', '资产总额不超过 5,000 万元', 'select', 'yes', [['yes', '是'], ['no', '否']]),
      field('credit', '税收抵免及减免税额', 'number', ''),
      field('prepaid', '已预缴税额', 'number', '')
    ],
    calculate(v) {
      const taxable = Math.max(v.revenue - v.cost + v.increase - v.decrease, 0);
      const qualified = v.entity === 'small' && !v.employeesBlank && v.employees <= 300 && v.assets === 'yes' && v.restricted === 'no' && taxable <= 3000000;
      const base = v.entity === 'hightech' ? 0.15 : v.entity === 'other20' ? 0.2 : v.entity === 'small' && qualified ? 0.2 : 0.25;
      const incomeAfterPreference = qualified ? taxable * 0.25 : taxable;
      const gross = incomeAfterPreference * base;
      const afterCredit = Math.max(gross - v.credit, 0);
      const net = afterCredit - v.prepaid;
      return {
        label: net >= 0 ? '预计应补企业所得税' : '预计可退企业所得税',
        amount: Math.abs(net),
        lines: [['纳税调整后所得', taxable], ['适用口径', qualified ? '小型微利企业优惠' : v.entity === 'hightech' ? '高新技术企业' : v.entity === 'other20' ? '其他优惠税率' : '一般企业口径'], ['优惠后计税所得', incomeAfterPreference], ['适用税率', formatPercent(base)], ['税收抵免及减免', v.credit], ['已预缴税额', v.prepaid]],
        formula: '应纳税所得额 = 营业收入 - 成本费用 + 纳税调增 - 纳税调减或弥补亏损。'
      };
    },
    info: ['小型微利企业优惠需同时符合行业、年度应纳税所得额、从业人数和资产总额条件。', 'https://znhd.guangxi.chinatax.gov.cn/nsfw/nszx/rdwd/202605/t20260507_432838.html', '查看小型微利企业优惠说明']
  },
  property: {
    label: '房产税',
    fields: () => [
      field('mode', '计征方式', 'select', 'original', [['original', '从价计征'], ['rent', '从租计征']]),
      field('originalValue', '房产原值', 'number', ''),
      field('deductionRate', '原值扣除比例（%）', 'number', '30', null, '从价计征比例按房产所在地规定填写。'),
      field('rentIncome', '租金收入（不含增值税）', 'number', ''),
      field('rentRate', '从租适用税率', 'select', '0.12', [['0.12', '12%（一般出租）'], ['0.04', '4%（符合条件的住房出租）']]),
      field('relief', '“六税两费”减半优惠', 'select', 'no', [['no', '不适用'], ['yes', '符合条件，减按50%']])
    ],
    calculate(v) {
      const rent = v.mode === 'rent';
      const base = rent ? v.rentIncome : v.originalValue * (1 - Math.min(Math.max(v.deductionRate, 0), 100) / 100);
      const rate = rent ? Number(v.rentRate) : 0.012;
      const before = base * rate;
      const reduction = v.relief === 'yes' ? before * 0.5 : 0;
      return {
        label: '预计应纳房产税',
        amount: Math.max(before - reduction, 0),
        lines: [['计征方式', rent ? '从租计征' : '从价计征'], ['计税依据', base], ['适用税率', formatPercent(rate)], ['优惠前税额', before], ['减免税额', reduction]],
        formula: rent ? '房产税 = 不含税租金收入 × 适用税率。' : '房产税 = 房产原值 ×（1 - 原值扣除比例）× 1.2%。'
      };
    },
    info: ['房产税从价计征税率为 1.2%，从租计征一般为 12%；具体扣除比例和优惠以所在地规定为准。', 'https://tianjin.chinatax.gov.cn/11200000000/0300/030005/20221122165835769.shtml', '查看房产税税率说明']
  },
  business: {
    label: '经营所得税',
    fields: () => [
      field('income', '累计收入总额', 'number', ''),
      field('cost', '累计成本费用', 'number', ''),
      field('otherDeduction', '累计其他扣除及损失', 'number', ''),
      field('quarterDeduction', '累计基本减除费用', 'select', '60000', [['0', '不在经营所得中扣除'], ['15000', '第一季度：15,000元'], ['30000', '第二季度：30,000元'], ['45000', '第三季度：45,000元'], ['60000', '第四季度：60,000元']]),
      field('half', '个体工商户减半优惠', 'select', 'no', [['no', '不适用'], ['yes', '符合条件，减半征收']]),
      field('otherRelief', '其他政策减免税额', 'number', ''),
      field('prepaid', '已预缴税额', 'number', '')
    ],
    calculate(v) {
      const taxable = Math.max(v.income - v.cost - v.otherDeduction - Number(v.quarterDeduction), 0);
      const bracket = rateFor(businessRates, taxable);
      const base = Math.max(taxable * bracket[1] - bracket[2], 0);
      const otherRelief = Math.min(v.otherRelief, base);
      const eligibleTaxable = Math.min(taxable, 2000000);
      const eligibleRate = rateFor(businessRates, eligibleTaxable);
      const eligibleTax = Math.max(eligibleTaxable * eligibleRate[1] - eligibleRate[2], 0);
      const allocatedRelief = taxable > 0 ? otherRelief * eligibleTaxable / taxable : 0;
      const halfReduction = v.half === 'yes' ? Math.max(eligibleTax - allocatedRelief, 0) * 0.5 : 0;
      const gross = Math.max(base - otherRelief - halfReduction, 0);
      const net = gross - v.prepaid;
      return {
        label: net >= 0 ? '预计应补经营所得税' : '预计可退经营所得税',
        amount: Math.abs(net),
        lines: [['应纳税所得额', taxable], ['适用税率', formatPercent(bracket[1])], ['速算扣除数', bracket[2]], ['基础税额', base], ['其他政策减免', otherRelief], ['个体工商户减半额', halfReduction], ['已预缴税额', v.prepaid]],
        formula: '经营所得适用 5% 至 35% 五级超额累进税率。'
      };
    },
    info: ['经营所得适用 5% 至 35% 五级超额累进税率；是否可享优惠应根据实际主体和政策条件判断。', 'https://jiangsu.chinatax.gov.cn/art/2024/3/15/art_8353_453334.html', '查看经营所得税率说明'],
    rateTable: {
      title: '个人所得税税率表（经营所得适用）',
      rows: [['1', '不超过 30,000 元', '5%', '0'], ['2', '超过 30,000 元至 90,000 元', '10%', '1,500'], ['3', '超过 90,000 元至 300,000 元', '20%', '10,500'], ['4', '超过 300,000 元至 500,000 元', '30%', '40,500'], ['5', '超过 500,000 元', '35%', '65,500']]
    }
  },
  burden: {
    label: '税负率',
    fields: () => [
      field('industry', '所属行业（用于参考对照）', 'select', 'wholesale', [
        ['wholesale', '商业批发'], ['retail', '商业零售'], ['metal', '金属制品业'], ['nonmetal', '非金属矿物制品业'],
        ['agriFood', '农副食品加工'], ['food', '食品饮料'], ['textile', '纺织品（化纤）'], ['garment', '纺织服装、皮革羽毛（绒）及制品'],
        ['paper', '造纸及纸制品业'], ['building', '建材产品'], ['chemical', '化工产品'], ['pharma', '医药制造业'],
        ['plastic', '塑料制品业'], ['transport', '机械交通运输设备'], ['electronics', '电子通信设备'], ['arts', '工艺品及其他制造业'],
        ['electrical', '电气机械及器材'], ['power', '电力、热力的生产和供应业'], ['tobacco', '卷烟加工'], ['other', '其他']
      ]),
      field('revenue', '当期不含税营业收入', 'number', '', null, '建议按同一期间的利润表营业收入填写。'),
      field('vatTax', '当期实际应纳增值税', 'number', ''),
      field('incomeTax', '当期实际应纳企业所得税', 'number', ''),
      field('surcharge', '附加税费', 'number', ''),
      field('otherTaxes', '其他税费', 'number', '', null, '如印花税、房产税、城镇土地使用税等；按内部管理口径填写。')
    ],
    calculate(v) {
      const benchmarks = {
        wholesale: [0.004, 0.009, 0.05], retail: [0.01, 0.025, 0.09], metal: [0.006, 0.022, 0.08], nonmetal: [0.01, 0.055, 0.11],
        agriFood: [0.01, 0.035, 0.09], food: [0.025, 0.045, 0.098], textile: [0.015, 0.023, 0.063], garment: [0.02, 0.029, 0.088],
        paper: [0.01, 0.05, 0.11], building: [null, 0.0498, null], chemical: [0.006, 0.034, 0.09], pharma: [0.03, 0.085, 0.175],
        plastic: [0.03, 0.035, 0.08], transport: [0.015, 0.037, 0.09], electronics: [0.008, 0.027, 0.078], arts: [0.02, 0.035, 0.08],
        electrical: [0.02, 0.037, 0.09], power: [0.02, 0.05, 0.085], tobacco: [0.07, 0.125, 0.275], other: [0.014, 0.035, 0.105]
      };
      const industry = currentFields().find((item) => item.key === 'industry').options.find((item) => item[0] === v.industry)[1];
      const [referenceIncomeTax, referenceVat, referenceTotal] = benchmarks[v.industry];
      const totalTax = v.vatTax + v.incomeTax + v.surcharge + v.otherTaxes;
      const rate = v.revenue > 0 ? totalTax / v.revenue : 0;
      const vatRate = v.revenue > 0 ? v.vatTax / v.revenue : 0;
      const incomeTaxRate = v.revenue > 0 ? v.incomeTax / v.revenue : 0;
      const variance = referenceTotal === null ? '该行业未提供综合参考值' : (rate >= referenceTotal ? '高于' : '低于') + '行业参考值 ' + formatPercent(Math.abs(rate - referenceTotal));
      return {
        label: '综合税负率',
        amount: totalTax,
        amountText: formatPercent(rate),
        lines: [['所属行业', industry], ['当期税费合计', totalTax], ['增值税税负率', formatPercent(vatRate)], ['企业所得税税负率', formatPercent(incomeTaxRate)], ['参考：企业所得税税负率', referenceIncomeTax === null ? '未提供' : formatPercent(referenceIncomeTax)], ['参考：增值税税负率', formatPercent(referenceVat)], ['参考：行业税负率（平均数）', referenceTotal === null ? '未提供' : formatPercent(referenceTotal)], ['与行业综合参考值对比', variance]],
        formula: '综合税负率 = 当期各项实际应纳税费合计 ÷ 当期不含税营业收入。请确保收入与税费属于同一核算期间。'
      };
    },
    info: ['行业参考值来自您导入的“各行业税负率及毛利率参考”图片，共 20 个行业。该表仅作内部分析和预警参考，不代表法定税率、征管口径或申报结论。', '', '']
  }
};

const requestedTax = new URLSearchParams(window.location.search).get('tax');
let activeTax = taxConfigs[requestedTax] ? requestedTax : 'personal';
const taxForm = document.querySelector('#tax-tool-form');
const taxFields = document.querySelector('#tax-tool-fields');
const taxResultLabel = document.querySelector('#tax-result-label');
const taxResultAmount = document.querySelector('#tax-result-amount');
const taxResultLines = document.querySelector('#tax-result-lines');
const taxResultFormula = document.querySelector('#tax-result-formula');
const taxInfo = document.querySelector('#tax-tool-info');

function currentFields() {
  const fields = taxConfigs[activeTax].fields;
  return typeof fields === 'function' ? fields() : fields;
}

function makeControl(definition) {
  const input = document.createElement(definition.type === 'select' ? 'select' : 'input');
  input.name = definition.key;
  input.id = 'tax-' + definition.key;
  if (definition.type === 'select') {
    definition.options.forEach(([value, text]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      option.selected = String(value) === String(definition.value);
      input.append(option);
    });
  } else {
    input.type = 'number';
    input.min = '0';
    input.step = '0.01';
    input.value = definition.value;
    input.placeholder = '请输入金额';
  }
  input.addEventListener('input', calculateTax);
  input.addEventListener('change', () => {
    if (activeTax === 'vat' && input.name === 'taxpayer') {
      const rate = taxForm.elements.rate;
      const validRates = input.value === 'small' ? ['0.01', '0.03'] : ['0.13', '0.09', '0.06'];
      if (!validRates.includes(rate.value)) rate.value = validRates[0];
    }
    calculateTax();
  });
  return input;
}

function renderTaxForm() {
  if (!taxFields) return;
  taxFields.innerHTML = '';
  currentFields().forEach((definition) => {
    const row = document.createElement('label');
    row.className = 'tax-field' + (definition.hint ? ' has-hint' : '');
    const name = document.createElement('span');
    name.textContent = definition.label;
    row.append(name, makeControl(definition));
    if (definition.hint) {
      const hint = document.createElement('small');
      hint.textContent = definition.hint;
      row.append(hint);
    }
    taxFields.append(row);
  });
  renderTaxInfo();
  calculateTax();
}

function readTaxValues() {
  return currentFields().reduce((result, definition) => {
    const control = taxForm.elements[definition.key];
    if (definition.type === 'select') result[definition.key] = control.value;
    else {
      result[definition.key] = safeNumber(control.value);
      result[definition.key + 'Blank'] = control.value.trim() === '';
    }
    return result;
  }, {});
}

function renderTaxInfo() {
  const config = taxConfigs[activeTax];
  const info = config.info;
  const rateTable = config.rateTable
    ? '<section class="tax-rate-reference"><h4>' + config.rateTable.title + '</h4><table class="tax-rate-reference-table"><thead><tr><th>级数</th><th>全年应纳税所得额</th><th>税率</th><th>速算扣除数</th></tr></thead><tbody>' + config.rateTable.rows.map((row) => '<tr>' + row.map((cell) => '<td>' + cell + '</td>').join('') + '</tr>').join('') + '</tbody></table></section>'
    : '';
  taxInfo.innerHTML = '<strong>基础口径提示</strong><p>' + info[0] + '</p>' + (info[1] ? '<a href="' + info[1] + '" target="_blank" rel="noreferrer">' + info[2] + ' ↗</a>' : '') + rateTable;
}

function calculateTax() {
  if (!taxForm) return;
  const result = taxConfigs[activeTax].calculate(readTaxValues());
  taxResultLabel.textContent = result.label;
  taxResultAmount.textContent = result.amountText || money.format(result.amount);
  taxResultLines.innerHTML = result.lines.map(([label, value]) => '<div><span>' + label + '</span><strong>' + (typeof value === 'number' ? money.format(value) : value) + '</strong></div>').join('');
  taxResultFormula.textContent = result.formula;
}

function syncTaxTabs() {
  document.querySelectorAll('[data-tax-tool]').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.taxTool === activeTax);
  });
}

document.querySelectorAll('[data-tax-tool]').forEach((tab) => {
  tab.addEventListener('click', () => {
    activeTax = tab.dataset.taxTool;
    syncTaxTabs();
    renderTaxForm();
  });
});
document.querySelector('#tax-tool-reset')?.addEventListener('click', renderTaxForm);

const toolSearch = document.querySelector('#tool-search');
toolSearch?.addEventListener('input', () => {
  const keyword = toolSearch.value.trim().toLowerCase();
  document.querySelectorAll('[data-search-card]').forEach((card) => {
    card.hidden = Boolean(keyword) && !card.textContent.toLowerCase().includes(keyword);
  });
});

renderCalendar();
syncTaxTabs();
renderTaxForm();
