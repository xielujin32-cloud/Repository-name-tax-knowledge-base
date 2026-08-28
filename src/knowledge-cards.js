const REVIEWED_AT = '2026-08-27T00:00:00.000Z';

const sources = {
  individualIncomeTax: {
    title: '中华人民共和国个人所得税法',
    authority: '全国人民代表大会常务委员会',
    url: 'https://www.chinatax.gov.cn/n810219/n810744/n3752930/n3752974/c3970366/content.html'
  },
  withholding: {
    title: '国家税务总局关于发布《个人所得税扣缴申报管理办法（试行）》的公告',
    authority: '国家税务总局',
    url: 'https://fgk.chinatax.gov.cn/zcfgk/c100015/c5200946/content.html'
  },
  annualBonus: {
    title: '财政部 税务总局关于延续实施全年一次性奖金个人所得税政策的公告',
    authority: '财政部、国家税务总局',
    url: 'https://guizhou.chinatax.gov.cn/wjjb/zcfgk/szfl/qt/202312/P020250816489906314520.pdf'
  },
  vat: {
    title: '中华人民共和国增值税法',
    authority: '全国人民代表大会常务委员会',
    url: 'https://www.npc.gov.cn/npc/c2/c30834/202412/t20241225_442038.html'
  },
  enterpriseIncomeTax: {
    title: '中华人民共和国企业所得税法',
    authority: '全国人民代表大会常务委员会',
    url: 'https://www.gov.cn/flfg/2007-03/16/content_552149.htm'
  },
  enterpriseIncomeTaxRegulation: {
    title: '中华人民共和国企业所得税法实施条例',
    authority: '国务院',
    url: 'https://www.chinatax.gov.cn/n810341/n810765/n812176/n812748/c1193046/content.html'
  },
  educationExpense: {
    title: '财政部 税务总局关于企业职工教育经费税前扣除政策的通知',
    authority: '财政部、国家税务总局',
    url: 'https://jiangsu.chinatax.gov.cn/col/col9672/index.html'
  },
  stamp: {
    title: '中华人民共和国印花税法',
    authority: '全国人民代表大会常务委员会',
    url: 'https://www.gov.cn/xinwen/2021-06/10/content_5616879.htm'
  },
  property: {
    title: '中华人民共和国房产税暂行条例',
    authority: '国务院',
    url: 'https://xzfg.moj.gov.cn/law/download?LawID=764&t=1778305494270&type=pdf'
  },
  urbanLand: {
    title: '中华人民共和国城镇土地使用税暂行条例',
    authority: '国务院',
    url: 'https://xzfg.moj.gov.cn/law/download?LawID=808&t=1778204396842&type=pdf'
  },
  deed: {
    title: '中华人民共和国契税法',
    authority: '全国人民代表大会常务委员会',
    url: 'https://shanghai.chinatax.gov.cn/zcfw/zcfgk/qs/202008/t454991.html'
  },
  landAppreciation: {
    title: '中华人民共和国土地增值税暂行条例',
    authority: '国务院',
    url: 'https://jdjc.mof.gov.cn/fgzd/202202/t20220209_3786568.htm'
  }
};

const comprehensiveRates = [
  ['不超过 36,000 元', '3%', '0'], ['36,000–144,000 元', '10%', '2,520'], ['144,000–300,000 元', '20%', '16,920'],
  ['300,000–420,000 元', '25%', '31,920'], ['420,000–660,000 元', '30%', '52,920'], ['660,000–960,000 元', '35%', '85,920'], ['超过 960,000 元', '45%', '181,920']
];

function rates(rows) {
  return rows.map(([bracket, rate, quickDeduction]) => ({ bracket, rate, quickDeduction }));
}

function card(id, fields) {
  return {
    id,
    regionScope: '全国通用基础规则',
    status: 'published',
    version: 1,
    createdAt: REVIEWED_AT,
    updatedAt: REVIEWED_AT,
    publishedAt: REVIEWED_AT,
    verifiedAt: REVIEWED_AT,
    versions: [],
    ...fields
  };
}

