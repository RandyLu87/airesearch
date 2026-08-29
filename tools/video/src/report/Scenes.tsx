import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {ChartView, HeroMetric} from './Charts';
import {DimensionChart} from './DimensionChart';
import {theme} from './theme';
import {
  objectList,
  shareRatio,
  str,
  strategyItems,
  headlinePoints,
  stringList,
  trendSide,
  type Beat,
  type Caption,
  type Chart,
  type DimensionRef,
  type Hero,
  type MoatType,
  type RevenueItem,
  type Scene,
} from './types';

/**
 * 屏幕不复述解说词。
 *
 * 底部字幕条已经逐句显示着正在念的那段话，正文区再把同一段结论抄一遍，就是同一句话
 * 在一屏上出现两次——这是原来「文本太多」最大的一处来源。所以正文区只在两种情况下出字：
 *
 *   1. 这段文字**比解说词多**（`detail !== 'full'`，即本片按控时没念全），压暗显示，
 *      让人看得到报告里还有什么；
 *   2. 它本来就是一份可扫读的清单（护城河逐条检验、触发条件），耳朵记不住、眼睛能。
 *
 * 大段结论散文两条都不占，交给字幕条。
 */
const carriesMoreThanSpoken = (scene: Scene): boolean => (str(scene.data.detail) ?? 'full') !== 'full';

/** 一屏最多列几条要点。超出的部分画面不列、也不作说明——「原报告共 N 条」是制作
 *  过程的自述，不该上屏；这层账记在分镜稿的 `itemsAvailable` 里。 */
