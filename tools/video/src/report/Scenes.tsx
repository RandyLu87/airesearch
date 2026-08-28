import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {DimensionChart} from './DimensionChart';
import {theme} from './theme';
import {str, strategyItems, type DimensionRef, type Scene} from './types';

const FadeIn: React.FC<{children: React.ReactNode; style?: React.CSSProperties}> = ({children, style}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 12], [0, 1], {extrapolateRight: 'clamp'});
  return <div style={{opacity, ...style}}>{children}</div>;
};

/** 标题卡：公司名 + 代码 + 数据截止日期 + 一句话定位。 */
const OpeningCard: React.FC<{scene: Scene; companyId: string | null; dataCutoff: string | null}> = ({
  scene,
  companyId,
  dataCutoff,
}) => {
  const positioning = str(scene.data.positioning) ?? scene.narration;
  return (
    <FadeIn style={{display: 'flex', flexDirection: 'column', gap: 28, maxWidth: 1480}}>
      <div style={{display: 'flex', alignItems: 'baseline', gap: 24}}>
        <div style={{fontSize: 84, fontWeight: 800, color: theme.text, lineHeight: 1.15}}>{scene.title}</div>
        {companyId ? (
          <div style={{fontSize: 34, color: theme.accent, fontFamily: 'ui-monospace, monospace'}}>{companyId}</div>
        ) : null}
      </div>
      <div style={{fontSize: 32, color: theme.textDim}}>
        长期价值调研 · 数据截止 {dataCutoff ?? '未标注'}
      </div>
      <div style={{height: 4, width: 240, backgroundColor: theme.accent}} />
      <div style={{fontSize: 40, lineHeight: 1.6, color: theme.text}}>{positioning}</div>
    </FadeIn>
  );
};

/** 维度分镜：左边七维度全景图（点亮当前维度），右边当前维度的分数与理由原文。 */
const DimensionSlide: React.FC<{scene: Scene; dimensions: DimensionRef[]}> = ({scene, dimensions}) => {
  const activeId = str(scene.data.dimensionId) ?? scene.id;
  const active = dimensions.find((item) => item.id === activeId);
  const conclusion = str(scene.data.conclusion);
  const hasScore = (active?.score ?? null) !== null;

  return (
    <div style={{display: 'flex', gap: 64, alignItems: 'center', width: '100%'}}>
      <DimensionChart dimensions={dimensions} activeId={activeId} />
      <FadeIn style={{flex: 1, display: 'flex', flexDirection: 'column', gap: 24}}>
        <div style={{fontSize: 28, color: theme.textDim}}>
          维度 {typeof scene.data.ordinal === 'number' ? scene.data.ordinal : '?'} / {dimensions.length}
        </div>
        <div style={{fontSize: 68, fontWeight: 800, color: theme.text}}>{scene.title}</div>
        <div style={{fontSize: 40, fontWeight: 700, color: hasScore ? theme.accent : theme.warn}}>
          信心度 {active?.scoreLabel ?? '暂无数据'}
        </div>
        {conclusion ? (
          <div style={{fontSize: 31, lineHeight: 1.65, color: theme.text}}>{conclusion}</div>
        ) : (
          <div style={{fontSize: 31, color: theme.warn}}>暂无数据（原报告该维度结论缺失）</div>
        )}
      </FadeIn>
    </div>
  );
};

