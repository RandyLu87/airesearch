// 视觉口径：浅色暖调，与 `apps/web/public/assets/research.css` 的研究站点同一套。
//
// 中性色直接取站点的设计令牌（--paper / --ink / --muted / --line / --soft），
// 让成片和公司研究页看起来是同一个产品，而不是两套皮肤。强调色用暖珊瑚（Claude 的
// 那一档），比站点的 --signal #ff4d00 收敛，长时间盯着 5 分钟的片子不刺眼；
// 想跟站点完全一致就把 accent 换成 '#ff4d00'，只有这一处。
//
// 字体同样复用站点那份：Inter 覆盖拉丁与数字，中文走 PingFang SC——和站点逐字同源。
// Inter 是自托管的子集化 woff2（SIL OFL），由 render.mjs 拷进 --public-dir，
// 见 fontFace()。取不到时按下面的字族链回退，只是字形变化，排版不塌。
export const theme = {
  bg: '#f7f7f2',
  // 卡片底：比纸面深一档，浅色下不能再用「更亮」来区分层级
  bgSoft: '#eeeee7',
  text: '#101010',
  textDim: '#686863',
  accent: '#d97757',
  // 空态刻意用中性灰：跟有分数的条形拉开对比，一眼看出是「没有数据」而不是「分数低」
  muted: '#dcdcd4',
  // 非当前维度的条形；要比 muted 的轨道明显深一档，否则七条里只看得清点亮的那条
  barIdle: '#a3a39a',
  // 浅色下的警示色：深一点的赭石，纸面上读得清，又不跟强调色抢
  warn: '#9c5b23',
  // 字幕底衬：纸面上压一层极浅的墨，字幕有边界又不喧宾夺主
  captionBg: 'rgba(16, 16, 16, 0.06)',
  line: '#c9c9c2',
  fontFamily:
    '"Inter Local", system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
} as const;

export const SCORE_MAX = 10;

/** 自托管 Inter 在 public 目录里的相对路径；由 render.mjs 从站点资源拷过来。 */
export const INTER_FONT_FILE = 'fonts/InterVariable.woff2';
export const INTER_FAMILY = 'Inter Local';
