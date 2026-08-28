/**
 * 画面上的图表。数据全部由 `scripts/visuals.py` 抽好（含单位换算与口径闸门），
 * 这里**只负责画**：不换算、不推断、不给缺失值兜一个 0。
 *
 * 视频不是网页：没有 hover、没有 tooltip、没有筛选器，一屏只停几十秒且观众不能交互。
 * 所以 dataviz 那套「默认给 hover 层」在这里不适用，取而代之的硬要求是
 * **每一个标注都必须一直显示在画面上**——这也正好是这套配色（对比度 WARN）
 * 成立所依赖的 relief 规则。
 *
 * 尺寸按 1920×1080 的画布放大过：线宽 4px、端点 14px、间隙 4px，
 * 对应 dataviz 里 2px / 8px / 2px 的网页口径。
 */
import {interpolate, useCurrentFrame} from 'remotion';
import {delta as deltaColors, series as seriesColors, theme} from './theme';
import type {Chart, DeltaItem, Hero, RiskCell, Series} from './types';

/** 入场生长进度：0 → 1，18 帧走完。所有图共用，节奏一致。 */
const useGrow = () => {
  const frame = useCurrentFrame();
  return interpolate(frame, [0, 18], [0, 1], {extrapolateRight: 'clamp'});
};

/**
 * 主数字。一屏一个，是「核心指标要突出」的落点。
 *
 * 口径括注（TTM / 财年）必须跟着一起出现：`20.28` 和 `20.28 倍（TTM）` 是两个
 * 强度不同的说法，把括注省掉就是把一个口径说成了唯一口径。
 */
export const HeroMetric: React.FC<{hero: Hero; size?: 'large' | 'medium'}> = ({hero, size = 'large'}) => {
  const valueSize = size === 'large' ? 108 : 76;
  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
      <div style={{fontSize: size === 'large' ? 28 : 24, color: theme.textDim, letterSpacing: 1}}>{hero.label}</div>
      <div style={{display: 'flex', alignItems: 'baseline', gap: 12}}>
        <div style={{fontSize: valueSize, fontWeight: 800, color: theme.text, lineHeight: 1.05}}>{hero.value}</div>
        {hero.unit ? <div style={{fontSize: valueSize * 0.36, color: theme.textDim}}>{hero.unit}</div> : null}
        {hero.delta ? (
          <div
            style={{
              fontSize: valueSize * 0.32,
              fontWeight: 700,
              color: hero.delta.startsWith('-') ? deltaColors.down : deltaColors.up,
            }}
          >
            {hero.deltaNote ? `${hero.deltaNote} ` : ''}
            {hero.delta}
          </div>
        ) : null}
      </div>
      {hero.note ? <div style={{fontSize: 23, color: theme.textDim}}>{hero.note}</div> : null}
    </div>
  );
};