const MAX_POINTS_PER_SCREEN = 4;
const MAX_POINTS_PER_GROUP = 2;

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
  // from === null：这一条报告里有、但本片按控时没念到。恒定压暗摆着，不参与点亮——
  // 它在画面上是可查的参考，不是正在讲的内容，用亮度把这个区别说清楚。
  const progress =
    from === null ? 0 : interpolate(frame, [from, from + 10], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <div
      style={{
        // 未点亮不是隐藏：整屏的排版从第一帧就定下来，点亮时不会跳版。
        // 浅色下起点要比深色高一档——纸面上 0.3 的墨色已经淡到读不出字了。
        opacity: 0.45 + 0.55 * progress,
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

/*
 * 这里原来有一个 `SpokenNote`：在画面上写「原报告共 N 条，本片按控时只播报前 M 条」。
 * 已经删掉——**那是制作过程的自述，不是内容**。观众不需要知道这支片子怎么排的时长，
 * 屏幕上多一行这样的字，只会把真正要看的东西挤下去。
 *
 * 「没念到的那几条」这层信息并没有丢，只是搬回了它该在的地方：分镜稿的
 * `itemsAvailable` / `spokenCount` 与 `omissions`。那是给人核对用的账，本来就不该上屏。
 *
 * 注意仍然守住一条：**不能把裁剪讲成缺失**。被控时裁光时画面什么都不说（不作断言），
 * 只有原报告本来就没有时才写「暂无」。
 */

/**
 * 字幕的版面常量。**改任何一个都必须让 `CAPTION_ZONE` 跟着重算**，
 * 所以这里不写死高度，而是从字号、行高、行数上限推出来——手写一个数迟早会和字号对不上。
 */
const CAPTION_FONT = 38;
const CAPTION_LINE_HEIGHT = 1.5;
const CAPTION_PADDING_Y = 12;
/** 字幕框底边离画面底的距离：进度条（6px）+ 外框下内边距（48px）之上再留 18px 呼吸。 */
const CAPTION_BOTTOM = 72;
/**
 * 按几行来预留高度。观察值：茅台这条片子最长的一句 84 字，在下面的 `CAPTION_MAX_WIDTH`
 * 下占 2 行；留到 3 行是给别家公司更长的句子留的余量——字幕是从底部往上长的，
 * 真长出第三行时会往正文里挤，与其到时候悄悄压住一行正文，不如现在就把位置让出来。
 */
const CAPTION_MAX_LINES = 3;
const CAPTION_MAX_WIDTH = 1680;

/**
 * 正文区的底部安全距，从进度条上沿（离画面底 54px）往上量。
 *
 * = 字幕框底边高度 + 最高时的框高 − 进度条上沿高度，再留 4px 余量。
 * 有了它，正文的垂直居中位置与「当前有没有字幕、字幕几行」完全无关。
 */
const CAPTION_ZONE =
  CAPTION_BOTTOM + Math.round(CAPTION_FONT * CAPTION_LINE_HEIGHT * CAPTION_MAX_LINES) + CAPTION_PADDING_Y * 2 - 54 + 4;

/** 出入场过渡的帧数上限（约 0.2 秒）；短句会按自身时长等比缩短，见下。 */
const CAPTION_FADE = 6;

/**
 * 底部字幕条：按帧号显示当前这一句解说词原文。
 *
 * **绝对定位，完全不参与版面流**。它原来是 flex 列里的一个子元素，`minHeight: 68` 只保得住
 * 单行；一旦某句话长到换成两行，这一格就撑到 90 多像素，把上面整屏正文顶起来——
 * 于是每换一句字幕，画面就抖一下。现在它浮在正文之上，出现与消失都不动别人一个像素，
 * 正文区改用固定的 `CAPTION_ZONE` 预留安全距，两边各管各的。
 *
 * 垂直方向从底部对齐（`bottom` 固定、`top` 不设）：多出来的行往上长，而不是把自己顶下去
 * 压住进度条。
 *
 * 过渡：每句自己淡入、淡出，并带 10px 的上浮。相邻两句是**首尾相接**的（上一句的结束帧
 * 就是下一句的起始帧），所以两段渐变拼起来正好是一次「旧句褪去 → 新句浮起」的交接，
 * 而不是硬切。交接点上不透明度为 0，此时换文字、框宽突变都看不见。
 */
const CaptionBar: React.FC<{captions: Caption[]}> = ({captions}) => {
  const frame = useCurrentFrame();
  const active = captions.find((caption) => frame >= caption.from && frame < caption.from + caption.durationInFrames);
  if (!active) return null;

  // 极短的句子（「判定为存在。」这类）不能用满 6 帧淡入淡出，否则整句都在渐变里、
  // 没有一帧是完全清晰的。按自身时长的四分之一封顶，至少留 2 帧。
  const fade = Math.max(2, Math.min(CAPTION_FADE, Math.floor(active.durationInFrames / 4)));
  const local = frame - active.from;
  const appear = interpolate(local, [0, fade], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const vanish = interpolate(local, [active.durationInFrames - fade, active.durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        position: 'absolute',
        left: 88,
        right: 88,
        bottom: CAPTION_BOTTOM,
        display: 'flex',
        justifyContent: 'center',
        // 淡入与淡出取较小值：句子短到两段渐变重叠时，自然收敛成一次轻微的呼吸
        opacity: Math.min(appear, vanish),
        // 上浮只跟淡入走：进场时往上托一下，退场是原地褪去，不再动一次
        transform: `translateY(${(1 - appear) * 10}px)`,
      }}
    >
      <div
        style={{
          fontSize: CAPTION_FONT,
          lineHeight: CAPTION_LINE_HEIGHT,
          // 500 而不是常规字重：字幕是压在图表和正文之上的，细一档就会和背后的线条纠缠
          fontWeight: 500,
          color: theme.text,
          textAlign: 'center',
          backgroundColor: theme.captionBg,
          border: `1px solid ${theme.captionBorder}`,
          padding: `${CAPTION_PADDING_Y}px 30px`,
          borderRadius: 12,
          maxWidth: CAPTION_MAX_WIDTH,
        }}
      >
        {active.text}
      </div>
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

/** 分镜的小标题（眼睛用来定位「现在这屏在讲什么」），统一样式。 */
const SlideTitle: React.FC<{eyebrow?: string; title: string}> = ({eyebrow, title}) => (
  <FadeIn>
    {eyebrow ? <div style={{fontSize: 26, color: theme.textDim}}>{eyebrow}</div> : null}
    <div style={{fontSize: 56, fontWeight: 800, color: theme.text, marginTop: eyebrow ? 6 : 0}}>{title}</div>
  </FadeIn>
);

/** 压暗的补充正文：本片没念全时才出现。不加「报告原文」这类前缀——
 *  屏幕上出现「报告」两个字就是在讲制作过程，观众要看的是内容本身。 */
const Supplement: React.FC<{text: string}> = ({text}) => (
  <div style={{fontSize: 26, lineHeight: 1.55, color: theme.textDim, opacity: 0.85, maxWidth: 1500}}>
    {text}
  </div>
);

/**
 * 画面重点：讲稿加工件给这一屏写的一句话（`data.headline`，上限 24 字）。
 *
 * 它替代的是「把研究结论整段搬上屏」那种做法——那样观众在十几秒里读不完，
 * 于是既没读也没听。一句话能读完，剩下的交给解说展开。
 *
 * 没有加工件时返回 null，各屏退回原来的排版，不留空档。
 */
const Headline: React.FC<{scene: Scene}> = ({scene}) => {
  const points = headlinePoints(scene);
  if (points.length === 0) return null;
  // 一条时不加项目符号：单点加个圆点像是列表只写了一半
  if (points.length === 1) {
    return (
      <div style={{fontSize: 38, fontWeight: 700, lineHeight: 1.4, color: theme.text, maxWidth: 1200}}>{points[0]}</div>
    );
  }
  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 1200}}>
      {points.map((point, index) => (
        <div key={index} style={{display: 'flex', alignItems: 'baseline', gap: 14}}>
          <div style={{width: 10, height: 10, borderRadius: 5, backgroundColor: theme.accent, flexShrink: 0}} />
          <div style={{fontSize: 34, fontWeight: 700, lineHeight: 1.35, color: theme.text}}>{point}</div>
        </div>
      ))}
    </div>
  );
};

const heroOf = (scene: Scene): Hero | null => scene.visuals?.hero ?? null;
const chartOf = (scene: Scene): Chart | null => scene.visuals?.chart ?? null;

/**
 * 标题卡：公司名 + 数据截止 + 一句话定位 + 关键指标。
 *
 * 不显示 `companyId`（`sh-600519-kweichow-moutai`）——那是仓库里的目录名，
 * 是给渲染层认文件用的内部编号，不是观众需要看到的东西。
 */
const OpeningCard: React.FC<{scene: Scene; dataCutoff: string | null}> = ({scene, dataCutoff}) => {
  const positioning = str(scene.data.positioning) ?? scene.narration;
  const hero = heroOf(scene);
  const chart = chartOf(scene);
  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 26, width: '100%'}}>
      <FadeIn style={{display: 'flex', flexDirection: 'column', gap: 16}}>
        <div style={{fontSize: 78, fontWeight: 800, color: theme.text, lineHeight: 1.15}}>{scene.title}</div>
        <div style={{fontSize: 28, color: theme.textDim}}>长期价值调研 · 数据截止 {dataCutoff ?? '未标注'}</div>
        <div style={{height: 4, width: 240, backgroundColor: theme.accent}} />
      </FadeIn>
      {hero ? (
        <FadeIn>
          <HeroMetric hero={hero} />
        </FadeIn>
      ) : (
        // 没有可画的数就把定位语放大顶上——开场屏不能是空的
        <FadeIn style={{fontSize: 36, lineHeight: 1.6, color: theme.text, maxWidth: 1560}}>{positioning}</FadeIn>
      )}
      {chart ? <ChartView chart={chart} /> : null}
    </div>
  );
};

