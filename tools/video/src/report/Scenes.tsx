import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {DimensionChart} from './DimensionChart';
import {theme} from './theme';
import {
  objectList,
  shareRatio,
  str,
  strategyItems,
  stringList,
  trendSide,
  type Beat,
  type Caption,
  type DimensionRef,
  type MoatType,
  type RevenueItem,
  type Scene,
} from './types';

const FadeIn: React.FC<{children: React.ReactNode; style?: React.CSSProperties}> = ({children, style}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 12], [0, 1], {extrapolateRight: 'clamp'});
  return <div style={{opacity, ...style}}>{children}</div>;
};

/**
 * 随语音点亮的要点：`from` 之前压暗，念到它时淡入并微微上移。
 *
 * 帧号由 scripts/report_props.mjs 按 TTS 的句级边界事件算好，模板不自己算时间——
 * 一屏停 30 秒不动是 MVP 里最难熬的段落，但「动」必须跟着念到哪儿走，
 * 否则就是另一种噪音。没有对应帧号的要点（beats 缺失）一律从第 0 帧就亮着。
 */
const Reveal: React.FC<{from: number | null; children: React.ReactNode; style?: React.CSSProperties}> = ({
  from,
  children,
  style,
}) => {
  const frame = useCurrentFrame();
  // from === null：这一条原报告里有、但本片按控时没念到。恒定压暗摆着，不参与点亮——
  // 它在画面上是可查的参考，不是正在讲的内容，用亮度把这个区别说清楚。
  const progress =
    from === null ? 0 : interpolate(frame, [from, from + 10], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <div
      style={{
        // 未点亮不是隐藏：整屏的排版从第一帧就定下来，点亮时不会跳版
        opacity: 0.32 + 0.68 * progress,
        transform: `translateY(${(1 - progress) * 10}px)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/** 第 index 条要点的点亮帧号；没念到的返回 null（恒定压暗）。 */
const beatFrom = (beats: Beat[], index: number): number | null => beats[index]?.from ?? null;

/**
 * 「原报告共 N 条，本片按控时只念了前 M 条」——只在真的没念全时出现。
 *
 * M 为 0 要单独说：「只播报前 0 条」是句病句，而且会让人以为原报告是空的。
 */
const SpokenNote: React.FC<{available: number; spoken: number; unit: string}> = ({available, spoken, unit}) => {
  if (available <= spoken) return null;
  return (
    <div style={{fontSize: 23, color: theme.textDim, marginTop: 6}}>
      {spoken === 0
        ? `原报告共 ${available} ${unit}，本片按控时都没有播报，仅画面压暗显示`
        : `原报告共 ${available} ${unit}，本片按控时只播报前 ${spoken} ${unit}（其余压暗显示）`}
    </div>
  );
};

/** 底部字幕条：按帧号显示当前这一句解说词原文。 */
const CaptionBar: React.FC<{captions: Caption[]}> = ({captions}) => {
  const frame = useCurrentFrame();
  const active = captions.find((caption) => frame >= caption.from && frame < caption.from + caption.durationInFrames);
  return (
    <div style={{minHeight: 68, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 40px'}}>
      {active ? (
        <div
          style={{
            fontSize: 30,
            lineHeight: 1.45,
            color: theme.text,
            textAlign: 'center',
            backgroundColor: theme.captionBg,
            padding: '10px 26px',
            borderRadius: 10,
            maxWidth: 1560,
          }}
        >
          {active.text}
        </div>
      ) : null}
    </div>
  );
};

/** 判定标签。颜色只是冗余编码，判定原文始终显示在标签里，不靠颜色传达结论。 */
const VerdictTag: React.FC<{verdict: string | null}> = ({verdict}) => {
  const color = verdict === '存在' ? theme.accent : verdict === '待验证' ? theme.warn : theme.textDim;
  return (
    <div
      style={{
        fontSize: 27,
        fontWeight: 700,
        color,
        border: `2px solid ${color}`,
        borderRadius: 8,
        padding: '4px 18px',
        whiteSpace: 'nowrap',
      }}
    >
      {verdict ?? '暂无判定'}
    </div>
  );
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
      ) : available > 0 ? (
        // 原报告有触发条件、只是被控时裁光了——说成「暂无」就是把裁剪讲成了事实缺失。
        <div style={{fontSize: 29, color: theme.warn}}>原报告共 {available} 条触发条件，本片按控时未播报</div>
      ) : (
        <div style={{fontSize: 29, color: theme.warn}}>暂无触发条件</div>
      )}
      {items.length > 0 && available > items.length ? (
        <div style={{fontSize: 24, color: theme.textDim}}>
          原报告共 {available} 条触发条件，本片按控时只播报前 {items.length} 条
        </div>
      ) : null}
    </FadeIn>
  );
};

/** 收入结构卡：各业务线的金额与占比，占比同时画成条形；逐条随语音点亮。 */
const RevenueSlide: React.FC<{scene: Scene}> = ({scene}) => {
  const items = objectList<RevenueItem>(scene.data.items);
  const available = typeof scene.data.itemsAvailable === 'number' ? scene.data.itemsAvailable : items.length;
  const spokenCount = typeof scene.data.spokenCount === 'number' ? scene.data.spokenCount : items.length;
  const period = str(scene.data.period);
  const canvas = [
    str(scene.data.salesModel) ? `销售模式 ${str(scene.data.salesModel)}` : null,
    str(scene.data.productForm) ? `产品形态 ${str(scene.data.productForm)}` : null,
  ].filter(Boolean);

  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 22, width: '100%', maxWidth: 1620}}>
      <FadeIn>
        <div style={{fontSize: 28, color: theme.textDim}}>收入结构{period ? `　·　${period}` : ''}</div>
        <div style={{fontSize: 62, fontWeight: 800, color: theme.text, marginTop: 8}}>钱从哪里来</div>
      </FadeIn>
      {canvas.length > 0 ? (
        <FadeIn style={{fontSize: 27, color: theme.textDim}}>{canvas.join('　·　')}</FadeIn>
      ) : null}
      <div style={{display: 'flex', flexDirection: 'column', gap: 16, marginTop: 4}}>
        {items.map((item, index) => {
          const ratio = shareRatio(item.sharePct);
          return (
            <Reveal key={index} from={beatFrom(scene.beats, index)}>
              <div style={{display: 'flex', alignItems: 'center', gap: 22}}>
                <div style={{width: 470, fontSize: 29, color: theme.text}}>{str(item.segment) ?? '—'}</div>
                <div style={{position: 'relative', flex: 1, height: 30, borderRadius: 15, backgroundColor: theme.muted}}>
                  {/* 占比认不出来就不画条，只留灰轨——和分数缺失时的处理同一个口径 */}
                  {ratio === null ? null : (
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        width: `${ratio * 100}%`,
                        borderRadius: 15,
                        backgroundColor: theme.accent,
                      }}
                    />
                  )}
                </div>
                <div style={{width: 200, fontSize: 27, color: theme.accent, textAlign: 'right'}}>
                  {str(item.sharePct) ?? '占比暂无'}
                </div>
                <div style={{width: 300, fontSize: 26, color: theme.textDim, textAlign: 'right'}}>
                  {str(item.revenue) ?? '金额暂无'}
                </div>
              </div>
            </Reveal>
          );
        })}
      </div>
      <SpokenNote available={available} spoken={spokenCount} unit="条业务线" />
    </div>
  );
};

/** 经济特征卡：粘性判定 + 粘性机制与经营杠杆的要点，逐条随语音点亮。 */
const EconomicsSlide: React.FC<{scene: Scene}> = ({scene}) => {
  const level = str(scene.data.level);
  const groups: Array<[string, string, string[]]> = [
    ['mechanism', '粘性靠什么', stringList(scene.data.mechanism)],
    ['leverage', '经营杠杆', stringList(scene.data.leverage)],
  ];

  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 22, width: '100%', maxWidth: 1620}}>
      <FadeIn style={{display: 'flex', alignItems: 'baseline', gap: 26}}>
        <div style={{fontSize: 62, fontWeight: 800, color: theme.text}}>这门生意的经济特征</div>
        <div style={{fontSize: 32, color: level ? theme.accent : theme.warn}}>
          用户粘性 {level ?? '暂无判定'}
        </div>
      </FadeIn>
      {groups.map(([group, label, points]) => {
        if (points.length === 0) return null;
        const beats = scene.beats.filter((beat) => beat.group === group);
        return (
          <div key={group} style={{display: 'flex', flexDirection: 'column', gap: 12}}>
            <div style={{fontSize: 26, color: theme.textDim}}>{label}</div>
            {points.map((point, index) => (
              <Reveal key={index} from={beatFrom(beats, index)}>
                <div
                  style={{
                    fontSize: 28,
                    lineHeight: 1.5,
                    color: theme.text,
                    backgroundColor: theme.bgSoft,
                    borderLeft: `6px solid ${theme.accent}`,
                    borderRadius: 12,
                    padding: '14px 24px',
                  }}
                >
                  {point}
                </div>
              </Reveal>
            ))}
          </div>
        );
      })}
    </div>
  );
};

/** 护城河清单卡：五类壁垒逐条给出判定，随语音一行行点亮。 */
const MoatChecklistSlide: React.FC<{scene: Scene}> = ({scene}) => {
  const items = objectList<MoatType>(scene.data.items);
  const spokenTest = scene.data.spokenTest !== false;

  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 20, width: '100%', maxWidth: 1620}}>
      <FadeIn>
        <div style={{fontSize: 28, color: theme.textDim}}>护城河</div>
        <div style={{fontSize: 62, fontWeight: 800, color: theme.text, marginTop: 8}}>逐条检验</div>
      </FadeIn>
      {items.map((item, index) => (
        <Reveal key={index} from={beatFrom(scene.beats, index)}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 26,
              backgroundColor: theme.bgSoft,
              borderRadius: 12,
              padding: '16px 26px',
            }}
          >
            <div style={{width: 260, fontSize: 30, fontWeight: 700, color: theme.text}}>{str(item.type) ?? '—'}</div>
            <div style={{flex: 1, fontSize: 26, color: theme.textDim, lineHeight: 1.45}}>
              {/* 检验问题即使因控时没念，画面上仍然给着：屏幕能承载的比耳朵多 */}
              {spokenTest ? str(item.test) ?? '' : str(item.test) ?? ''}
            </div>
            <VerdictTag verdict={str(item.verdict)} />
          </div>
        </Reveal>
      ))}
    </div>
  );
};

/** 护城河趋势卡：过去五年与未来五年并排，方向 + 判断依据逐条点亮。 */
const MoatTrendSlide: React.FC<{scene: Scene}> = ({scene}) => {
  const sides: Array<[string, ReturnType<typeof trendSide>]> = [
    ['past', trendSide(scene.data.past)],
    ['next', trendSide(scene.data.next)],
  ];

  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 24, width: '100%', maxWidth: 1620}}>
      <FadeIn style={{fontSize: 62, fontWeight: 800, color: theme.text}}>护城河的过去与未来</FadeIn>
      <div style={{display: 'flex', gap: 34, alignItems: 'stretch'}}>
        {sides.map(([key, side]) => {
          if (side === null) return null;
          const beats = scene.beats.filter((beat) => beat.group === key);
          const points = stringList(side.points);
          const spoken = typeof (side as {spokenCount?: number}).spokenCount === 'number' ? (side as {spokenCount: number}).spokenCount : points.length;
          return (
            <div
              key={key}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                gap: 16,
                backgroundColor: theme.bgSoft,
                borderRadius: 14,
                padding: '26px 30px',
              }}
            >
              <div style={{fontSize: 28, color: theme.textDim}}>{str(side.label) ?? ''}</div>
              <div style={{fontSize: 46, fontWeight: 800, color: side.direction ? theme.accent : theme.warn}}>
                {str(side.direction) ?? '暂无判断'}
              </div>
              {points.map((point, index) => (
                <Reveal key={index} from={beatFrom(beats, index)}>
                  <div style={{fontSize: 26, lineHeight: 1.55, color: theme.text}}>{point}</div>
                </Reveal>
              ))}
              <SpokenNote available={points.length} spoken={spoken} unit="条依据" />
            </div>
          );
        })}
      </div>
    </div>
  );
};

/** 十年之问卡：问题在上，回答要点逐条点亮。 */
const InquirySlide: React.FC<{scene: Scene}> = ({scene}) => {
  const question = str(scene.data.question);
  const points = stringList(scene.data.points);
  const spokenCount = typeof scene.data.spokenCount === 'number' ? scene.data.spokenCount : points.length;

  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 22, width: '100%', maxWidth: 1560}}>
      <FadeIn>
        <div style={{fontSize: 28, color: theme.textDim}}>十年之问</div>
        <div style={{fontSize: 50, fontWeight: 800, color: theme.text, marginTop: 10, lineHeight: 1.3}}>
          {question ?? '原报告未记录这一问'}
        </div>
        <div style={{height: 4, width: 240, backgroundColor: theme.accent, marginTop: 18}} />
      </FadeIn>
      {points.map((point, index) => (
        <Reveal key={index} from={beatFrom(scene.beats, index)}>
          <div style={{fontSize: 29, lineHeight: 1.55, color: theme.text}}>{point}</div>
        </Reveal>
      ))}
      <SpokenNote available={points.length} spoken={spokenCount} unit="条回答要点" />
    </div>
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
    case 'business-model':
      // 一个 kind 两屏：收入结构与经济特征，靠 data.focus 分流
      return scene.data.focus === 'economics' ? <EconomicsSlide scene={scene} /> : <RevenueSlide scene={scene} />;
    case 'moat-checklist':
      return <MoatChecklistSlide scene={scene} />;
    case 'moat-trend':
      return <MoatTrendSlide scene={scene} />;
    case 'inquiry':
      return <InquirySlide scene={scene} />;
    default:
      return <ClosingCard scene={scene} companyName={companyName} />;
  }
};

/** 每个分镜共用的外框：顶部公司名/截止日期，底部字幕条与整片进度条。 */
export const SceneFrame: React.FC<{
  children: React.ReactNode;
  header: string;
  footer: string;
  progress: number;
  centered: boolean;
  captions: Caption[];
}> = ({children, header, footer, progress, centered, captions}) => (
  <AbsoluteFill style={{backgroundColor: theme.bg, fontFamily: theme.fontFamily, padding: '56px 88px 48px'}}>
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
        // 正文区和字幕条之间留出固定间距，字幕出现时正文不会被顶得跳动
        paddingBottom: 12,
      }}
    >
      {children}
    </div>
    <CaptionBar captions={captions} />
    <div style={{height: 6, borderRadius: 3, backgroundColor: theme.muted, marginTop: 14}}>
      <div style={{height: 6, borderRadius: 3, width: `${progress * 100}%`, backgroundColor: theme.accent}} />
    </div>
  </AbsoluteFill>
);