export const DEFAULT_KNOWLEDGE_CARDS = [
  card('knowledge-iit-salary-withholding', {
    taxType: '个人所得税', topic: '工资薪金累计预扣', priority: 100,
    keywords: ['个人所得税', '工资', '薪金', '累计预扣', '预扣预缴', '专项附加扣除'],
    formula: '本期应预扣税额 = （累计预扣预缴应纳税所得额 × 预扣率 − 速算扣除数）− 累计已预扣税额。',
    rateTable: rates(comprehensiveRates),
    conditions: ['适用于居民个人取得工资、薪金所得的按月预扣预缴。', '累计应纳税所得额通常为累计收入减累计减除费用、专项扣除、专项附加扣除和依法确定的其他扣除。', '累计减除费用按 5,000 元/月计算；具体扣除资料应按规定留存或报送。'],
    example: '示例：累计应纳税所得额为 50,000 元、累计已预扣 1,080 元，则累计应纳税额为 50,000×10%−2,520=2,480 元，本月应预扣 1,400 元。',
    effectiveAt: '2019-01-01', officialBases: [sources.withholding, sources.individualIncomeTax]
  }),
  card('knowledge-iit-annual-settlement', {
    taxType: '个人所得税', topic: '综合所得年度汇算', priority: 99,
    keywords: ['个人所得税', '综合所得', '年度汇算', '汇算清缴', '工资', '劳务报酬', '稿酬', '特许权使用费'],
    formula: '年度应纳税额 = （全年综合所得收入额 − 60,000 元 − 专项扣除 − 专项附加扣除 − 其他依法扣除）× 适用税率 − 速算扣除数。',
    rateTable: rates(comprehensiveRates),
    conditions: ['居民个人的工资薪金、劳务报酬、稿酬和特许权使用费属于综合所得，按纳税年度合并计算。', '稿酬所得的收入额按规定减按 70% 计算；是否需要办理年度汇算及具体期限以当年税务机关公告为准。'],
    example: '示例：全年综合所得收入额 180,000 元，扣除合计 84,000 元，应纳税所得额 96,000 元；年度应纳税额为 96,000×10%−2,520=7,080 元。',
    effectiveAt: '2019-01-01', officialBases: [sources.individualIncomeTax]
  }),
  card('knowledge-iit-annual-bonus', {
    taxType: '个人所得税', topic: '全年一次性奖金单独计税', priority: 98,
    keywords: ['个人所得税', '年终奖', '全年一次性奖金', '单独计税', '奖金', '除以12'],
    formula: '应纳税额 = 全年一次性奖金收入 × 适用税率 − 速算扣除数；适用税率按全年一次性奖金收入÷12 的商数，查按月换算后的综合所得税率表确定。',
    rateTable: rates([['商数不超过 3,000 元', '3%', '0'], ['3,000–12,000 元', '10%', '210'], ['12,000–25,000 元', '20%', '1,410'], ['25,000–35,000 元', '25%', '2,660'], ['35,000–55,000 元', '30%', '4,410'], ['55,000–80,000 元', '35%', '7,160'], ['超过 80,000 元', '45%', '15,160']]),
    conditions: ['居民个人取得符合规定的全年一次性奖金，可以选择不并入当年综合所得，单独计算纳税；也可以选择并入综合所得计税。', '同一纳税年度内，对每一个纳税人该计税方法只允许使用一次。该政策执行至 2027 年 12 月 31 日。', '选择哪种方式取决于全年综合所得、扣除和奖金金额，建议两种方式分别测算后再申报。'],
    example: '示例：全年一次性奖金 36,000 元，36,000÷12=3,000 元，适用 3% 税率，单独计税应纳税额为 36,000×3%=1,080 元。',
    effectiveAt: '2024-01-01', expiresAt: '2027-12-31', officialBases: [sources.annualBonus, sources.individualIncomeTax]
  }),
  card('knowledge-iit-business-income', {
    taxType: '个人所得税', topic: '经营所得', priority: 98,
    keywords: ['个人所得税', '经营所得', '个体工商户', '个人独资企业', '合伙企业', '生产经营'],
    formula: '应纳税额 = 全年应纳税所得额 × 适用税率 − 速算扣除数；全年应纳税所得额 = 收入总额 − 成本 − 费用 − 损失。',
    rateTable: rates([['不超过 30,000 元', '5%', '0'], ['30,000–90,000 元', '10%', '1,500'], ['90,000–300,000 元', '20%', '10,500'], ['300,000–500,000 元', '30%', '40,500'], ['超过 500,000 元', '35%', '65,500']]),
    conditions: ['适用于个体工商户、个人独资企业投资人、合伙企业个人合伙人及其他依法取得经营所得的个人。', '经营所得按年计算，预缴、汇算和核定征收等具体征管事项以主管税务机关规定为准。'],
    example: '示例：全年应纳税所得额为 120,000 元，年度应纳税额为 120,000×20%−10,500=13,500 元。',
    effectiveAt: '2019-01-01', officialBases: [sources.individualIncomeTax]
  }),
  card('knowledge-vat-general', {
    taxType: '增值税及附加', topic: '一般计税方法', priority: 90,
    keywords: ['增值税', '销项税额', '进项税额', '一般计税', '13%', '9%', '6%'],
    formula: '一般计税应纳增值税额 = 当期销项税额 − 当期可抵扣进项税额。',
    rateTable: rates([['销售货物、加工修理修配服务、有形动产租赁及多数进口货物', '13%', '—'], ['交通运输、建筑、不动产租赁等及法定货物范围', '9%', '—'], ['除适用 13%、9% 及零税率外的服务、无形资产', '6%', '—'], ['出口货物及跨境应税行为', '0%', '以具体规定为准']]),
    conditions: ['适用于发生应税交易的一般计税纳税人；不同税率或征收率项目应分别核算。', '可抵扣进项税额须符合抵扣凭证和用途等法定条件；优惠和特定行业口径请核对最新规定。'],
    example: '示例：本期销项税额 13,000 元、可抵扣进项税额 8,000 元，应纳增值税额为 5,000 元。',
    effectiveAt: '2026-01-01', officialBases: [sources.vat]
  }),
  card('knowledge-vat-simple', {
    taxType: '增值税及附加', topic: '简易计税与小规模纳税人', priority: 89,
    keywords: ['增值税', '小规模纳税人', '简易计税', '征收率', '销售额'],
    formula: '简易计税应纳增值税额 = 不含税销售额 × 适用征收率。',
    rateTable: rates([['小规模纳税人或依法适用简易计税的应税交易', '适用征收率', '以现行优惠及具体业务规则为准']]),
    conditions: ['增值税法规定，小规模纳税人可以按销售额和征收率采用简易计税方法。', '小规模纳税人标准、征收率及阶段性优惠可能调整，申报前应以电子税务局和最新公告为准。'],
    example: '示例：不含税销售额 100,000 元、适用征收率 3%，未考虑优惠时应纳税额为 3,000 元。',
    effectiveAt: '2026-01-01', officialBases: [sources.vat]
  }),
  card('knowledge-eit-general', {
    taxType: '企业所得税', topic: '一般企业所得税', priority: 80,
    keywords: ['企业所得税', '应纳税所得额', '25%', '税前扣除', '汇算清缴'],
    formula: '应纳企业所得税额 = 应纳税所得额 × 适用税率 − 减免税额 − 抵免税额。',
    rateTable: rates([['居民企业、非居民企业在中国境内设立机构场所且所得与其有关联的一般情形', '25%', '法定基本税率'], ['符合条件的小型微利企业、高新技术企业等', '优惠税率/减计政策', '须同时满足法定条件']]),
    conditions: ['应纳税所得额以企业收入总额减除不征税收入、免税收入、各项扣除及允许弥补的亏损后计算。', '优惠资格、税前扣除和资产折旧等需按具体政策和留存资料判断。'],
    example: '示例：应纳税所得额 1,000,000 元，按 25% 基本税率且未考虑减免抵免时，应纳税额为 250,000 元。',
    effectiveAt: '2008-01-01', officialBases: [sources.enterpriseIncomeTax]
  }),
  card('knowledge-eit-expense-deductions', {
    taxType: '企业所得税', topic: '常见费用税前扣除比例', priority: 81,
    keywords: ['企业所得税', '税前扣除', '业务招待费', '职工福利费', '工会经费', '职工教育经费', '广告费', '业务宣传费', '公益性捐赠'],
    formula: '准予扣除额按各费用项目的“实际发生额、工资薪金总额、销售（营业）收入或年度利润总额”对应限额计算；业务招待费取“实际发生额×60%”与“销售（营业）收入×5‰”中的较低者。',
    rateTable: rates([['职工福利费', '不超过工资薪金总额 14%', '超过部分不得在当年扣除'], ['工会经费', '不超过工资薪金总额 2%', '应符合拨缴和凭证要求'], ['职工教育经费（一般企业）', '不超过工资薪金总额 8%', '超过部分准予以后年度结转扣除'], ['业务招待费', '实际发生额的 60%，且不超过销售（营业）收入的 5‰', '两项限额孰低'], ['广告费和业务宣传费（一般企业）', '不超过销售（营业）收入 15%', '超过部分准予以后年度结转；部分行业适用 30%或不得扣除'], ['公益性捐赠', '不超过年度利润总额 12%', '超过部分准予以后三年结转扣除'], ['补充养老／医疗保险费', '各不超过工资薪金总额 5%', '须符合国家有关规定并为本企业任职或受雇的全体员工支付']]),
    conditions: ['仅限企业实际发生、与取得收入有关且合理的支出；应取得并留存合法有效凭证。', '销售（营业）收入限额计算通常包括视同销售（营业）收入；广告费行业特殊规则、关联企业分摊和特殊捐赠政策应另行核验。', '本卡片为一般企业常见限额概览，不替代研发费用、手续费及佣金、房地产开发等行业或专项规定。'],
    example: '示例：业务招待费实际发生 100,000 元、销售（营业）收入 10,000,000 元：60%发生额为 60,000 元，收入 5‰限额为 50,000 元，税前准予扣除 50,000 元。',
    effectiveAt: '2008-01-01', officialBases: [sources.enterpriseIncomeTaxRegulation, sources.enterpriseIncomeTax, sources.educationExpense]
  }),
  card('knowledge-stamp-duty', {
    taxType: '印花税', topic: '应税凭证与计税', priority: 70,
    keywords: ['印花税', '合同', '产权转移书据', '营业账簿', '计税依据'],
    formula: '应纳印花税额 = 计税金额 × 适用税率；无法确定计税金额时，按规定确定计税依据。',
    rateTable: rates([['应税合同、产权转移书据、营业账簿、证券交易', '按税目税率表', '税目、计税金额和纳税人须逐项判断']]),
    conditions: ['以法律列举的应税凭证为对象，具体税目和税率以印花税法所附税目税率表为准。', '同一凭证多方当事人、金额不含税与含税、境外凭证等情形应按具体条款判断。'],
    example: '示例：某应税合同计税金额 100,000 元，适用税率 0.3‰，应纳印花税额为 30 元。',
    effectiveAt: '2022-07-01', officialBases: [sources.stamp]
  }),
  card('knowledge-property-tax', {
    taxType: '房产税', topic: '从价与从租计征', priority: 60,
    keywords: ['房产税', '从价计征', '从租计征', '房产原值', '租金收入'],
    formula: '从价计征年应纳税额 = 房产原值×（1−扣除比例）×1.2%；从租计征年应纳税额 = 租金收入×12%。',
    rateTable: rates([['从价计征', '1.2%', '扣除比例由省、自治区、直辖市规定'], ['从租计征', '12%', '以租金收入为计税依据']]),
    conditions: ['在城市、县城、建制镇和工矿区范围内的房产，依规定由产权所有人、经营管理单位等纳税。', '地方减免、原值扣除比例和具体征管口径存在差异。'],
    example: '示例：房产原值 1,000,000 元、当地扣除比例 30%，从价计征年税额为 1,000,000×70%×1.2%=8,400 元。',
    effectiveAt: '1986-10-01', officialBases: [sources.property]
  }),
  card('knowledge-urban-land-tax', {
    taxType: '城镇土地使用税', topic: '按占用面积计征', priority: 55,
    keywords: ['城镇土地使用税', '土地面积', '平方米', '年税额', '等级'],
    formula: '年应纳税额 = 实际占用土地面积（平方米）× 适用单位年税额。',
    rateTable: rates([['大城市、中等城市、小城市、县城/建制镇/工矿区', '地方核定单位年税额', '适用税额按当地土地等级和规定确定']]),
    conditions: ['以城市、县城、建制镇和工矿区范围内实际占用的土地面积为计税依据。', '单位年税额、等级划分、困难减免由当地规定，须查询土地所在地主管税务机关口径。'],
    example: '示例：实际占用面积 2,000 平方米、当地单位年税额 8 元/平方米，年应纳税额为 16,000 元。',
    effectiveAt: '1988-11-01', officialBases: [sources.urbanLand]
  }),
  card('knowledge-deed-tax', {
    taxType: '契税', topic: '土地房屋权属转移', priority: 50,
    keywords: ['契税', '房屋买卖', '土地使用权', '计税依据', '税率'],
    formula: '应纳契税额 = 计税依据 × 适用税率。',
    rateTable: rates([['土地使用权出让、转让，房屋买卖、赠与、互换等权属转移', '3%–5%', '具体适用税率由省级政府在法定幅度内提出']]),
    conditions: ['承受土地、房屋权属转移的单位和个人为纳税人。', '家庭住房优惠、计税价格核定和地方适用税率需以房屋所在地规定及申报系统结果为准。'],
    example: '示例：计税价格 1,000,000 元、适用税率 3%，未考虑优惠时应纳契税额为 30,000 元。',
    effectiveAt: '2021-09-01', officialBases: [sources.deed]
  }),
  card('knowledge-land-appreciation-tax', {
    taxType: '土地增值税', topic: '转让房地产增值额', priority: 45,
    keywords: ['土地增值税', '转让房地产', '增值额', '扣除项目', '四级超率累进'],
    formula: '增值额 = 转让房地产收入 − 扣除项目金额；应纳税额按增值额与扣除项目金额的比例，适用四级超率累进税率计算。',
    rateTable: rates([['增值额未超过扣除项目金额 50%', '30%', '—'], ['超过 50% 未超过 100%', '40%', '—'], ['超过 100% 未超过 200%', '50%', '—'], ['超过 200%', '60%', '—']]),
    conditions: ['转让国有土地使用权、地上建筑物及其附着物并取得收入的单位和个人，应依规定计算。', '扣除项目、普通住宅标准、清算条件及预征率等规则复杂，务必结合当地规定办理。'],
    example: '示例：转让收入 2,000,000 元、扣除项目金额 1,400,000 元，增值额 600,000 元，增值率约 42.86%，按第一档粗略测算税额为 180,000 元。',
    effectiveAt: '1994-01-01', officialBases: [sources.landAppreciation]
  })
];

