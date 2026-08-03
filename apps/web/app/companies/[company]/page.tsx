import {
  compareResearchSnapshots,
  isCurrentSnapshot,
  listResearchCompanyIds,
  listResearchSnapshots,
  lookupValuationMethod,
  type ResearchSnapshot,
} from "@airesearch/research-schema";
import {
  BusinessModelSection,
  LatestComparison,
  MarketPositionSection,
  MetricGlossary,
  MetricNote,
  ValuationMethodPanel,
  ValueBridge,
  formatPrice,
} from "@airesearch/research-ui";
import type { Metadata } from "next";
import path from "node:path";

type CurrentSnapshot = Extract<ResearchSnapshot, { schemaVersion: "1.1.0" }>;

function repoRoot() {
  return path.resolve(process.cwd(), "../..");
}

export function generateStaticParams() {
  return listResearchCompanyIds(repoRoot()).map((company) => ({ company }));
}

type CompanyPageProps = {
  params: Promise<{ company: string }>;
};

export async function generateMetadata({ params }: CompanyPageProps): Promise<Metadata> {
  const route = await params;
  const current = listResearchSnapshots(repoRoot(), route.company).at(-1);
  if (!current) return {};
  return {
    title: `${current.data.company.name}公司研究主页`,
    other: {
      "research-snapshot-sha256": current.sha256,
      "research-publication-version": "0.1.0",
    },
  };
}

function formatRange(low: string, high: string, currency: string) {
  return `${formatPrice(low, currency)}–${high}`;
}

/**
 * The company page cites evidence by pointing at the dated report that holds
 * the full audit trail: there is no evidence list on this page to jump to, and
 * a dangling `#source-x` anchor would be worse than an honest outbound link.
 */
function evidenceLink(companyId: string, snapshotId: string) {
  return (ids: string[]) => (
    <span className="source-ids">
      证据：
      <a href={`./${companyId}/reports/${snapshotId}.html#evidence`}>
        {ids.length} 条，见研究报告 →
      </a>
    </span>
  );
}

