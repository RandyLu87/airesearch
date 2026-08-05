import type { ReactNode } from "react";
import {
  compareResearchSnapshots,
  fairValueOf,
  hasStructuredModel,
  isCurrentSnapshot,
  isPriorSnapshot,
  stanceOf,
  type CurrentSnapshot,
  type FrozenSnapshot,
  type ResearchSnapshot,
  type StructuredSnapshot,
} from "@airesearch/research-schema";
import {
  AssumptionSetPanel,
  BusinessModelSection,
  CommitmentPanel,
  DisagreementPanel,
  EvidenceDensityPanel,
  FrozenValueBridge,
  LatestComparison,
  MarketPositionSection,
  MetricGlossary,
  MultiplePercentileCell,
  PeriodHistoryTable,
  ProseBlock,
  StandardMetricNote,
  ValuationMethodPanel,
  formatFinancialValue,
  formatMarketCap,
  formatPrice,
  formatRange,
} from "./components.tsx";

export * from "./components.tsx";


function sourceIds(ids: string[], evidenceNumbers: Map<string, number>) {
  const uniqueIds = [...new Set(ids)];
  return (
    <span className="source-ids">
      证据：
      {uniqueIds.map((id) => (
        <a href={`#source-${id}`} key={id} aria-label={`查看证据 ${evidenceNumbers.get(id) ?? id}`}>
          [{evidenceNumbers.get(id) ?? "?"}]
        </a>
      ))}
    </span>
  );
}

function DecisionFigure({
  title,
  caption,
  children,
  references,
}: {
  title: string;
  caption: string;
  children: ReactNode;
  references: ReactNode;
}) {
  return (
    <figure className="decision-chart">
      <div className="chart-title">{title}</div>
      {children}
      <figcaption>{caption}{references}</figcaption>
    </figure>
  );
}

function linePoints(values: Array<number | null>, min: number, max: number) {
  const span = max - min || 1;
  return values
    .map((value, index) =>
      value === null
        ? null
        : `${20 + (index * 300) / Math.max(1, values.length - 1)},${130 - ((value - min) / span) * 90}`,
    )
    .filter((point): point is string => point !== null)
    .join(" ");
}

function financialNumber(value: FinancialValue) {
  const multiplier = value.scale === "hundred-million"
    ? 100_000_000
    : value.scale === "million"
      ? 1_000_000
      : 1;
  return Number(value.value) * multiplier;
}

function FinancialTrendChart({ snapshot }: { snapshot: ResearchSnapshot }) {
  const series = [
    { label: "收入", values: snapshot.financialHistory.map((item) => financialNumber(item.revenue)), className: "chart-line--ink" },
    { label: "净利润", values: snapshot.financialHistory.map((item) => financialNumber(item.netProfit)), className: "chart-line--signal" },
    { label: "FCF", values: snapshot.financialHistory.map((item) => item.freeCashFlow ? financialNumber(item.freeCashFlow) : null), className: "chart-line--muted" },
  ];
  const values = series.flatMap((item) => item.values).filter((value): value is number => value !== null);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  return (
    <svg role="img" aria-label="多期收入、净利润和自由现金流趋势" viewBox="0 0 340 165">
      <title>多期收入、净利润和自由现金流趋势</title>
      <line x1="20" y1="130" x2="320" y2="130" className="chart-axis" />
      {series.map((item, index) => (
        <g key={item.label}>
          <polyline points={linePoints(item.values, min, max)} className={`chart-line ${item.className}`} />
          <line x1={20 + index * 88} y1="12" x2={36 + index * 88} y2="12" className={`chart-line ${item.className}`} />
          <text x={40 + index * 88} y="15" className="chart-legend">{item.label}</text>
        </g>
      ))}
      {snapshot.financialHistory.map((item, index) => <text key={item.period} x={20 + (index * 300) / Math.max(1, snapshot.financialHistory.length - 1)} y="158" textAnchor={index === 0 ? "start" : index === snapshot.financialHistory.length - 1 ? "end" : "middle"} className="chart-legend">{item.period.replace("FY", "")}</text>)}
    </svg>
  );
}

