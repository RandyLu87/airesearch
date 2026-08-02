import type { ReactNode } from "react";
import type { ResearchSnapshot } from "@airesearch/research-schema";

export function formatPrice(value: string, currency: string) {
  return `${currency === "HKD" ? "HK$" : `${currency} `}${value}`;
}

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

function FinancialTrendChart({ snapshot }: { snapshot: ResearchSnapshot }) {
  const series = [
    { label: "收入", values: snapshot.financialHistory.map((item) => Number(item.revenue)), className: "chart-line--ink" },
    { label: "净利润", values: snapshot.financialHistory.map((item) => Number(item.netProfit)), className: "chart-line--signal" },
    { label: "FCF", values: snapshot.financialHistory.map((item) => item.freeCashFlow ? Number(item.freeCashFlow) : null), className: "chart-line--muted" },
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

function DriverTrendChart({ snapshot }: { snapshot: ResearchSnapshot }) {
  const drivers = snapshot.driverMetrics.slice(0, 5);
  return (
    <svg role="img" aria-label="核心经营驱动及其改善或恶化方向" viewBox="0 0 340 165">
      <title>核心经营驱动及其改善或恶化方向</title>
      {drivers.map((driver, index) => {
        const score = driver.trend === "改善" ? 82 : driver.trend === "恶化" ? 28 : driver.trend === "稳定" ? 58 : 45;
        return <g key={driver.id}><text x="8" y={24 + index * 29} className="chart-driver-label">{driver.label.slice(0, 10)}</text><rect x="148" y={11 + index * 29} width="170" height="14" className="chart-track" /><rect x="148" y={11 + index * 29} width={score * 1.7} height="14" className={driver.trend === "改善" ? "chart-value--signal" : "chart-value--ink"} /><text x="324" y={23 + index * 29} textAnchor="end" className="chart-trend">{driver.trend}</text></g>;
      })}
    </svg>
  );
}

function MarginCapitalChart({ snapshot }: { snapshot: ResearchSnapshot }) {
  const margins = snapshot.financialHistory.map((item) => item.grossMargin ? Number(item.grossMargin) : null);
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

function ValuationScenarioChart({ snapshot }: { snapshot: ResearchSnapshot }) {
  const scenarios = snapshot.valuation.scenarios.map((scenario) => {
    const values = scenario.valueRange.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    return { ...scenario, low: values[0] ?? 0, high: values[1] ?? values[0] ?? 0 };
  });
  const current = Number(snapshot.summary.referencePrice.value);
  const max = Math.max(current, ...scenarios.map((scenario) => scenario.high), 1);
  const x = (value: number) => 90 + (value / max) * 225;
  return (
    <svg role="img" aria-label="熊市、基准和牛市估值区间与当前价格对比" viewBox="0 0 340 165">
      <title>估值情景与当前价格</title>
      {scenarios.map((scenario, index) => <g key={scenario.name}><text x="8" y={35 + index * 42} className="chart-driver-label">{scenario.name}</text><rect x={x(scenario.low)} y={21 + index * 42} width={Math.max(3, x(scenario.high) - x(scenario.low))} height="18" className={scenario.name === "基准" ? "chart-value--signal" : "chart-value--ink"} /></g>)}
      <line x1={x(current)} y1="10" x2={x(current)} y2="145" className="chart-marker" />
      <text x={Math.min(x(current) + 4, 286)} y="158" className="chart-legend">当前 {formatPrice(snapshot.summary.referencePrice.value, snapshot.summary.referencePrice.currency)}</text>
    </svg>
  );
}

function ReportHeader({ snapshot }: { snapshot: ResearchSnapshot }) {
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
          <p className="headline">{snapshot.summary.headline}</p>
        </div>
        <div className="stance-block">
          <span className="label">当前判断</span>
          <strong>{snapshot.summary.stance}</strong>
          <span>置信度 {snapshot.summary.confidence}</span>
        </div>
      </div>
      <div className="hero-facts">
        <div><span>参考价格</span><strong>{formatPrice(snapshot.summary.referencePrice.value, snapshot.summary.referencePrice.currency)}</strong></div>
        <div><span>合理价值</span><strong>{formatPrice(snapshot.summary.fairValue.low, snapshot.summary.fairValue.currency)}–{snapshot.summary.fairValue.high}</strong></div>
        <div><span>商业模式变化</span><strong>{snapshot.summary.businessModelChange}</strong></div>
        <div><span>研究周期</span><strong>{snapshot.investmentHorizon}</strong></div>
      </div>
    </header>
  );
}

export function ReportView({ snapshot }: { snapshot: ResearchSnapshot }) {
  const evidenceNumbers = new Map(
    snapshot.evidence.map((item, index) => [item.id, index + 1]),
  );
  const financialEvidenceIds = [
    ...new Set(snapshot.financialHistory.flatMap((item) => item.evidenceIds)),
  ];

  return (
    <main className="research-report">
      <ReportHeader snapshot={snapshot} />
      <nav className="section-nav" aria-label="报告目录">
        <a href="#summary">摘要</a>
        <a href="#business-model">商业模式</a>
        <a href="#metrics">核心指标</a>
        <a href="#financials">财务</a>
        <a href="#valuation">估值</a>
        <a href="#evidence">资料</a>
      </nav>

      <section className="report-section summary-section" id="summary">
        <div className="section-number">01</div>
        <div className="section-content">
          <p className="section-kicker">DECISION FIRST</p>
          <h2>投资判断摘要</h2>
          <p className="lead">{snapshot.summary.businessModel}</p>
          <div className="summary-grid">
            <article><span>安全边际</span><p>{snapshot.summary.marginOfSafety}</p></article>
            <article><span>最强证据</span><p>{snapshot.summary.strongestEvidence}</p></article>
            <article><span>最大风险</span><p>{snapshot.summary.largestRisk}</p></article>
            <article><span>下一验证</span><p>{snapshot.summary.nextValidation}</p></article>
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

      {snapshot.sections.map((section, index) => (
        <section className="report-section" id={section.id} key={section.id}>
          <div className="section-number">{String(index + 2).padStart(2, "0")}</div>
          <div className="section-content">
            <p className="section-kicker">OPERATING LOGIC</p>
            <h2>{section.title}</h2>
            <p className="lead">{section.summary}</p>
            <ul className="editorial-list">
              {section.bullets.map((item) => <li key={item}>{item}</li>)}
            </ul>
            {sourceIds(section.evidenceIds, evidenceNumbers)}
          </div>
        </section>
      ))}

      <section className="report-section" id="metrics">
        <div className="section-number">{String(snapshot.sections.length + 2).padStart(2, "0")}</div>
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
            <DecisionFigure title="核心驱动趋势" caption="方向来自各驱动的最新趋势判断，具体值、定义与阈值见上方指标卡。" references={sourceIds(snapshot.driverMetrics.flatMap((metric) => metric.evidenceIds), evidenceNumbers)}><DriverTrendChart snapshot={snapshot} /></DecisionFigure>
            <DecisionFigure title="利润率与资本回报" caption="毛利率呈现多期变化；ROIC 因投入资本口径不足而明确标为不可用。" references={sourceIds(financialEvidenceIds, evidenceNumbers)}><MarginCapitalChart snapshot={snapshot} /></DecisionFigure>
            <DecisionFigure title="估值情景" caption="熊市、基准与牛市区间相对当前参考价格的位置。" references={sourceIds(snapshot.valuation.evidenceIds, evidenceNumbers)}><ValuationScenarioChart snapshot={snapshot} /></DecisionFigure>
          </div>
        </div>
      </section>

      <section className="report-section" id="financials">
        <div className="section-number">{String(snapshot.sections.length + 3).padStart(2, "0")}</div>
        <div className="section-content">
          <p className="section-kicker">REPORTED SERIES</p>
          <h2>年度财务轨迹</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>期间</th><th>收入<br />亿元</th><th>收入增速</th><th>毛利率</th><th>经营利润率</th><th>净利润<br />亿元</th><th>经营现金流<br />亿元</th></tr></thead>
              <tbody>
                {snapshot.financialHistory.map((item) => (
                  <tr key={item.period}><th>{item.period}{sourceIds(item.evidenceIds, evidenceNumbers)}</th><td>{item.revenue}</td><td>{item.revenueGrowth === undefined ? "未披露" : `${Number(item.revenueGrowth) > 0 ? "+" : ""}${item.revenueGrowth}%`}</td><td>{item.grossMargin === undefined ? "未披露" : `${item.grossMargin}%`}</td><td>{item.operatingMargin === undefined ? "未披露" : `${item.operatingMargin}%`}</td><td>{item.netProfit}</td><td>{item.operatingCashFlow ?? "未披露"}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="report-section" id="valuation">
        <div className="section-number">{String(snapshot.sections.length + 4).padStart(2, "0")}</div>
        <div className="section-content">
          <p className="section-kicker">PRICE VS. VALUE</p>
          <h2>估值情景与操作区间</h2>
          <p className="lead">{snapshot.valuation.currentExpectation}</p>
          {sourceIds(snapshot.valuation.evidenceIds, evidenceNumbers)}
          <div className="scenario-grid">
            {snapshot.valuation.scenarios.map((scenario) => (
              <article key={scenario.name}>
                <span>{scenario.name}</span><h3>{scenario.valueRange}</h3><p>{scenario.assumptions}</p><dl><dt>盈利</dt><dd>{scenario.earnings}</dd><dt>方法</dt><dd>{scenario.method}</dd><dt>触发</dt><dd>{scenario.trigger}</dd></dl>
              </article>
            ))}
          </div>
          <div className="action-zones">
            {snapshot.valuation.actionZones.map((zone) => <div key={zone.label}><strong>{zone.range}</strong><span>{zone.label}</span><p>{zone.action}</p></div>)}
          </div>
        </div>
      </section>

      <section className="report-section">
        <div className="section-number">{String(snapshot.sections.length + 5).padStart(2, "0")}</div>
        <div className="section-content split-section">
          <article><p className="section-kicker">DOWNSIDE</p><h2>核心风险</h2><ol className="editorial-list">{snapshot.risks.map((risk) => <li key={risk}>{risk}</li>)}</ol></article>
          <article><p className="section-kicker">VALIDATION</p><h2>后续跟踪点</h2><ol className="editorial-list">{snapshot.checkpoints.map((item) => <li key={item}>{item}</li>)}</ol></article>
        </div>
      </section>

      <section className="report-section evidence-section" id="evidence">
        <div className="section-number">{String(snapshot.sections.length + 6).padStart(2, "0")}</div>
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
          <p className="disclaimer">{snapshot.disclaimer}</p>
        </div>
      </section>
      <a className="back-to-top" href="#top" aria-label="返回顶部">↑</a>
    </main>
  );
}