function cleanText(value, field) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`缺少知识卡片字段：${field}`);
  return text;
}

export function buildKnowledgeCard(input, { id, status = 'draft', now = new Date().toISOString(), version = 1, versions = [] } = {}) {
  const rateTable = Array.isArray(input.rateTable) ? input.rateTable.map((row) => ({ bracket: cleanText(row?.bracket, '税率级距'), rate: cleanText(row?.rate, '税率'), quickDeduction: String(row?.quickDeduction || '—').trim() || '—' })) : [];
  const officialBases = Array.isArray(input.officialBases) ? input.officialBases.map((basis) => ({ title: cleanText(basis?.title, '依据文件名称'), authority: cleanText(basis?.authority, '依据发布机关'), url: cleanText(basis?.url, '依据链接') })) : [];
  if (!rateTable.length) throw new Error('至少需要一条税率或征收率信息。');
  if (!officialBases.length) throw new Error('至少需要一条官方依据。');
  if (officialBases.some((basis) => !/^https:\/\/(?:[\w-]+\.)*(?:chinatax\.gov\.cn|gov\.cn|npc\.gov\.cn|mof\.gov\.cn|moj\.gov\.cn)(?:\/|$)/i.test(basis.url))) throw new Error('官方依据链接必须来自国家税务总局、财政部、中国政府网、中国人大网或司法部。');
  const conditions = Array.isArray(input.conditions) ? input.conditions.map((item) => String(item || '').trim()).filter(Boolean) : [];
  if (!conditions.length) throw new Error('至少需要一条适用条件。');
  return {
    id: id || input.id,
    taxType: cleanText(input.taxType, '税种'), topic: cleanText(input.topic, '专题'),
    keywords: Array.isArray(input.keywords) ? input.keywords.map(String).map((item) => item.trim()).filter(Boolean) : [],
    formula: cleanText(input.formula, '计算公式'), rateTable, conditions,
    example: cleanText(input.example, '示例'), regionScope: cleanText(input.regionScope || '全国通用基础规则', '地区范围'),
    effectiveAt: cleanText(input.effectiveAt, '生效日期'), expiresAt: input.expiresAt || null,
    officialBases, status, priority: Number(input.priority) || 0, version, versions,
    verifiedAt: input.verifiedAt || now, createdAt: input.createdAt || now, updatedAt: now,
    publishedAt: status === 'published' ? (input.publishedAt || now) : null
  };
}