/**
 * 维度分镜：左边七维度全景图（点亮当前维度），右边这一维的分数与图。
 *
 * 不再显示「维度 3 / 7」这类序号：左边的全景图本来就把「七条里点亮的是哪条」画出来了，
 * 再写一遍序号是同一件事说两次。结论正文交给字幕条，只有没念全时才压暗补出来。
 */
const DimensionSlide: React.FC<{scene: Scene; dimensions: DimensionRef[]}> = ({scene, dimensions}) => {
  const activeId = str(scene.data.dimensionId) ?? scene.id;
  const active = dimensions.find((item) => item.id === activeId);
  const conclusion = str(scene.data.conclusion);
  const hasScore = (active?.score ?? null) !== null;
  const hero = heroOf(scene);
  const chart = chartOf(scene);

  return (
    <div style={{display: 'flex', gap: chart ? 48 : 64, alignItems: 'center', width: '100%'}}>
      <DimensionChart dimensions={dimensions} activeId={activeId} compact={chart !== null} />
      <FadeIn style={{flex: 1, display: 'flex', flexDirection: 'column', gap: chart ? 16 : 24}}>
        <div style={{fontSize: 56, fontWeight: 800, color: theme.text}}>{scene.title}</div>
        {/* 信心度就是这一维的主数字：把它放大，而不是混在一行小字里 */}
        <div style={{display: 'flex', alignItems: 'baseline', gap: 14}}>
          <div style={{fontSize: 26, color: theme.textDim}}>信心度</div>
          <div style={{fontSize: 64, fontWeight: 800, color: hasScore ? theme.accent : theme.warn, lineHeight: 1}}>
            {active?.scoreLabel ?? '暂无数据'}
          </div>
        </div>
        <Headline scene={scene} />
        {hero ? <HeroMetric hero={hero} size="medium" /> : null}
        {chart ? <ChartView chart={chart} width={880} /> : null}
        {/* 有 headline 就不再补原文摘要：一屏两段文字，观众两段都读不完 */}
        {conclusion === null ? (
          <div style={{fontSize: 29, color: theme.warn}}>暂无数据</div>
        ) : !chart && headlinePoints(scene).length === 0 && carriesMoreThanSpoken(scene) ? (
          <Supplement text={conclusion} />
        ) : null}
      </FadeIn>
    </div>
  );
};

