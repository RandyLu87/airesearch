import type {ReportProps, Scene} from './types';

/**
 * `remotion studio` 打开时的默认 props——一份不属于任何真实公司的假数据，
 * 只为了「不传 --props 也能打开预览」，并且顺手把空态（分数缺失 / 结论缺失 /
 * 无触发条件）摆在画面上，改样式时不用先跑一遍 TTS 就能看到空态长什么样。
 *
 * 真跑成片一律走 `npm run render:report`，props 由 scripts/report_props.mjs 生成。
 */
const FPS = 30;

const raw: Array<Omit<Scene, 'from'>> = [
  {
    id: 'opening',
    kind: 'opening',
    title: '示例公司 (Demo Inc.)',
    narration: '',
    data: {positioning: '这是模板预览用的假数据，用来检查排版与空态，不代表任何真实公司。'},
    durationInFrames: 5 * FPS,
    audioSeconds: null,
  },
  {
    id: 'dimension-businessQuality',
    kind: 'dimension',
    title: '生意质量',
    narration: '',
    data: {dimensionId: 'businessQuality', ordinal: 1, score: 6.5, scoreLabel: '6.5 分', conclusion: '示例结论文本。'},
    durationInFrames: 5 * FPS,
    audioSeconds: null,
  },
  {
    id: 'dimension-valuation',
    kind: 'dimension',
    title: '估值',
    narration: '',
    // 空态样本：原报告标了 unavailable，图表只留灰轨、右侧播「暂无数据」
    data: {dimensionId: 'valuation', ordinal: 2, score: null, scoreLabel: '暂无评分', conclusion: ''},
    durationInFrames: 5 * FPS,
    audioSeconds: null,
  },
  {
    id: 'strategy-noPosition',
    kind: 'strategy',
    title: '空仓者',
    narration: '',
    data: {strategyId: 'noPosition', advice: '示例建议正文。', items: [], itemsAvailable: 0},
    durationInFrames: 5 * FPS,
    audioSeconds: null,
  },
  {
    id: 'closing',
    kind: 'closing',
    title: '免责声明',
    narration: '',
    data: {disclaimer: '仅供研究参考，不构成个性化投资建议。'},
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