function DriverTrendChart({
  snapshot,
  priorSnapshot,
}: {
  snapshot: ResearchSnapshot;
  priorSnapshot?: ResearchSnapshot;
}) {
  const comparison = priorSnapshot
    ? compareResearchSnapshots(priorSnapshot, snapshot)
    : null;
  const drivers = snapshot.driverMetrics.slice(0, 5).map((driver) => ({
    driver,
    comparison: comparison?.driverMetrics.find((item) => item.driverId === driver.id),
  }));
  const accessibleTitle = priorSnapshot
    ? "两份研究快照中的核心经营驱动实际值对比"
    : "首份研究快照中的核心经营驱动实际值";
  return (
    <svg role="img" aria-label={accessibleTitle} viewBox="0 0 520 190">
      <title>{accessibleTitle}</title>
      <text x="190" y="18" className="chart-legend">前次快照</text>
      <text x="340" y="18" className="chart-legend">本次快照</text>
      {drivers.map(({ driver, comparison: item }, index) => {
        const y = 48 + index * 29;
        const priorValue = item?.prior?.displayValue ?? (priorSnapshot ? "无同名驱动" : "无前期基线");
        const compatible = item?.status === "comparable";
        return (
          <g key={driver.id}>
            <text x="8" y={y} className="chart-driver-label">{driver.label.slice(0, 11)}</text>
            <text x="190" y={y} className="chart-trend">{priorValue.slice(0, 16)}</text>
            <text x="315" y={y} className="chart-trend">{compatible ? "→" : "≠"}</text>
            <text x="340" y={y} className="chart-trend">{driver.displayValue.slice(0, 16)}</text>
            <text x="510" y={y} textAnchor="end" className="chart-legend">{compatible ? driver.trend : "不可比较"}</text>
          </g>
        );
      })}
    </svg>
  );
}

function MarginCapitalChart({ snapshot }: { snapshot: ResearchSnapshot }) {
  const margins = snapshot.financialHistory.map((item) => item.grossMargin ? Number(item.grossMargin.value) : null);
  const available = margins.filter((value): value is number => value !== null);
  const min = Math.min(...available, 0);
  const max = Math.max(...available, 1);
  return (
    <svg role="img" aria-label="多期毛利率趋势；ROIC 因口径不足不可用" viewBox="0 0 340 165">
      <title>毛利率与资本回报趋势</title>
      <line x1="20" y1="130" x2="320" y2="130" className="chart-axis" />
      <polyline points={linePoints(margins, min, max)} className="chart-line chart-line--signal" />
      <text x="20" y="15" className="chart-legend">毛利率</text>
      <text x="180" y="15" className="chart-legend">ROIC：不可用（口径不足）</text>
      {snapshot.financialHistory.map((item, index) => <text key={item.period} x={20 + (index * 300) / Math.max(1, snapshot.financialHistory.length - 1)} y="158" textAnchor={index === 0 ? "start" : index === snapshot.financialHistory.length - 1 ? "end" : "middle"} className="chart-legend">{item.period.replace("FY", "")}</text>)}
    </svg>
  );
}

/**
 * Every declared range against the price, one bar each.
 *
 * Under 1.2.0 the bars are attributed sources rather than 熊市/基准/牛市, and no
 * bar is highlighted: highlighting one was how the previous chart told a reader
 * which future to believe. Frozen generations keep the chart they published with.
 */
