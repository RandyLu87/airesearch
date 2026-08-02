import type { ResearchSnapshot } from "@airesearch/research-schema";

function price(value: string, currency: string) {
  return `${currency === "HKD" ? "HK$" : `${currency} `}${value}`;
}

function sourceIds(ids: string[], evidenceNumbers: Map<string, number>) {
  return (
    <span className="source-ids">
      证据：
      {ids.map((id) => (
        <a href={`#source-${id}`} key={id} aria-label={`查看证据 ${evidenceNumbers.get(id) ?? id}`}>
          [{evidenceNumbers.get(id) ?? "?"}]
        </a>
      ))}
    </span>
  );
}

function DecisionChart({
  title,
  value,
  caption,
  tone = "ink",
}: {
  title: string;
  value: number;
  caption: string;
  tone?: "ink" | "signal";
}) {
  const normalized = Math.max(8, Math.min(92, value));
  return (
    <figure className="decision-chart">
      <svg
        role="img"
        aria-label={`${title}：${caption}`}
        viewBox="0 0 320 96"
        preserveAspectRatio="none"
      >
        <title>{title}</title>
        <line x1="8" y1="64" x2="312" y2="64" className="chart-axis" />
        <rect x="8" y="44" width="304" height="20" rx="0" className="chart-track" />
        <rect
          x="8"
          y="44"
          width={(304 * normalized) / 100}
          height="20"
          className={`chart-value chart-value--${tone}`}
        />
        <line
          x1={8 + (304 * normalized) / 100}
          y1="34"
          x2={8 + (304 * normalized) / 100}
          y2="74"
          className="chart-marker"
        />
        <text x="8" y="22" className="chart-label">{title}</text>
      </svg>
      <figcaption>{caption}</figcaption>
    </figure>
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
        <div><span>参考价格</span><strong>{price(snapshot.summary.referencePrice.value, snapshot.summary.referencePrice.currency)}</strong></div>
        <div><span>合理价值</span><strong>{price(snapshot.summary.fairValue.low, snapshot.summary.fairValue.currency)}–{snapshot.summary.fairValue.high}</strong></div>
        <div><span>商业模式变化</span><strong>{snapshot.summary.businessModelChange}</strong></div>
        <div><span>研究周期</span><strong>3–5 年</strong></div>
      </div>
    </header>
  );
}

export function ReportView({ snapshot }: { snapshot: ResearchSnapshot }) {
  const evidenceNumbers = new Map(
    snapshot.evidence.map((item, index) => [item.id, index + 1]),
  );
  const revenue = snapshot.financialHistory.map((item) => Number(item.revenue));
  const lastRevenue = revenue.at(-1) ?? 0;
  const firstRevenue = revenue.at(0) ?? lastRevenue;
  const growthScore = firstRevenue === 0 ? 50 : 50 + ((lastRevenue - firstRevenue) / Math.abs(firstRevenue)) * 50;
  const latestMargin = Number(snapshot.financialHistory.at(-1)?.grossMargin.replace("%", "") ?? 0);
  const cashMetric = snapshot.driverMetrics.find((metric) => metric.id === "cash-conversion");
  const valuationPosition =
    (Number(snapshot.summary.referencePrice.value) /
      Number(snapshot.summary.fairValue.center)) *
    50;

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
                <div className="metric-meta"><span>{metric.property}</span><span>{metric.trend}</span></div>
                <h3>{metric.label}</h3>
                <strong>{metric.displayValue}</strong>
                <p>{metric.causalRole}</p>
                <small>验证阈值：{metric.threshold}</small>
              </article>
            ))}
          </div>
          <div className="chart-grid" aria-label="关键决策图表">
            <DecisionChart title="收入韧性" value={growthScore} caption="长期收入结构由社交娱乐转向订阅，增长仍待重新加速。" />
            <DecisionChart title="毛利修复" value={latestMargin * 2} caption={`最近年度毛利率 ${latestMargin.toFixed(1)}%，效率改善已经可见。`} tone="signal" />
            <DecisionChart title="现金质量" value={Number(cashMetric?.value ?? 59)} caption={cashMetric?.displayValue ?? "最新研究时点尚缺完整现金流"} />
            <DecisionChart title="估值位置" value={valuationPosition} caption={`参考价 ${price(snapshot.summary.referencePrice.value, snapshot.summary.referencePrice.currency)}，合理价值 ${price(snapshot.summary.fairValue.low, snapshot.summary.fairValue.currency)}–${snapshot.summary.fairValue.high}。`} tone="signal" />
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
                  <tr key={item.period}><th>{item.period}</th><td>{item.revenue}</td><td>{item.revenueGrowth}</td><td>{item.grossMargin}</td><td>{item.operatingMargin}</td><td>{item.netProfit}</td><td>{item.operatingCashFlow ?? "未披露"}</td></tr>
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