/** 策略要点卡：触发条件逐条。建议正文归字幕条，只有没念全时才压暗补出来。 */
const StrategySlide: React.FC<{scene: Scene}> = ({scene}) => {
  const advice = str(scene.data.advice);
  const items = strategyItems(scene.data.items);
  const available = typeof scene.data.itemsAvailable === 'number' ? scene.data.itemsAvailable : items.length;
  const shown = items.slice(0, MAX_POINTS_PER_SCREEN);

  return (
    <FadeIn style={{display: 'flex', flexDirection: 'column', gap: 26, maxWidth: 1620, width: '100%'}}>
      <SlideTitle eyebrow="策略建议" title={`给「${scene.title}」的建议`} />
      <Headline scene={scene} />
      {/* 有 headline 就不再补建议正文：一屏两段文字，观众两段都读不完 */}
      {advice === null ? (
        <div style={{fontSize: 30, color: theme.warn}}>暂无建议</div>
      ) : headlinePoints(scene).length === 0 && carriesMoreThanSpoken(scene) ? (
        <Supplement text={advice} />
      ) : null}
      {shown.length > 0 ? (
        <div style={{display: 'flex', flexDirection: 'column', gap: 16}}>
          {shown.map((item, index) => (
            <Reveal key={index} from={beatFrom(scene.beats, index)}>
              <div
                style={{
                  display: 'flex',
                  gap: 22,
                  padding: '20px 26px',
                  borderRadius: 14,
                  backgroundColor: theme.bgSoft,
                  borderLeft: `6px solid ${theme.accent}`,
                }}
              >
                <div style={{flex: 1, fontSize: 27, lineHeight: 1.5, color: theme.text}}>
                  <span style={{color: theme.accent}}>触发条件　</span>
                  {str(item.condition) ?? '—'}
                </div>
                <div style={{flex: 1, fontSize: 27, lineHeight: 1.5, color: theme.text}}>
                  <span style={{color: theme.accent}}>应对　</span>
                  {str(item.action) ?? '—'}
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      ) : available > 0 ? (
        // 有触发条件、只是被控时裁光了：**什么都不写**。
        // 写「暂无」是把裁剪讲成事实缺失，写「本片未播报」又是把制作过程搬上屏——
        // 不作断言才是对的，这层信息在分镜稿的 itemsAvailable 里留着。
        null
      ) : (
        <div style={{fontSize: 28, color: theme.warn}}>暂无触发条件</div>
      )}
    </FadeIn>
  );
};

/** 收入结构卡：总收入主数字 + 各业务线占比条 + 分部同比。 */
const RevenueSlide: React.FC<{scene: Scene}> = ({scene}) => {
  const items = objectList<RevenueItem>(scene.data.items);
  const available = typeof scene.data.itemsAvailable === 'number' ? scene.data.itemsAvailable : items.length;
  const spokenCount = typeof scene.data.spokenCount === 'number' ? scene.data.spokenCount : items.length;
  const hero = heroOf(scene);
  const chart = chartOf(scene);
  const shown = items.slice(0, MAX_POINTS_PER_SCREEN);
  // 占比条和同比柱一起放得下才一起放：两块都超过四行就会顶到字幕条上
  const withChart = chart !== null && shown.length <= MAX_POINTS_PER_SCREEN;

  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 20, width: '100%', maxWidth: 1680}}>
      <div style={{display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 40}}>
        <SlideTitle eyebrow="收入结构" title="钱从哪里来" />
        {hero ? (
          <FadeIn>
            <HeroMetric hero={hero} size="medium" />
          </FadeIn>
        ) : null}
      </div>
      <div style={{display: 'flex', flexDirection: 'column', gap: 14}}>
        {shown.map((item, index) => {
          const ratio = shareRatio(item.sharePct);
          return (
            <Reveal key={index} from={beatFrom(scene.beats, index)}>
              <div style={{display: 'flex', alignItems: 'center', gap: 22}}>
                <div style={{width: 430}}>
                  <div style={{fontSize: 28, color: theme.text}}>{str(item.segment) ?? '—'}</div>
                  {/* 口径括注：金额/占比列只放数值，否则一条「（占茅台酒+系列酒合计口径）」
                      就能把两列撑成三行。信息不丢，只是挪到名称底下当附注。 */}
                  {str(item.note) ? (
                    <div style={{fontSize: 20, color: theme.textDim, lineHeight: 1.35, marginTop: 4}}>
                      {str(item.note)}
                    </div>
                  ) : null}
                </div>
                <div style={{position: 'relative', flex: 1, height: 28, borderRadius: 14, backgroundColor: theme.muted}}>
                  {/* 占比认不出来就不画条，只留灰轨——和分数缺失时的处理同一个口径 */}
                  {ratio === null ? null : (
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        width: `${ratio * 100}%`,
                        borderRadius: 14,
                        backgroundColor: theme.accent,
                      }}
                    />
                  )}
                </div>
                <div style={{width: 180, fontSize: 26, color: theme.accent, textAlign: 'right'}}>
                  {str(item.sharePct) ?? '占比暂无'}
                </div>
                <div style={{width: 260, fontSize: 25, color: theme.textDim, textAlign: 'right'}}>
                  {str(item.revenue) ?? '金额暂无'}
                </div>
              </div>
            </Reveal>
          );
        })}
      </div>
      {withChart ? (
        <FadeIn style={{marginTop: 8, borderTop: `2px solid ${theme.line}`, paddingTop: 18}}>
          <ChartView chart={chart!} />
        </FadeIn>
      ) : null}
    </div>
  );
};