function ValuationRangeChart({ snapshot }: { snapshot: ResearchSnapshot }) {
  const bands = isCurrentSnapshot(snapshot)
    ? snapshot.valuation.assumptionSets
        .filter((set) => set.computed !== undefined)
        .map((set) => ({
          // Keyed and labelled by id, not `sourceKind`: ADR-0022 expects five or six
          // seats on a well-covered company, and two 做空报告 seats would otherwise
          // collide on the React key and draw two indistinguishable bars.
          key: set.id,
          label: set.sourceKind,
          emphasis: false,
          low: Number(set.computed?.low ?? 0),
          high: Number(set.computed?.high ?? 0),
        }))
    : hasStructuredModel(snapshot)
      ? snapshot.valuation.scenarios.map((scenario) => ({
          key: scenario.name,
          label: scenario.name,
          emphasis: scenario.name === "基准",
          low: Number(scenario.computed.low),
          high: Number(scenario.computed.high),
        }))
      : // Legacy snapshots only ever had prose, so their bars are still scraped
        // out of it — which is exactly why the field stopped being prose.
        snapshot.valuation.scenarios.map((scenario) => {
          const values = scenario.valueRange.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
          return {
            key: scenario.name,
            label: scenario.name,
            emphasis: scenario.name === "基准",
            low: values[0] ?? 0,
            high: values[1] ?? values[0] ?? 0,
          };
        });
  const current = Number(snapshot.summary.referencePrice.value);
  const max = Math.max(current, ...bands.map((band) => band.high), 1);
  const x = (value: number) => 90 + (value / max) * 225;
  const label = isCurrentSnapshot(snapshot)
    ? "各署名假设集对应的价值区间与当前价格"
    : "熊市、基准和牛市估值区间与当前价格对比";
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 340 ${Math.max(165, 23 + bands.length * 42)}`}>
      <title>{label}</title>
      {bands.map((band, index) => (
        <g key={band.key}>
          <text x="8" y={35 + index * 42} className="chart-driver-label">{band.label}</text>
          <rect
            x={x(band.low)}
            y={21 + index * 42}
            width={Math.max(3, x(band.high) - x(band.low))}
            height="18"
            className={band.emphasis ? "chart-value--signal" : "chart-value--ink"}
          />
        </g>
      ))}
      <line x1={x(current)} y1="10" x2={x(current)} y2={Math.max(145, 9 + bands.length * 42)} className="chart-marker" />
      <text x={Math.min(x(current) + 4, 286)} y={Math.max(158, 22 + bands.length * 42)} className="chart-legend">当前 {formatPrice(snapshot.summary.referencePrice.value, snapshot.summary.referencePrice.currency)}</text>
    </svg>
  );
}

/**
 * The first thing a reader sees.
 *
 * Under 1.2.0 that is three facts — what the company costs, what one share
 * costs and where that price ranks in its own multiple history — and nothing
 * that tells the reader what to do about them.
 */
function ReportHeader({ snapshot }: { snapshot: ResearchSnapshot }) {
  const stance = stanceOf(snapshot);
  const fairValue = fairValueOf(snapshot);
  const current = isCurrentSnapshot(snapshot) ? snapshot : null;
  const withStance = isCurrentSnapshot(snapshot) ? null : snapshot;
  const { referencePrice } = snapshot.summary;

  return (
    <header className="report-hero" id="top">
      <div className="eyebrow-row">
        <span>PUBLIC EQUITY RESEARCH</span>
        <span>{snapshot.snapshot.dataCutoff.slice(0, 10)}</span>
      </div>
      <div className="hero-grid">
        <div>
          <p className="kicker">{snapshot.company.market} · {snapshot.company.ticker}</p>
          <h1>{snapshot.company.name}</h1>
          {/* A frozen report keeps the headline it was published with. Swapping in
              `businessModel` for every generation would have quietly rewritten
              those pages, which is the one thing ADR-0021 refuses to do. */}
          <p className="headline">{withStance?.summary.headline ?? snapshot.summary.businessModel}</p>
        </div>
        {stance ? (
          <div className="stance-block">
            <span className="label">当前判断</span>
            <strong>{stance.stance}</strong>
            <span>置信度 {stance.confidence}</span>
          </div>
        ) : null}
      </div>
      <div className="hero-facts">
        {current ? (
          <div><span>市值</span><strong>{formatMarketCap(current.summary.marketCap)}</strong></div>
        ) : null}
        <div>
          <span>参考价格</span>
          <strong>{formatPrice(referencePrice.value, referencePrice.currency)}</strong>
          <small>截至 <time>{referencePrice.asOf.slice(0, 16).replace("T", " ")}</time></small>
        </div>
        {/* The third of the three facts, in the same cell shape as the other two —
            it is a price fact and belongs beside them, not in a footnote. */}
        {current ? <MultiplePercentileCell percentile={current.summary.multiplePercentile} /> : null}
        {fairValue ? (
          <div><span>合理价值</span><strong>{formatRange(fairValue.low, fairValue.high, fairValue.currency)}</strong></div>
        ) : null}
        <div><span>商业模式变化</span><strong>{snapshot.summary.businessModelChange}</strong></div>
        <div><span>研究周期</span><strong>{snapshot.investmentHorizon}</strong></div>
      </div>
    </header>
  );
}

type FinancialValue = ResearchSnapshot["financialHistory"][number]["revenue"];

export function ReportView({
  snapshot,
  priorSnapshot,
}: {
  snapshot: ResearchSnapshot;
  priorSnapshot?: ResearchSnapshot;
}) {
  const evidenceNumbers = new Map(
    snapshot.evidence.map((item, index) => [item.id, index + 1]),
  );
  const financialEvidenceIds = [
    ...new Set(snapshot.financialHistory.flatMap((item) => item.evidenceIds)),
  ];
  const current: CurrentSnapshot | null = isCurrentSnapshot(snapshot) ? snapshot : null;
  const structured: StructuredSnapshot | null = hasStructuredModel(snapshot) ? snapshot : null;
  const frozen: FrozenSnapshot | null = isPriorSnapshot(snapshot) ? snapshot : null;
  const legacy = hasStructuredModel(snapshot) ? null : snapshot;
  // Both frozen generations published a stance, a safety margin and an action
  // ladder. One binding covers them so the JSX below narrows once, not thrice.
  const publishedAStance = isCurrentSnapshot(snapshot) ? null : snapshot;
  // Two structured sections exist from 1.1.0 onwards; everything after them
  // renumbers so a legacy report keeps the numbering it published with.
  const extra = structured ? 2 : 0;
  // The governance section only exists once a company has a commitment ledger,
  // so everything after it renumbers rather than leaving a gap.
  const governanceExtra = structured?.commitmentSummary ? 1 : 0;
  const refs = (ids: string[]) => sourceIds(ids, evidenceNumbers);

  return (
    <main className="research-report">
      <ReportHeader snapshot={snapshot} />
      <nav className="section-nav" aria-label="报告目录">
        <a href="#summary">摘要</a>
        {/* 1.1.0 onwards has guaranteed anchors for both blocks. Legacy reports
            keep the link they published with, which pointed at a narrative section. */}
        {structured ? (
          <>
            <a href="#model-structure">商业模式</a>
            <a href="#market-position">行业地位</a>
          </>
        ) : (
          <a href="#business-model">商业模式</a>
        )}
        <a href="#metrics">核心指标</a>
        <a href="#financials">财务</a>
        <a href="#valuation">估值</a>
        <a href="#view-changes">观点变化条件</a>
        <a href="#evidence">资料</a>
      </nav>

      <section className="report-section summary-section" id="summary">
        <div className="section-number">01</div>
        <div className="section-content">
          <p className="section-kicker">{current ? "FACTS FIRST" : "DECISION FIRST"}</p>
          <h2>{current ? "本次研究摘要" : "投资判断摘要"}</h2>
          <p className="lead">{snapshot.summary.businessModel}</p>
          <div className="summary-grid">
            {publishedAStance ? (
              <>
                <article><span>安全边际</span><p>{publishedAStance.summary.marginOfSafety}</p></article>
                <article><span>最强证据</span><p>{publishedAStance.summary.strongestEvidence}</p></article>
                <article><span>最大风险</span><p>{publishedAStance.summary.largestRisk}</p></article>
                <article><span>下一验证</span><p>{publishedAStance.summary.nextValidation}</p></article>
              </>
            ) : (
              <>
                <article><span>商业模式变化</span><p>{snapshot.summary.businessModelChange}</p></article>
                <article><span>下一个可判定时点</span><p>{snapshot.summary.nextValidation}</p></article>
              </>
            )}
          </div>
          <div className="change-ledger">
            <h3>相对上一份研究发生了什么</h3>
            <dl>
              <div><dt>投资逻辑</dt><dd>{snapshot.thesisChange.investmentLogic}</dd></div>
              <div><dt>财务质量</dt><dd>{snapshot.thesisChange.financialQuality}</dd></div>
              <div><dt>治理</dt><dd>{snapshot.thesisChange.governance}</dd></div>
              <div><dt>估值</dt><dd>{snapshot.thesisChange.valuation}</dd></div>
            </dl>
          </div>
        </div>
      </section>

      {structured ? (
        <>
          <section className="report-section" id="model-structure">
            <div className="section-number">02</div>
            <div className="section-content">
              <p className="section-kicker">HOW THE MONEY IS MADE</p>
              <h2>商业模式</h2>
              <BusinessModelSection snapshot={structured} sourceIds={refs} />
            </div>
          </section>
          <section className="report-section" id="market-position">
            <div className="section-number">03</div>
            <div className="section-content">
              <p className="section-kicker">WHERE IT STANDS</p>
              <h2>行业地位</h2>
              <MarketPositionSection snapshot={structured} sourceIds={refs} />
            </div>
          </section>
        </>
      ) : null}

      {snapshot.sections.map((section, index) => (
        <section className="report-section" id={section.id} key={section.id}>
          <div className="section-number">{String(index + 2 + extra).padStart(2, "0")}</div>
          <div className="section-content">
            <p className="section-kicker">OPERATING LOGIC</p>
            <h2>{section.title}</h2>
            <p className="lead">{section.summary}</p>
            <ul className="editorial-list">
              {section.bullets.map((item) => <li key={item}><ProseBlock text={item} /></li>)}
            </ul>
            {sourceIds(section.evidenceIds, evidenceNumbers)}
          </div>
        </section>
      ))}

      <section className="report-section" id="metrics">
        <div className="section-number">{String(snapshot.sections.length + 2 + extra).padStart(2, "0")}</div>
        <div className="section-content">
          <p className="section-kicker">CAUSE BEFORE KPI</p>
          <h2>核心驱动与验证指标</h2>
          <p className="lead">每个指标都对应一条商业模式因果链，并附带下一次需要验证的阈值。</p>
          <div className="metric-grid">
            {snapshot.driverMetrics.map((metric) => (
              <article className="metric-card" key={metric.id}>
                <div className="metric-meta"><span>{metric.dimension} · {metric.signalType}</span><span>{metric.trend}</span></div>
                <h3>{metric.label}</h3>
                <strong>{metric.displayValue}</strong>
                <p>{metric.causalRole}</p>
                <small>历史基线：{metric.baseline}</small>
                <small>验证阈值：{metric.threshold}</small>
                {sourceIds(metric.evidenceIds, evidenceNumbers)}
              </article>
            ))}
          </div>
          <div className="chart-grid" aria-label="关键决策图表">
            <DecisionFigure title="财务趋势" caption="收入、净利润与近似自由现金流使用同一年度序列；缺失年份不补零。" references={sourceIds(financialEvidenceIds, evidenceNumbers)}><FinancialTrendChart snapshot={snapshot} /></DecisionFigure>
            <DecisionFigure title="核心驱动趋势" caption={priorSnapshot ? "展示两份研究快照中的实际值；只有定义版本、单位、期间类型与会计口径兼容时才连接并判断变化。" : "这是首份结构化快照，图中只展示本次实际值，并明确标注没有可比较的前期基线。"} references={sourceIds(snapshot.driverMetrics.flatMap((metric) => metric.evidenceIds), evidenceNumbers)}><DriverTrendChart snapshot={snapshot} priorSnapshot={priorSnapshot} /></DecisionFigure>
            <DecisionFigure title="利润率与资本回报" caption="毛利率呈现多期变化；ROIC 因投入资本口径不足而明确标为不可用。" references={sourceIds(financialEvidenceIds, evidenceNumbers)}><MarginCapitalChart snapshot={snapshot} /></DecisionFigure>
            <DecisionFigure title={current ? "各来源假设对应的区间" : "估值情景"} caption={current ? "每条是一组署名假设算出的区间，相对当前参考价格的位置。没有哪一条被标为基准。" : "熊市、基准与牛市区间相对当前参考价格的位置。"} references={sourceIds(snapshot.valuation.evidenceIds, evidenceNumbers)}><ValuationRangeChart snapshot={snapshot} /></DecisionFigure>
          </div>
        </div>
      </section>

      <section className="report-section" id="financials">
        <div className="section-number">{String(snapshot.sections.length + 3 + extra).padStart(2, "0")}</div>
        <div className="section-content">
          <p className="section-kicker">REPORTED SERIES</p>
          {/* 1.1.0 shows several reporting cadences; a legacy report only ever
              had the annual series, and keeps the heading it published with. */}
          <h2>{structured ? "财务轨迹" : "年度财务轨迹"}</h2>
          {structured ? (
            <>
              <p className="lead">最近两年、按报告口径分档；每个科目名旁的 ⓘ 给出定义、算式与陷阱。</p>
              <PeriodHistoryTable snapshot={structured} sourceIds={refs} />
            </>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>期间</th><th>收入</th><th>收入增速</th><th>毛利率</th><th>经营利润率</th><th>净利润</th><th>经营现金流</th></tr></thead>
                <tbody>
                  {snapshot.financialHistory.map((item) => (
                    <tr key={item.period}><th>{item.period}{sourceIds(item.evidenceIds, evidenceNumbers)}</th><td>{formatFinancialValue(item.revenue)}</td><td>{formatFinancialValue(item.revenueGrowth)}</td><td>{formatFinancialValue(item.grossMargin)}</td><td>{formatFinancialValue(item.operatingMargin)}</td><td>{formatFinancialValue(item.netProfit)}</td><td>{formatFinancialValue(item.operatingCashFlow)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="report-section" id="valuation">
        <div className="section-number">{String(snapshot.sections.length + 4 + extra).padStart(2, "0")}</div>
        <div className="section-content">
          <p className="section-kicker">{current ? "WHOSE ASSUMPTIONS" : "PRICE VS. VALUE"}</p>
          <h2>{current ? "各来源假设与价格隐含" : "估值情景与操作区间"}</h2>
          {current ? (
            <>
              <AssumptionSetPanel snapshot={current} />
              <h3 className="block-heading">价格与某一来源的分歧</h3>
              <DisagreementPanel snapshot={current} />
              <h3 className="block-heading">方法与交叉验证</h3>
              <ValuationMethodPanel snapshot={current} />
              {refs(current.valuation.evidenceIds)}
            </>
          ) : frozen ? (
            <>
              <FrozenValueBridge snapshot={frozen} />
              <ValuationMethodPanel snapshot={frozen} />
              {refs(frozen.valuation.evidenceIds)}
              <h3 className="block-heading">三情景与组件</h3>
              <div className="scenario-grid">
                {frozen.valuation.scenarios.map((scenario) => (
                  <article key={scenario.name}>
                    <span>{scenario.name}</span>
                    <h3>
                      {formatPrice(scenario.computed.low, frozen.valuation.tradingCurrency)}–
                      {scenario.computed.high}
                    </h3>
                    <p>{scenario.assumptions}</p>
                    <dl>
                      {scenario.components.map((component) => (
                        <div key={component.id}>
                          <dt>{component.kind === "multiple" ? "倍数" : "面值"}</dt>
                          <dd>
                            {component.kind === "multiple"
                              ? `${component.metricLabel} ${component.metricLow}–${component.metricHigh} × ${component.multipleLow}–${component.multipleHigh}x`
                              : `${component.amount}${component.discountPct ? `（折价 ${component.discountPct}%）` : ""}`}
                          </dd>
                        </div>
                      ))}
                      <div><dt>触发</dt><dd>{scenario.trigger}</dd></div>
                    </dl>
                  </article>
                ))}
              </div>
            </>
          ) : legacy ? (
            <>
              <p className="lead">{legacy.valuation.currentExpectation}</p>
              {sourceIds(legacy.valuation.evidenceIds, evidenceNumbers)}
              <div className="scenario-grid">
                {legacy.valuation.scenarios.map((scenario) => (
                  <article key={scenario.name}>
                    <span>{scenario.name}</span><h3>{scenario.valueRange}</h3><p>{scenario.assumptions}</p><dl><dt>盈利</dt><dd>{scenario.earnings}</dd><dt>方法</dt><dd>{scenario.method}</dd><dt>触发</dt><dd>{scenario.trigger}</dd></dl>
                  </article>
                ))}
              </div>
            </>
          ) : null}
          {publishedAStance ? (
            <div className="action-zones">
              {publishedAStance.valuation.actionZones.map((zone) => <div key={zone.label}><strong>{zone.range}</strong><span>{zone.label}</span><p>{zone.action}</p></div>)}
            </div>
          ) : null}
        </div>
      </section>

      {/* Governance is the one dimension that can only be observed lengthwise,
          so it gets its own section rather than a line in the narrative. */}
      {structured?.commitmentSummary ? (
        <section className="report-section" id="commitments">
          <div className="section-number">{String(snapshot.sections.length + 5 + extra).padStart(2, "0")}</div>
          <div className="section-content">
            <p className="section-kicker">SAID VS. DONE</p>
            <h2>管理层承诺与资本配置</h2>
            <CommitmentPanel snapshot={structured} />
          </div>
        </section>
      ) : null}

      <section className="report-section" id="view-changes">
        <div className="section-number">{String(snapshot.sections.length + 5 + extra + governanceExtra).padStart(2, "0")}</div>
        <div className="section-content split-section">
          <article><p className="section-kicker">UPGRADE CONDITIONS</p><h2>{current ? "什么会让基本面向上" : "什么会提高当前判断"}</h2><ol className="editorial-list">{snapshot.viewChanges.upgrade.map((item) => <li key={item}>{item}</li>)}</ol></article>
          <article><p className="section-kicker">DOWNGRADE CONDITIONS</p><h2>{current ? "什么会让基本面向下" : "什么会降低当前判断"}</h2><ol className="editorial-list">{snapshot.viewChanges.downgrade.map((item) => <li key={item}>{item}</li>)}</ol></article>
        </div>
      </section>

      <section className="report-section">
        <div className="section-number">{String(snapshot.sections.length + 6 + extra + governanceExtra).padStart(2, "0")}</div>
        <div className="section-content split-section">
          <article><p className="section-kicker">DOWNSIDE</p><h2>核心风险</h2><ol className="editorial-list">{snapshot.risks.map((risk) => <li key={risk}><ProseBlock text={risk} /></li>)}</ol></article>
          <article><p className="section-kicker">VALIDATION</p><h2>后续跟踪点</h2><ol className="editorial-list">{snapshot.checkpoints.map((item) => <li key={item}>{item}</li>)}</ol></article>
        </div>
      </section>

      <section className="report-section evidence-section" id="evidence">
        <div className="section-number">{String(snapshot.sections.length + 7 + extra + governanceExtra).padStart(2, "0")}</div>
        <div className="section-content">
          <p className="section-kicker">AUDIT TRAIL</p>
          <h2>已查阅资料</h2>
          <ol className="evidence-list">
            {snapshot.evidence.map((item, index) => (
              <li id={`source-${item.id}`} key={item.id}>
                <details>
                  <summary>
                    <span className="evidence-number">[{index + 1}]</span>
                    <span className={`evidence-kind evidence-kind--${item.kind}`}>{item.kind}</span>
                    <span>{item.title}</span>
                  </summary>
                  <div className="evidence-detail">
                    <p>{item.publisher} · {item.periodOrEventDate} · 发布 {item.publishedAt}</p>
                    <p>抓取时间：{item.retrievedAt}</p>
                    {item.caveat ? <small>{item.caveat}</small> : null}
                    <a className="external-link" href={item.url} target="_blank" rel="noreferrer">打开原始资料 ↗</a>
                  </div>
                </details>
              </li>
            ))}
          </ol>
          {/* Density belongs with the audit trail: it is a statement about this
              evidence list, not about the valuation that reads it. */}
          {structured ? (
            <>
              <h3 className="block-heading">证据密度</h3>
              <EvidenceDensityPanel snapshot={structured} />
            </>
          ) : null}
          <p className="disclaimer">{snapshot.disclaimer}</p>
        </div>
      </section>
      <MetricGlossary snapshot={snapshot} />
      <a className="back-to-top" href="#top" aria-label="返回顶部">↑</a>
    </main>
  );
}
