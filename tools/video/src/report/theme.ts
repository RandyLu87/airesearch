// MVP 阶段的视觉口径：深色底 + 单一强调色，够读就行，不做设计打磨。
// 字体只用系统 CJK 字族——不打包字体文件，headless Chromium 用宿主机字体渲染。
export const theme = {
  bg: '#0b1220',
  bgSoft: '#111b2e',
  text: '#e8eefc',
  textDim: '#8ea2c8',
  accent: '#7fa2ff',
  // 空态刻意用中性灰：跟有分数的条形拉开对比，一眼看出是「没有数据」而不是「分数低」
  muted: '#39445c',
  // 非当前维度的条形；要比 muted 的轨道明显亮一档，否则七条里只看得清点亮的那条
  barIdle: '#6a83c4',
  warn: '#ffb454',
  // 字幕底衬：压在深色底上要略亮一档才读得清，又不能亮到把正文压下去
  captionBg: 'rgba(17, 27, 46, 0.86)',
  fontFamily:
    '"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", -apple-system, sans-serif',
} as const;

export const SCORE_MAX = 10;