/** 关键指标卡片行（开场）。每张卡自己带标签与口径，缺的指标根本不出现，不占位。 */
const KpiGrid: React.FC<{items: Hero[]}> = ({items}) => {
  const grow = useGrow();
  return (
    <div style={{display: 'flex', gap: 18, width: '100%'}}>
      {items.map((item, index) => (
        <div
          key={index}
          style={{
            flex: 1,
            // 逐张淡入，顺序跟着念的顺序走；不是同时炸出来
            opacity: interpolate(grow, [index * 0.12, index * 0.12 + 0.4], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
            backgroundColor: theme.bgSoft,
            borderRadius: 14,
            borderTop: `4px solid ${seriesColors[index % seriesColors.length]}`,
            padding: '22px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{fontSize: 22, color: theme.textDim, lineHeight: 1.3}}>{item.label}</div>
          <div style={{fontSize: 42, fontWeight: 800, color: theme.text, lineHeight: 1.1}}>{item.value}</div>
          {item.delta ? (
            <div style={{fontSize: 24, fontWeight: 700, color: item.delta.startsWith('-') ? deltaColors.down : deltaColors.up}}>
              {item.deltaNote ? `${item.deltaNote} ` : ''}
              {item.delta}
            </div>
          ) : null}
          {item.note ? <div style={{fontSize: 19, color: theme.textDim, lineHeight: 1.3}}>{item.note}</div> : null}
        </div>
      ))}
    </div>
  );
};

const CHART_HEIGHT = 340;
// 左右两边的留白都是给**文字**留的，不是装饰：左边放得下首个 x 轴标签的一半
// （标签居中对齐在第一个点上），右边放得下最长的一条端点标注（`1688.38亿元`）。
// 留窄了不会报错，只会把字切掉一半——这种错只有看成片才发现得了。
const PAD = {top: 34, right: 200, bottom: 46, left: 70};

/**
 * 折线图。多条线共用一根 y 轴——两条线只要不同量纲就绝不画在一起，
 * 这一条由 `visuals.py` 保证（营收/净利润同币种、毛利率/经营利润率同为百分比）。
 *
 * 每条线只在**最后一个点**直接标注系列名与数值：给每个点都标数字会把图糊成表格。
 * 图例始终在（≥2 条线时），所以身份从不只靠颜色。
 */
const LineSeries: React.FC<{series: Series[]; axisUnit: string; zeroBaseline: boolean; width: number}> = ({
  series,
  axisUnit,
  zeroBaseline,
  width,
}) => {
  const grow = useGrow();
  const all = series.flatMap((item) => item.points.map((point) => point.y));
  if (all.length === 0) return null;

  // 有负值时零轴必须画出来：净利润从 -67 亿走到 +11 亿，跨过零那一下才是这张图的全部意思
  const rawMin = Math.min(...all);
  const rawMax = Math.max(...all);
  const min = zeroBaseline ? Math.min(0, rawMin) : rawMin - (rawMax - rawMin) * 0.15;
  const max = rawMax + (rawMax - rawMin || Math.abs(rawMax) || 1) * 0.15;
  const span = max - min || 1;

  const labels = series[0].points.map((point) => point.x);
  const innerWidth = width - PAD.left - PAD.right;
  const innerHeight = CHART_HEIGHT - PAD.top - PAD.bottom;
  const xOf = (index: number, count: number) =>
    PAD.left + (count <= 1 ? innerWidth / 2 : (index / (count - 1)) * innerWidth);
  const yOf = (value: number) => PAD.top + innerHeight - ((value - min) / span) * innerHeight;
  const zeroY = yOf(0);
  const showZero = min < 0 && max > 0;
  // 防止把 0.88 个百分点读成断崖的那道保险，交给下面首尾两个**贴着数据点**的标注：
  // 没有任何刻度时，一条 92.11% → 91.23% 的线和一条 90% → 0% 的线画出来一模一样。
  // 之所以不另画轴刻度，是因为轴上的 min/max 和首尾点标注说的是同一件事，
  // 两套数字挤在左边缘只会互相压住。

  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
      {series.length > 1 ? (
        <div style={{display: 'flex', gap: 26, width}}>
          {series.map((item, index) => (
            <div key={item.name} style={{display: 'flex', alignItems: 'center', gap: 9}}>
              <div style={{width: 22, height: 5, borderRadius: 3, backgroundColor: seriesColors[index % seriesColors.length]}} />
              {/* 图例文字用墨色而不是系列色：颜色的活儿由它左边那根色条干 */}
              <div style={{fontSize: 24, color: theme.textDim}}>{item.name}</div>
            </div>
          ))}
          <div style={{fontSize: 24, color: theme.textDim, marginLeft: 'auto'}}>单位　{axisUnit}</div>
        </div>
      ) : (
        <div style={{fontSize: 24, color: theme.textDim}}>
          {series[0].name}　·　单位 {axisUnit}
        </div>
      )}
      <svg width={width} height={CHART_HEIGHT}>
        {showZero ? (
          <>
            <line x1={PAD.left} x2={PAD.left + innerWidth} y1={zeroY} y2={zeroY} stroke={theme.line} strokeWidth={2} />
            <text x={PAD.left + innerWidth + 8} y={zeroY + 8} fill={theme.textDim} fontSize={20}>
              0
            </text>
          </>
        ) : null}
        {labels.map((label, index) => (
          <text
            key={label}
            x={xOf(index, labels.length)}
            y={CHART_HEIGHT - 12}
            fill={theme.textDim}
            fontSize={23}
            textAnchor="middle"
          >
            {label}
          </text>
        ))}
        {series.map((item, seriesIndex) => {
          const color = seriesColors[seriesIndex % seriesColors.length];
          const count = item.points.length;
          // 折线按帧数从左往右长出来，长到哪儿点亮到哪儿
          const drawn = Math.max(1, Math.ceil(count * grow));
          const path = item.points
            .slice(0, drawn)
            .map((point, index) => `${index === 0 ? 'M' : 'L'} ${xOf(index, count)} ${yOf(point.y)}`)
            .join(' ');
          const last = item.points[drawn - 1];
          const first = item.points[0];
          return (
            <g key={item.name}>
              <path d={path} fill="none" stroke={color} strokeWidth={4} strokeLinejoin="round" strokeLinecap="round" />
              {item.points.slice(0, drawn).map((point, index) => (
                // 描一圈纸色：两条线交叉时端点不会糊成一坨
                <circle
                  key={index}
                  cx={xOf(index, count)}
                  cy={yOf(point.y)}
                  r={7}
                  fill={color}
                  stroke={theme.bg}
                  strokeWidth={2}
                />
              ))}
              {/* 起点标注压暗、末点标注加重：读的顺序是「从这儿走到了这儿」 */}
              {count >= 3 && first ? (
                <text x={xOf(0, count)} y={yOf(first.y) + 34} fill={theme.textDim} fontSize={22} textAnchor="middle">
                  {first.label}
                </text>
              ) : null}
              {last ? (
                <text x={xOf(drawn - 1, count) + 14} y={yOf(last.y) + 8} fill={theme.text} fontSize={26} fontWeight={700}>
                  {last.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
};

/**
 * 以零为轴的涨跌柱：向右为正、向左为负，配上带正负号的数值标签。
 *
 * 方向、符号、颜色三重冗余是刻意的——红绿对色盲观众的分辨度处在只允许
 * 配合二次编码使用的区间（见 theme.ts 的 `delta`），少任何一重都不合规。
 */
const DeltaBars: React.FC<{items: DeltaItem[]; period?: string; caption: string}> = ({items, period, caption}) => {
  const grow = useGrow();
  const TRACK = 680;
  // 零轴的位置跟着数据走：全是正数就贴左边，让每根柱子都用得上整条轨道。
  // 一律居中会把「四条里只有一条为负」的一屏浪费掉半幅，小幅度的柱子细到看不见。
  const maxUp = Math.max(...items.map((item) => Math.max(0, item.valuePct)), 0);
  const maxDown = Math.max(...items.map((item) => Math.max(0, -item.valuePct)), 0);
  const span = maxUp + maxDown || 1;
  const leftWidth = (maxDown / span) * TRACK;
  const rightWidth = TRACK - leftWidth;

  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 14, width: '100%'}}>
      <div style={{fontSize: 24, color: theme.textDim}}>
        {caption}
        {period ? `　·　${period}` : ''}
      </div>
      {items.map((item, index) => {
        const positive = item.valuePct >= 0;
        const side = positive ? rightWidth : leftWidth;
        const reach = ((Math.abs(item.valuePct) / (positive ? maxUp : maxDown || 1)) * side || 0) * grow;
        const color = item.valuePct === 0 ? deltaColors.flat : positive ? deltaColors.up : deltaColors.down;
        return (
          <div key={index} style={{display: 'flex', alignItems: 'center', gap: 16}}>
            <div style={{width: 250, fontSize: 26, color: theme.text, textAlign: 'right'}}>{item.name}</div>
            <div style={{position: 'relative', width: TRACK, height: 34}}>
              {/* 零轴：所有柱子的共同起点，必须看得见，否则「向左」没有参照 */}
              <div style={{position: 'absolute', left: leftWidth, top: 0, bottom: 0, width: 2, backgroundColor: theme.line}} />
              <div
                style={{
                  position: 'absolute',
                  top: 3,
                  bottom: 3,
                  left: positive ? leftWidth + 2 : leftWidth - reach,
                  width: Math.max(2, reach),
                  backgroundColor: color,
                  borderRadius: positive ? '0 6px 6px 0' : '6px 0 0 6px',
                }}
              />
            </div>
            <div style={{width: 150, fontSize: 27, fontWeight: 700, color}}>{item.label}</div>
            {item.note ? <div style={{fontSize: 22, color: theme.textDim}}>{item.note}</div> : null}
          </div>
        );
      })}
    </div>
  );
};

/**
 * 失败路径的「概率 × 影响」矩阵。
 *
 * 每条路径是一个点，落在自己那一格里。**右上角（高概率 × 高影响）单独加重**——
 * 「聪明人为什么会不买」的答案基本就在那一格，其余格子给的是分布感，不是逐条阅读的内容。
 * 所以只有那一格的路径名写出来，别的格子只给点和条数：一屏停二十秒，读不完八条长句。
 *
 * 落不了格的路径（缺概率或影响判定）在底部如实计数——矩阵里少一个点和报告里少一条风险
 * 是两回事，不说明就是把前者冒充成了后者。
 */
const RiskMatrix: React.FC<{cells: RiskCell[]; omitted: number; total: number}> = ({cells, omitted, total}) => {
  const grow = useGrow();
  // 影响从左到右递增、概率从上到下递减 —— 右上角就是「又可能又致命」，
  // 与看风险图的习惯一致：越靠右上越该紧张。
  const impacts = ['低', '中', '高'];
  const probabilities = ['高', '中', '低'];
  const at = (probability: string, impact: string) =>
    cells.filter((cell) => cell.probability === probability && cell.impact === impact);
  const severe = at('高', '高');

  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 12}}>
      <div style={{display: 'flex', alignItems: 'stretch', gap: 10}}>
        <div
          style={{
            width: 34,
            fontSize: 22,
            color: theme.textDim,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            // 纵轴标题竖排，省掉横向空间
            writingMode: 'vertical-rl',
          }}
        >
          概率
        </div>
        <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
          {probabilities.map((probability) => (
            <div key={probability} style={{display: 'flex', alignItems: 'center', gap: 6}}>
              <div style={{width: 30, fontSize: 22, color: theme.textDim, textAlign: 'right'}}>{probability}</div>
              {impacts.map((impact) => {
                const here = at(probability, impact);
                const isSevere = probability === '高' && impact === '高';
                const color = isSevere ? theme.warn : theme.barIdle;
                return (
                  <div
                    key={impact}
                    style={{
                      width: 172,
                      height: 92,
                      borderRadius: 10,
                      backgroundColor: theme.bgSoft,
                      border: isSevere ? `2px solid ${theme.warn}` : `1px solid ${theme.line}`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                    }}
                  >
                    {here.map((_, index) => (
                      <div
                        key={index}
                        style={{
                          width: 18,
                          height: 18,
                          borderRadius: 9,
                          backgroundColor: color,
                          // 逐点长出来，顺序从左上到右下
                          opacity: interpolate(grow, [0, 0.6], [0, 1], {extrapolateRight: 'clamp'}),
                        }}
                      />
                    ))}
                    {here.length === 0 ? <div style={{fontSize: 22, color: theme.line}}>—</div> : null}
                  </div>
                );
              })}
            </div>
          ))}
          <div style={{display: 'flex', gap: 6, marginLeft: 36}}>
            {impacts.map((impact) => (
              <div key={impact} style={{width: 172, fontSize: 22, color: theme.textDim, textAlign: 'center'}}>
                {impact}
              </div>
            ))}
          </div>
          <div style={{fontSize: 22, color: theme.textDim, textAlign: 'center', marginLeft: 36}}>影响</div>
        </div>
      </div>
      {severe.length > 0 ? (
        <div style={{fontSize: 23, lineHeight: 1.45, color: theme.text, maxWidth: 620}}>
          <span style={{color: theme.warn, fontWeight: 700}}>高概率 × 高影响　</span>
          {severe.map((cell) => cell.label).join('；')}
        </div>
      ) : null}
      <div style={{fontSize: 21, color: theme.textDim}}>
        原报告共 {total} 条失败路径
        {omitted > 0 ? `，其中 ${omitted} 条缺概率或影响判定、未落格` : ''}
      </div>
    </div>
  );
};

export const ChartView: React.FC<{chart: Chart; width?: number}> = ({chart, width = 940}) => {
  switch (chart.type) {
    case 'kpi-grid':
      return <KpiGrid items={chart.items} />;
    case 'line-series':
      return <LineSeries series={chart.series} axisUnit={chart.axisUnit} zeroBaseline={chart.zeroBaseline} width={width} />;
    case 'delta-bars':
      return <DeltaBars items={chart.items} period={chart.period} caption="分部收入同比" />;
    case 'range-band':
      // 三情景与分部同比是同一种形状：以零为轴的涨跌幅，只是标题不同
      return <DeltaBars items={chart.items} caption="三情景隐含涨跌幅（相对当前价）" />;
    case 'risk-matrix':
      return <RiskMatrix cells={chart.cells} omitted={chart.omitted} total={chart.total} />;
    default:
      // 认不出的 type 整块不画：宁可空着，也不要画一张不知道在说什么的图
      return null;
  }
};
