import {interpolate, useCurrentFrame} from 'remotion';
import {SCORE_MAX, theme} from './theme';
import type {DimensionRef} from './types';

/**
 * 七维度信心度条形图。整张图在每个维度分镜里都在，只把当前播报的那条点亮，
 * 听众始终看得到「七条里现在讲第几条」。
 *
 * 空态：`score === null`（原文 unavailable / 缺失）时不画任何长度的条，
 * 只留灰色轨道 + 生成器写的说法（「暂无评分」/「暂无数据」）——不画 0 分，
 * 0 分和没有数据是两回事，画出来就是编数字。
 */
export const DimensionChart: React.FC<{
  dimensions: DimensionRef[];
  activeId: string | null;
}> = ({dimensions, activeId}) => {
  const frame = useCurrentFrame();
  const grow = interpolate(frame, [0, 18], [0, 1], {extrapolateRight: 'clamp'});

  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 18}}>
      {dimensions.map((dimension) => {
        const active = dimension.id === activeId;
        const hasScore = dimension.score !== null;
        const ratio = hasScore ? Math.max(0, Math.min(1, dimension.score! / SCORE_MAX)) : 0;
        return (
          <div key={dimension.id} style={{display: 'flex', alignItems: 'center', gap: 20, opacity: active ? 1 : 0.5}}>
            <div
              style={{
                width: 190,
                textAlign: 'right',
                fontSize: 30,
                fontWeight: active ? 700 : 500,
                color: active ? theme.text : theme.textDim,
              }}
            >
              {dimension.title}
            </div>
            <div style={{position: 'relative', width: 520, height: 26, borderRadius: 13, backgroundColor: theme.muted}}>
              {hasScore ? (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: `${ratio * grow * 100}%`,
                    borderRadius: 13,
                    backgroundColor: active ? theme.accent : theme.barIdle,
                  }}
                />
              ) : null}
            </div>
            <div
              style={{
                width: 190,
                fontSize: 28,
                fontWeight: active ? 700 : 500,
                color: hasScore ? (active ? theme.accent : theme.textDim) : theme.warn,
              }}
            >
              {dimension.scoreLabel}
            </div>
          </div>
        );
      })}
    </div>
  );
};
