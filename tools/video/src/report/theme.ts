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
  // 字幕底衬：几乎不透明的纸色卡片。
  //
  // 原来是「纸面上压一层 6% 的墨」，在纯背景上够用；但字幕现在浮在正文与图表之上，
  // 半透明会让折线、柱子从字缝里透出来和笔画纠缠，正是最影响阅读的一种脏。
  // 留 4% 的透明度只为了不显得像贴上去的第二张纸。
  captionBg: 'rgba(238, 238, 231, 0.96)',
  // 字幕卡的描边：纸色卡压在纸色背景上，没有这道线就浮不起来
  captionBorder: 'rgba(16, 16, 16, 0.10)',
  line: '#c9c9c2',
  fontFamily:
    '"Inter Local", system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
} as const;

/**
 * 图表的分类色序，**按固定顺序取用、绝不循环**：第一条线永远是 series[0]。
 *
 * 首色就是站点强调色（暖珊瑚），后面四色取自 dataviz 参考palette的蓝/青/紫/黄。
 * 这套顺序在纸面 `#f7f7f2` 上跑过校验（`scripts/validate_palette.js`，light 模式）：
 * 相邻对最差 CVD ΔE 21.6、常规视觉 ΔE 24.0，硬闸门全过；对比度一项是 WARN，
 * 按「relief 规则」必须给可见的直接标注——所以每条线、每根柱都带文字标签，
 * 这不是装饰，是这套配色成立的前提，删标签等于让配色失效。
 *
 * 超过 5 条序列不再自动配色：一屏读不清 6 条线，该拆图或并成「其他」。
 */
export const series = ['#d97757', '#2a78d6', '#1baf7a', '#4a3aa7', '#eda100'] as const;

/**
 * 涨跌两色。中文语境按「红涨绿跌」，与全片的中文解说词一致。
 *
 * 红绿对 deutan 的 ΔE 只有 6.9（校验器给 WARN，处在只允许配合二次编码使用的区间），
 * 所以画面上永远同时给三重冗余：**带正负号的数值标签、以零轴为界的左右方向、按值排序的位置**。
 * 三者任意一个被删掉，这套颜色就不再合规——不要只留颜色。
 */
export const delta = {up: '#c0392b', down: '#2f7d52', flat: '#8a8a82'} as const;

export const SCORE_MAX = 10;

/** 自托管 Inter 在 public 目录里的相对路径；由 render.mjs 从站点资源拷过来。 */
export const INTER_FONT_FILE = 'fonts/InterVariable.woff2';
export const INTER_FAMILY = 'Inter Local';