/** 经济特征卡：利润率趋势图在左，粘性机制与经营杠杆的要点在右。 */
const EconomicsSlide: React.FC<{scene: Scene}> = ({scene}) => {
  const level = str(scene.data.level);
  const chart = chartOf(scene);
  const groups: Array<[string, string, string[]]> = [
    ['mechanism', '粘性靠什么', stringList(scene.data.mechanism)],
    ['leverage', '经营杠杆', stringList(scene.data.leverage)],
  ];

  const points = (
    <div style={{flex: 1, display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0}}>
      {groups.map(([group, label, all]) => {
        if (all.length === 0) return null;
        const beats = scene.beats.filter((beat) => beat.group === group);
        const shown = all.slice(0, MAX_POINTS_PER_GROUP);
        return (
          <div key={group} style={{display: 'flex', flexDirection: 'column', gap: 10}}>
            <div style={{fontSize: 25, color: theme.textDim}}>{label}</div>
            {shown.map((point, index) => (
              <Reveal key={index} from={beatFrom(beats, index)}>
                <div
                  style={{
                    fontSize: 25,
                    lineHeight: 1.45,
                    color: theme.text,
                    backgroundColor: theme.bgSoft,
                    borderLeft: `6px solid ${theme.accent}`,
                    borderRadius: 12,
                    padding: '12px 20px',
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

  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 20, width: '100%', maxWidth: 1700}}>
      <div style={{display: 'flex', alignItems: 'flex-end', gap: 26}}>
        <SlideTitle title="这门生意的经济特征" />
        <div style={{fontSize: 30, color: level ? theme.accent : theme.warn, paddingBottom: 8}}>
          用户粘性 {level ?? '暂无判定'}
        </div>
      </div>
      <div style={{display: 'flex', gap: 44, alignItems: 'flex-start', width: '100%'}}>
        {chart ? (
          <FadeIn>
            <ChartView chart={chart} width={780} />
          </FadeIn>
        ) : null}
        {points}
      </div>
    </div>
  );
};

/**
 * 护城河整体判定：五类壁垒的结论并排给出，一眼扫完。
 *
 * 这屏原来是「逐条检验」——每类壁垒占一行，行里还带着检验问题
 * （「是否能在不损失销量的情况下提价？」），解说也一条一条念过去。检验问题是**研究方法**，
 * 不是结论；把它搬上屏又念一遍，等于用三十多秒讲了一遍流程。现在只留结论：
 * 五张卡并排，判定各自成色，解说一句话给全貌，省下的时间挪给「过去与未来」那一屏。
 *
 * 没有 `beats`（整体陈述没有逐条节奏），所以不套 `Reveal`——五张卡随屏一起淡入。
 */
const MoatOverviewSlide: React.FC<{scene: Scene}> = ({scene}) => {
  const items = objectList<MoatType>(scene.data.items);

  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 30, width: '100%', maxWidth: 1680}}>
      <SlideTitle eyebrow="护城河" title="整体判定" />
      <FadeIn style={{display: 'flex', gap: 18, width: '100%'}}>
        {items.map((item, index) => {
          const verdict = str(item.verdict);
          const note = str(item.verdictNote);
          // 与 VerdictTag 同一套口径：颜色只是冗余编码，判定原文始终写在卡里。
          // 用 startsWith 而不是全等：`存在但已降级` / `商户侧待验证` 这类带限定语的判定
          // 也要拿到对应的成色，否则五张卡里只有写得最规整的那张有颜色。
          const color = verdict?.startsWith('存在')
            ? theme.accent
            : verdict?.includes('待验证')
              ? theme.warn
              : theme.textDim;
          return (
            <div
              key={index}
              style={{
                flex: 1,
                backgroundColor: theme.bgSoft,
                borderRadius: 14,
                borderTop: `5px solid ${color}`,
                padding: '30px 26px',
                display: 'flex',
                flexDirection: 'column',
                gap: 18,
                // 这一屏只有五张卡，撑不满就会显得没做完；卡片本身做大是最省事的填充方式
                minHeight: 230,
              }}
            >
              <div style={{fontSize: 30, fontWeight: 700, color: theme.text, lineHeight: 1.3}}>
                {str(item.type) ?? '—'}
              </div>
              {/* 判定标签用大号字，但**必须封顶行数**：研究侧偶尔把整段判定写进 verdict，
                  script_gen 已经切掉了说明部分，认不出判定词时仍可能是一长串——
                  没有这道 clamp，它会撑出卡片盖住下面的字幕条。 */}
              <div
                style={{
                  fontSize: 42,
                  fontWeight: 800,
                  color,
                  marginTop: 'auto',
                  lineHeight: 1.25,
                  display: '-webkit-box',
                  WebkitBoxOrient: 'vertical',
                  WebkitLineClamp: 2,
                  overflow: 'hidden',
                }}
              >
                {verdict ?? '暂无判定'}
              </div>
              {/* 说明压暗、小号、封三行：它是「可查的参考」，不是这一屏的结论。
                  屏幕不花时间，但也不能花掉版面。 */}
              {note ? (
                <div
                  style={{
                    fontSize: 21,
                    lineHeight: 1.45,
                    color: theme.textDim,
                    display: '-webkit-box',
                    WebkitBoxOrient: 'vertical',
                    WebkitLineClamp: 3,
                    overflow: 'hidden',
                  }}
                >
                  {note}
                </div>
              ) : null}
            </div>
          );
        })}
      </FadeIn>
    </div>
  );
};

/**
 * 护城河趋势卡：过去五年与未来五年并排。
 *
 * **重心明确偏向未来那一栏**：过去是已经发生的事，未来才是这屏的结论。
 * 所以未来栏占更宽的份额、加一道强调描边，并把它的**第一条依据单独提出来当「核心依据」**——
 * 一个方向判断没有依据就只是个断言，而混在一串并列句里的依据等于没有强调。
 *
 * 「核心依据」只认第一条，与 script_gen 的 `_render_trend` 同一个口径：契约里 ①②③④
 * 是按重要性写的。挑哪条更重要是研究者的判断，模板不做语义挑选。
 */
const MoatTrendSlide: React.FC<{scene: Scene}> = ({scene}) => {
  const sides: Array<[string, ReturnType<typeof trendSide>]> = [
    ['past', trendSide(scene.data.past)],
    ['next', trendSide(scene.data.next)],
  ];

  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 22, width: '100%', maxWidth: 1680}}>
      <SlideTitle title="护城河的过去与未来" />
      <div style={{display: 'flex', gap: 30, alignItems: 'stretch'}}>
        {sides.map(([key, side]) => {
          if (side === null) return null;
          const isNext = key === 'next';
          const beats = scene.beats.filter((beat) => beat.group === key);
          const all = stringList(side.points);
          const spoken = typeof side.spokenCount === 'number' ? side.spokenCount : all.length;
          const shown = all.slice(0, isNext ? MAX_POINTS_PER_SCREEN : MAX_POINTS_PER_GROUP);
          return (
            <div
              key={key}
              // 未来栏拿到 1.45 倍宽度：它要装下核心依据卡，也是想让人先看它
              style={{
                flex: isNext ? 1.45 : 1,
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
                backgroundColor: theme.bgSoft,
                borderRadius: 14,
                border: isNext ? `2px solid ${theme.accent}` : `1px solid ${theme.line}`,
                padding: '24px 28px',
              }}
            >
              <div style={{fontSize: 26, color: theme.textDim}}>{str(side.label) ?? ''}</div>
              {/* 方向判断就是这一栏的主数字：变宽还是变窄，是这屏唯一要记住的事 */}
              <div
                style={{
                  fontSize: isNext ? 58 : 42,
                  fontWeight: 800,
                  color: side.direction ? theme.accent : theme.warn,
                  lineHeight: 1.1,
                }}
              >
                {str(side.direction) ?? '暂无判断'}
              </div>
              {shown.map((point, index) => {
                const isCore = isNext && index === 0;
                return (
                  <Reveal key={index} from={beatFrom(beats, index)}>
                    <div
                      style={
                        isCore
                          ? {
                              fontSize: 26,
                              lineHeight: 1.5,
                              color: theme.text,
                              backgroundColor: theme.bg,
                              borderLeft: `6px solid ${theme.accent}`,
                              borderRadius: 10,
                              padding: '14px 20px',
                            }
                          : {fontSize: 24, lineHeight: 1.5, color: theme.text}
                      }
                    >
                      {isCore ? (
                        <div style={{fontSize: 21, fontWeight: 700, color: theme.accent, marginBottom: 6}}>核心依据</div>
                      ) : null}
                      {point}
                    </div>
                  </Reveal>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
};

/**
 * 提问卡：问题在上，回答要点逐条点亮。
 *
 * 片子里有两屏用它——护城河的「十年之问」和逆向思考的「聪明人为什么会不买/做空这家公司？」。
 * 所以眉标题取 `scene.title` 而不是写死：写死过一次「十年之问」，第二屏挂上来就会
 * 顶着别人的标题讲自己的内容。
 */
const InquirySlide: React.FC<{scene: Scene}> = ({scene}) => {
  const question = str(scene.data.question);
  const all = stringList(scene.data.points);
  const spokenCount = typeof scene.data.spokenCount === 'number' ? scene.data.spokenCount : all.length;
  const chart = chartOf(scene);
  // 有图的那屏只是变窄，没有变矮——矩阵有五百多像素高，右栏放两条要点会空掉大半屏。
  // 所以条数不减，只把字号收一档让它们在窄栏里排得开。
  const shown = all.slice(0, MAX_POINTS_PER_SCREEN);

  const points = (
    <div style={{flex: 1, display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0}}>
      {shown.map((point, index) => (
        <Reveal key={index} from={beatFrom(scene.beats, index)}>
          <div style={{fontSize: chart ? 26 : 28, lineHeight: 1.5, color: theme.text}}>{point}</div>
        </Reveal>
      ))}
    </div>
  );

  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 22, width: '100%', maxWidth: chart ? 1700 : 1560}}>
      {/* 与收入结构、护城河等屏共用同一个标题组件，头部字号与间距全片一致 */}
      <SlideTitle eyebrow={question ? scene.title : undefined} title={question ?? scene.title} />
      <FadeIn>
        <div style={{height: 4, width: 240, backgroundColor: theme.accent}} />
      </FadeIn>
      {chart ? (
        <div style={{display: 'flex', gap: 46, alignItems: 'flex-start', width: '100%'}}>
          <FadeIn>
            <ChartView chart={chart} />
          </FadeIn>
          {points}
        </div>
      ) : (
        points
      )}
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
      <div style={{height: 3, width: 200, backgroundColor: theme.line}} />
      <div style={{fontSize: 28, color: theme.textDim}}>{companyName}</div>
    </FadeIn>
  );
};

export const SceneBody: React.FC<{
  scene: Scene;
  dimensions: DimensionRef[];
  companyName: string;
  dataCutoff: string | null;
}> = ({scene, dimensions, companyName, dataCutoff}) => {
  switch (scene.kind) {
    case 'opening':
      return <OpeningCard scene={scene} dataCutoff={dataCutoff} />;
    case 'dimension':
      return <DimensionSlide scene={scene} dimensions={dimensions} />;
    case 'strategy':
      return <StrategySlide scene={scene} />;
    case 'business-model':
      // 一个 kind 两屏：收入结构与经济特征，靠 data.focus 分流
      return scene.data.focus === 'economics' ? <EconomicsSlide scene={scene} /> : <RevenueSlide scene={scene} />;
    case 'moat-overview':
      return <MoatOverviewSlide scene={scene} />;
    case 'moat-trend':
      return <MoatTrendSlide scene={scene} />;
    case 'inquiry':
      return <InquirySlide scene={scene} />;
    default:
      return <ClosingCard scene={scene} companyName={companyName} />;
  }
};

/**
 * 每个分镜共用的外框：正文区 + 字幕条 + 整片进度条。
 *
 * 顶部那一行（公司名 + 「3 / 16 · 数据截止 …」）已经去掉：公司名在开场卡和结尾卡各出现
 * 一次就够，每屏都顶着一行等于每屏都少一行正文；分镜序号是内部编号，观众要的是
 * 「还有多久」而不是「第几段」，那件事底部的进度条已经在做了。
 */
export const SceneFrame: React.FC<{
  children: React.ReactNode;
  progress: number;
  centered: boolean;
  captions: Caption[];
}> = ({children, progress, centered, captions}) => (
  <AbsoluteFill style={{backgroundColor: theme.bg, fontFamily: theme.fontFamily, padding: '52px 88px 48px'}}>
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: centered ? 'center' : 'flex-start',
        // 给浮在上面的字幕留出固定安全距。这个值是常量、与当前有没有字幕无关，
        // 所以正文的垂直居中位置在整条分镜里始终不变——字幕来去不会带动版面。
        paddingBottom: CAPTION_ZONE,
      }}
    >
      {children}
    </div>
    <div style={{height: 6, borderRadius: 3, backgroundColor: theme.line}}>
      <div style={{height: 6, borderRadius: 3, width: `${progress * 100}%`, backgroundColor: theme.accent}} />
    </div>
    {/* 最后渲染、绝对定位：盖在正文之上，不占任何版面高度 */}
    <CaptionBar captions={captions} />
  </AbsoluteFill>
);