export function searchKnowledgeCards(cards, { query = '', taxType = '' } = {}) {
  const term = String(query || '').toLocaleLowerCase('zh-CN').replace(/\s+/g, '');
  return cards.filter((card) => card.status === 'published' && (!taxType || card.taxType === taxType)).map((card) => {
    const corpus = [card.taxType, card.topic, ...(card.keywords || []), card.formula, ...(card.conditions || [])].join(' ').toLocaleLowerCase('zh-CN').replace(/\s+/g, '');
    const exactTax = term && card.taxType.toLocaleLowerCase('zh-CN').includes(term) ? 300 : 0;
    const topic = term && card.topic.toLocaleLowerCase('zh-CN').includes(term) ? 200 : 0;
    const keyword = (card.keywords || []).some((item) => item.toLocaleLowerCase('zh-CN').includes(term) || term.includes(item.toLocaleLowerCase('zh-CN'))) ? 100 : 0;
    const text = term && corpus.includes(term) ? 30 : 0;
    return { card, score: exactTax + topic + keyword + text + card.priority };
  }).filter((item) => !term || item.score > item.card.priority).sort((a, b) => b.score - a.score || String(b.card.updatedAt).localeCompare(String(a.card.updatedAt)) || a.card.topic.localeCompare(b.card.topic, 'zh-CN'));
}

export function publicKnowledgeCard(card) {
  const { versions, ...value } = card;
  return value;
}
