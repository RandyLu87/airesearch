import type {ReportProps, Scene} from './types';

/**
 * `remotion studio` 打开时的默认 props——一份不属于任何真实公司的假数据，
 * 只为了「不传 --props 也能打开预览」，并且顺手把空态（分数缺失 / 结论缺失 /
 * 无触发条件）摆在画面上，改样式时不用先跑一遍 TTS 就能看到空态长什么样。
 *
 * 真跑成片一律走 `npm run render:report`，props 由 scripts/report_props.mjs 生成。
 */
const FPS = 30;

/** 每 1.5 秒点亮一条的假时间轴：预览时不跑 TTS，也要能看出逐条点亮长什么样。 */
const fakeBeats = (texts: string[], group: string) =>
  texts.map((text, index) => ({group, text, sentenceIndex: index, from: Math.round(index * 1.5 * FPS)}));

const raw: Array<Omit<Scene, 'from'>> = [
  {
    id: 'opening',
    kind: 'opening',
    title: '示例公司 (Demo Inc.)',
    narration: '',
    data: {positioning: '这是模板预览用的假数据，用来检查排版与空态，不代表任何真实公司。'},
    captions: [{text: '这是模板预览用的假数据。', from: 0, durationInFrames: 3 * FPS}],
    beats: [],
    durationInFrames: 5 * FPS,
    audioSeconds: null,
  },
  {
    id: 'dimension-businessQuality',
    kind: 'dimension',
    title: '生意质量',
    narration: '',
    data: {dimensionId: 'businessQuality', ordinal: 1, score: 6.5, scoreLabel: '6.5 分', conclusion: '示例结论文本。'},
    captions: [],
    beats: [],
    durationInFrames: 5 * FPS,
    audioSeconds: null,
  },
  {
    id: 'business-model-revenue',
    kind: 'business-model',
    title: '收入结构',
    narration: '',
    data: {
      focus: 'revenue',
      period: 'FY2099（示例）',
      salesModel: '混合',
      productForm: '平台',
      // 第三条是空态样本：占比认不出来时只留灰轨，不画 0% 的条
      items: [
        {segment: '主营业务A', revenue: '1234.56百万元CNY', sharePct: '52.10%'},
        {segment: '主营业务B', revenue: '678.90百万元CNY', sharePct: '28.65%'},
        {segment: '其他（占比原报告未披露）', revenue: '示例金额', sharePct: ''},
      ],
      itemsAvailable: 5,
    },
    captions: [],
    beats: fakeBeats(['主营业务A', '主营业务B', '其他'], 'revenue'),
    durationInFrames: 8 * FPS,
    audioSeconds: null,
  },
  {
    id: 'business-model-economics',
    kind: 'business-model',
    title: '生意的经济特征',
    narration: '',
    data: {focus: 'economics', level: '强'},
    captions: [],
    beats: [
      ...fakeBeats(['示例粘性机制要点一。', '示例粘性机制要点二。'], 'mechanism'),
      ...fakeBeats(['示例经营杠杆观察。'], 'leverage'),
    ],
    durationInFrames: 8 * FPS,
    audioSeconds: null,
  },
  {
    id: 'moat-checklist',
    kind: 'moat-checklist',
    title: '护城河逐条检验',
    narration: '',
    data: {
      spokenTest: true,
      items: [
        {type: '品牌/定价权', test: '是否能在不损失销量的情况下提价？', verdict: '待验证'},
        {type: '网络效应', test: '用户越多产品越好吗？', verdict: '存在'},
        // 空态样本：原报告没填判定
        {type: '技术/专利壁垒', test: '技术领先几年？能否被复制？', verdict: ''},
      ],
    },
    captions: [],
    beats: fakeBeats(['品牌/定价权', '网络效应', '技术/专利壁垒'], 'type'),
    durationInFrames: 8 * FPS,
    audioSeconds: null,
  },
  {
    id: 'moat-trend',
    kind: 'moat-trend',
    title: '护城河的过去与未来',
    narration: '',
    data: {
      past: {label: '过去五年', direction: '变宽', points: ['示例依据一。', '示例依据二。']},
      // 空态样本：未来五年的方向没填
      next: {label: '未来五年', direction: '', points: ['示例预判依据。']},
    },
    captions: [],
    beats: [...fakeBeats(['示例依据一。', '示例依据二。'], 'past'), ...fakeBeats(['示例预判依据。'], 'next')],
    durationInFrames: 8 * FPS,
    audioSeconds: null,
  },
  {
    id: 'moat-inquiry',
    kind: 'inquiry',
    title: '十年之问',
    narration: '',
    data: {question: '10年后这条护城河还在吗？什么能摧毁它？', beatsAvailable: 4},
    captions: [],
    beats: fakeBeats(['示例回答要点一。', '示例回答要点二。'], 'answer'),
    durationInFrames: 8 * FPS,
    audioSeconds: null,
  },
  {
    id: 'dimension-valuation',
    kind: 'dimension',
    title: '估值',
    narration: '',
    // 空态样本：原报告标了 unavailable，图表只留灰轨、右侧播「暂无数据」
    data: {dimensionId: 'valuation', ordinal: 2, score: null, scoreLabel: '暂无评分', conclusion: ''},
    captions: [],
    beats: [],
    durationInFrames: 5 * FPS,
    audioSeconds: null,
  },
  {
    id: 'strategy-noPosition',
    kind: 'strategy',
    title: '空仓者',
    narration: '',
    data: {strategyId: 'noPosition', advice: '示例建议正文。', items: [], itemsAvailable: 0},
    captions: [],
    beats: [],
    durationInFrames: 5 * FPS,
    audioSeconds: null,
  },
  {
    id: 'closing',
    kind: 'closing',
    title: '免责声明',
    narration: '',
    data: {disclaimer: '仅供研究参考，不构成个性化投资建议。'},
    captions: [],
    beats: [],
    durationInFrames: 4 * FPS,
    audioSeconds: null,
  },
];

let cursor = 0;
const scenes: Scene[] = raw.map((scene) => {
  const from = cursor;
  cursor += scene.durationInFrames;
  return {...scene, from};
});

export const demoProps: ReportProps = {
  fps: FPS,
  companyName: '示例公司 (Demo Inc.)',
  companyId: 'xx-demo-demo',
  dataCutoff: '0000-00-00（示例）',
  dimensions: [
    {id: 'businessQuality', title: '生意质量', score: 6.5, scoreLabel: '6.5 分'},
    {id: 'valuation', title: '估值', score: null, scoreLabel: '暂无评分'},
  ],
  scenes,
  audioTrack: null,
  totals: {durationInFrames: cursor, videoSeconds: cursor / FPS, audioSeconds: 0, sceneCount: scenes.length},
};