export default async function CompanyPage({ params }: CompanyPageProps) {
  const route = await params;
  const snapshots = listResearchSnapshots(repoRoot(), route.company);
  const latest = snapshots.at(-1);
  const previous = snapshots.at(-2);

  if (!latest) {
    throw new Error(`No research snapshot found for ${route.company}`);
  }
  const data = latest.data;
  const current: CurrentSnapshot | null = isCurrentSnapshot(data) ? data : null;
  const comparison = previous ? compareResearchSnapshots(previous.data, data) : null;
  const refs = evidenceLink(route.company, data.snapshot.id);
  const driverChanges = data.thesisChange.driverChanges ?? [];

  return (
    <>
      <link rel="stylesheet" href="../assets/research.css" />
      <script defer src="../assets/research.js" />
      <main className="company-page">
        {/* ① 页头 */}
        <header className="company-header">
          <div className="company-eyebrow"><span>COMPANY RESEARCH</span><span>{data.company.ticker}</span></div>
          <h1>{data.company.name}</h1>
          <p className="company-current">{data.summary.headline}</p>
        </header>
        <div className="company-summary">
          <div><span>当前研究</span><strong>{data.snapshot.dataCutoff.slice(0, 10)}</strong></div>
          <div><span>投资立场</span><strong>{data.summary.stance}</strong></div>
          <div><span>参考价格</span><strong>{formatPrice(data.summary.referencePrice.value, data.summary.referencePrice.currency)}</strong></div>
          <div><span>合理价值</span><strong>{formatRange(data.summary.fairValue.low, data.summary.fairValue.high, data.summary.fairValue.currency)}</strong></div>
        </div>

        {current ? (
          <>
            {/* ② 商业模式 */}
            <section className="company-section" aria-labelledby="business-model">
              <p className="section-kicker">HOW THE MONEY IS MADE</p>
              <h2 id="business-model">商业模式</h2>
              <BusinessModelSection snapshot={current} sourceIds={refs} />
            </section>

            {/* ③ 行业地位 */}
            <section className="company-section" aria-labelledby="market-position">
              <p className="section-kicker">WHERE IT STANDS</p>
              <h2 id="market-position">行业地位</h2>
              <MarketPositionSection snapshot={current} sourceIds={refs} />
            </section>

            {/* ④ 最新财报对比 */}
            <section className="company-section" aria-labelledby="latest-financials">
              <p className="section-kicker">SAME-BASIS COMPARISON</p>
              <h2 id="latest-financials">最新财报对比</h2>
              <p className="company-note">
                两列永远取同一口径的相邻同比期间，不把全年和半年并排。科目名旁的 ⓘ 给出定义、算式和陷阱。
              </p>
              <LatestComparison snapshot={current} sourceIds={refs} />
            </section>
          </>
        ) : (
          <section className="company-section">
            <p className="section-kicker">LEGACY CONTRACT</p>
            <h2>商业模式与行业地位</h2>
            <p className="company-note">
              最新一份研究快照仍是 1.0.0 契约，没有结构化的商业模式、行业地位与估值模型。
              下一次研究会按 1.1.0 契约补齐。当前一句话商业模式：{data.summary.businessModel}
            </p>
          </section>
        )}

        {/* ⑤ 核心驱动与最紧约束 */}
        <section className="company-section" aria-labelledby="drivers">
          <p className="section-kicker">CAUSE BEFORE KPI</p>
          <h2 id="drivers">核心驱动与最紧约束</h2>
          <div className="driver-grid">
            {data.driverMetrics.map((metric) => {
              const change = comparison?.driverMetrics.find((item) => item.driverId === metric.id);
              const comparable = change?.status === "comparable";
              return (
                <article className="driver-card" key={metric.id}>
                  <div className="metric-meta">
                    <span>{metric.dimension} · {metric.signalType}</span>
                    <span className={`trend trend--${metric.trend}`}>{metric.trend}</span>
                  </div>
                  <h3>
                    {metric.label}
                    <MetricNote
                      id={`driver-${metric.id}`}
                      title={metric.label}
                      body={`${metric.definition} 因果作用：${metric.causalRole}`}
                      note={`历史基线 ${metric.baseline}；口径 ${metric.accountingBasis}，${metric.period}；置信度 ${metric.confidence}。`}
                      pitfall={metric.status === "unavailable" ? metric.reason : undefined}
                    />
                  </h3>
                  <strong>{metric.displayValue}</strong>
                  <p className="driver-delta">
                    {change
                      ? comparable
                        ? `上次 ${change.prior?.displayValue ?? "—"} → 本次 ${metric.displayValue}`
                        : `不可比较——${change.reason ?? ""}`
                      : "无前期基线"}
                  </p>
                  <small>验证阈值：{metric.threshold}</small>
                </article>
              );
            })}
          </div>
          <h3 className="block-heading">最紧约束</h3>
          <ul className="constraint-list">
            {data.constraints.map((constraint) => (
              <li key={constraint.id}>
                <span className={`trend trend--${constraint.status}`}>{constraint.status}</span>
                <strong>{constraint.label}</strong>
                <p>{constraint.explanation}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* ⑥ 估值 */}
        <section className="company-section" aria-labelledby="valuation">
          <p className="section-kicker">PRICE VS. VALUE</p>
          <h2 id="valuation">估值</h2>
          {current ? (
            <>
              <ValueBridge snapshot={current} />
              <ValuationMethodPanel snapshot={current} />
            </>
          ) : (
            <p className="company-note">{data.valuation.currentExpectation}</p>
          )}
          <h3 className="block-heading">操作区间</h3>
          <div className="action-zones">
            {data.valuation.actionZones.map((zone) => (
              <div key={zone.label}>
                <strong>{zone.range}</strong>
                <span>{zone.label}</span>
                <p>{zone.action}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ⑦ 相对上次研究 */}
        <section className="company-section" aria-labelledby="since-last">
          <p className="section-kicker">SINCE LAST RESEARCH</p>
          <h2 id="since-last">相对上次研究</h2>
          {comparison ? (
            <>
              <dl className="delta-line">
                <div>
                  <dt>投资立场</dt>
                  <dd>{comparison.prior.stance === comparison.current.stance
                    ? `${comparison.current.stance}（未变）`
                    : `${comparison.prior.stance} → ${comparison.current.stance}`}</dd>
                </div>
                <div>
                  <dt>参考价格</dt>
                  <dd>{formatPrice(comparison.prior.referencePrice.value, comparison.prior.referencePrice.currency)} → {formatPrice(comparison.current.referencePrice.value, comparison.current.referencePrice.currency)}</dd>
                </div>
                <div>
                  <dt>合理价值</dt>
                  <dd>{formatRange(comparison.prior.fairValue.low, comparison.prior.fairValue.high, comparison.prior.fairValue.currency)} → {formatRange(comparison.current.fairValue.low, comparison.current.fairValue.high, comparison.current.fairValue.currency)}</dd>
                </div>
                <div>
                  <dt>商业模式变化</dt>
                  <dd>{comparison.current.businessModelChange}</dd>
                </div>
              </dl>
              <p className="company-note">{data.thesisChange.valuation}</p>
              {driverChanges.length > 0 ? (
                <ul className="driver-change-list">
                  {driverChanges.map((change) => (
                    <li key={change.driverId}>
                      <span className={`driver-change driver-change--${change.change}`}>{change.change}</span>
                      <strong>{change.driverId}</strong>
                      <p>{change.reason}</p>
                    </li>
                  ))}
                </ul>
              ) : null}
              {comparison.evidence.added.length > 0 ? (
                <>
                  <h3 className="block-heading">新增证据</h3>
                  <ol className="editorial-list">
                    {comparison.evidence.added.map((item) => (
                      <li key={item.id}>{item.title}（{item.publishedAt}）</li>
                    ))}
                  </ol>
                </>
              ) : null}
              {comparison.evidence.supersededAssumptions.length > 0 ? (
                <>
                  <h3 className="block-heading">被替换的旧假设</h3>
                  <ul className="editorial-list">
                    {comparison.evidence.supersededAssumptions.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </>
              ) : null}
            </>
          ) : (
            <p className="company-note">这是该公司的首份结构化研究快照，暂无前期基线可比。</p>
          )}
        </section>

        {/* ⑧ 历史研究报告 */}
        <section className="company-section" aria-labelledby="archive">
          <p className="section-kicker">RESEARCH ARCHIVE</p>
          <h2 id="archive">历史研究报告</h2>
          <div className="report-index">
            {[...snapshots].reverse().map(({ data: item }) => (
              <a className="report-link" href={`./${route.company}/reports/${item.snapshot.id}.html`} key={item.snapshot.id}>
                <time>{item.snapshot.createdAt.slice(0, 10)}</time>
                <strong>{item.summary.stance}</strong>
                <span>
                  {formatPrice(item.summary.referencePrice.value, item.summary.referencePrice.currency)}
                  {" · "}
                  {isCurrentSnapshot(item)
                    ? lookupValuationMethod(item.valuation.methodSelection.adoptedPrimary)?.label ?? ""
                    : "1.0.0 契约"}
                </span>
                <span>打开研究报告 →</span>
              </a>
            ))}
          </div>
        </section>
        <MetricGlossary snapshot={data} />
      </main>
    </>
  );
}