/** 策略要点卡：适用人群 + 建议正文 + 触发条件逐条。 */
const StrategySlide: React.FC<{scene: Scene}> = ({scene}) => {
  const advice = str(scene.data.advice);
  const items = strategyItems(scene.data.items);
  const available = typeof scene.data.itemsAvailable === 'number' ? scene.data.itemsAvailable : items.length;

  return (
    <FadeIn style={{display: 'flex', flexDirection: 'column', gap: 30, maxWidth: 1560}}>
      <div style={{fontSize: 28, color: theme.textDim}}>策略建议</div>
      <div style={{fontSize: 72, fontWeight: 800, color: theme.text}}>给「{scene.title}」的建议</div>
      {advice ? (
        <div style={{fontSize: 33, lineHeight: 1.65, color: theme.text}}>{advice}</div>
      ) : (
        <div style={{fontSize: 33, color: theme.warn}}>暂无建议正文（原报告未填写）</div>
      )}
      {items.length > 0 ? (
        <div style={{display: 'flex', flexDirection: 'column', gap: 18, marginTop: 6}}>
          {items.map((item, index) => (
            <div
              key={index}
              style={{
                display: 'flex',
                gap: 22,
                padding: '22px 28px',
                borderRadius: 14,
                backgroundColor: theme.bgSoft,
                borderLeft: `6px solid ${theme.accent}`,
              }}
            >
              <div style={{flex: 1, fontSize: 29, lineHeight: 1.5, color: theme.text}}>
                <span style={{color: theme.accent}}>触发条件　</span>
                {str(item.condition) ?? '—'}
              </div>
              <div style={{flex: 1, fontSize: 29, lineHeight: 1.5, color: theme.text}}>
                <span style={{color: theme.accent}}>应对　</span>
                {str(item.action) ?? '—'}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{fontSize: 29, color: theme.warn}}>暂无触发条件</div>
      )}
      {available > items.length ? (
        <div style={{fontSize: 24, color: theme.textDim}}>
          原报告共 {available} 条触发条件，本片按控时只播报前 {items.length} 条
        </div>
      ) : null}
    </FadeIn>
  );
};

/** 免责声明结尾卡。 */
const ClosingCard: React.FC<{scene: Scene; companyName: string}> = ({scene, companyName}) => {
  const disclaimer = str(scene.data.disclaimer) ?? scene.narration;
  return (
    <FadeIn style={{display: 'flex', flexDirection: 'column', gap: 34, maxWidth: 1420, alignItems: 'center', textAlign: 'center'}}>
      <div style={{fontSize: 34, color: theme.accent}}>{scene.title}</div>
      <div style={{fontSize: 40, lineHeight: 1.7, color: theme.text}}>{disclaimer}</div>
      <div style={{height: 3, width: 200, backgroundColor: theme.muted}} />
      <div style={{fontSize: 28, color: theme.textDim}}>{companyName}</div>
    </FadeIn>
  );
};

export const SceneBody: React.FC<{
  scene: Scene;
  dimensions: DimensionRef[];
  companyName: string;
  companyId: string | null;
  dataCutoff: string | null;
}> = ({scene, dimensions, companyName, companyId, dataCutoff}) => {
  switch (scene.kind) {
    case 'opening':
      return <OpeningCard scene={scene} companyId={companyId} dataCutoff={dataCutoff} />;
    case 'dimension':
      return <DimensionSlide scene={scene} dimensions={dimensions} />;
    case 'strategy':
      return <StrategySlide scene={scene} />;
    default:
      return <ClosingCard scene={scene} companyName={companyName} />;
  }
};

/** 每个分镜共用的外框：顶部公司名/截止日期，底部整片进度条。 */
export const SceneFrame: React.FC<{
  children: React.ReactNode;
  header: string;
  footer: string;
  progress: number;
  centered: boolean;
}> = ({children, header, footer, progress, centered}) => (
  <AbsoluteFill style={{backgroundColor: theme.bg, fontFamily: theme.fontFamily, padding: '64px 88px'}}>
    <div style={{display: 'flex', justifyContent: 'space-between', fontSize: 26, color: theme.textDim}}>
      <div>{header}</div>
      <div>{footer}</div>
    </div>
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: centered ? 'center' : 'flex-start',
      }}
    >
      {children}
    </div>
    <div style={{height: 6, borderRadius: 3, backgroundColor: theme.muted}}>
      <div style={{height: 6, borderRadius: 3, width: `${progress * 100}%`, backgroundColor: theme.accent}} />
    </div>
  </AbsoluteFill>
);
