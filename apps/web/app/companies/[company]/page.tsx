import {
  compareResearchSnapshots,
  listResearchCompanyIds,
  listResearchSnapshots,
  type MetricObservation,
} from "@airesearch/research-schema";
import { formatPrice } from "@airesearch/research-ui";
import type { Metadata } from "next";
import path from "node:path";

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

function formatMetric(metric?: MetricObservation) {
  if (!metric || metric.status === "unavailable" || metric.value === undefined) {
    return "未披露";
  }
  const suffix = metric.unit === "percent" ? "%" : metric.currency === "CNY" ? " 亿元" : "";
  return `${metric.value}${suffix}`;
}

export default async function CompanyPage({ params }: CompanyPageProps) {
  const route = await params;
  const snapshots = listResearchSnapshots(repoRoot(), route.company);
  const current = snapshots.at(-1);
  const previous = snapshots.at(-2);

  if (!current || !previous) {
    throw new Error(`Two research snapshots are required for ${route.company}`);
  }
  const comparison = compareResearchSnapshots(previous.data, current.data);

  return (
    <>
      <link rel="stylesheet" href="../assets/research.css" />
      <script defer src="../assets/research.js" />
      <main className="company-page">
        <header className="company-header">
          <div className="company-eyebrow"><span>COMPANY RESEARCH</span><span>{current.data.company.ticker}</span></div>
          <h1>{current.data.company.name}</h1>
          <p className="company-current">{current.data.summary.headline}</p>
        </header>
        <div className="company-summary">
          <div><span>当前研究</span><strong>{current.data.snapshot.dataCutoff.slice(0, 10)}</strong></div>
          <div><span>投资立场</span><strong>{current.data.summary.stance}</strong></div>
          <div><span>参考价格</span><strong>{formatPrice(current.data.summary.referencePrice.value, current.data.summary.referencePrice.currency)}</strong></div>
          <div><span>合理价值</span><strong>HK${current.data.summary.fairValue.low}–{current.data.summary.fairValue.high}</strong></div>
        </div>

        <section className="company-section" aria-labelledby="snapshot-comparison">
          <p className="section-kicker">WHAT CHANGED</p>
          <h2 id="snapshot-comparison">研究快照对比</h2>
          <div className="snapshot-pair">
            <article className="snapshot-card">
              <time>{comparison.prior.date}</time>
              <h3>{comparison.prior.stance}</h3>
              <strong>{formatPrice(comparison.prior.referencePrice.value, comparison.prior.referencePrice.currency)} · 置信度 {comparison.prior.confidence}</strong>
              <p>{comparison.prior.businessModel}</p>
              <dl><dt>商业模式变化</dt><dd>{comparison.prior.businessModelChange}</dd><dt>合理价值</dt><dd>HK${comparison.prior.fairValue.low}–{comparison.prior.fairValue.high}</dd><dt>最紧约束</dt><dd>{comparison.prior.constraints.map((item) => item.label).join("；")}</dd></dl>
            </article>
            <article className="snapshot-card">
              <time>{comparison.current.date}</time>
              <h3>{comparison.current.stance}</h3>
              <strong>{formatPrice(comparison.current.referencePrice.value, comparison.current.referencePrice.currency)} · 置信度 {comparison.current.confidence}</strong>
              <p>{comparison.current.businessModel}</p>
              <dl><dt>商业模式变化</dt><dd>{comparison.current.businessModelChange}</dd><dt>合理价值</dt><dd>HK${comparison.current.fairValue.low}–{comparison.current.fairValue.high}</dd><dt>最紧约束</dt><dd>{comparison.current.constraints.map((item) => item.label).join("；")}</dd></dl>
            </article>
          </div>
          <h3 className="comparison-heading">标准指标</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>标准指标</th><th>{comparison.prior.date}</th><th>{comparison.current.date}</th><th>可比性</th><th>变化/原因</th></tr></thead>
              <tbody>
                {comparison.metrics.map((metric) => (
                  <tr key={metric.metricId}>
                    <th>{metric.label}</th>
                    <td>{formatMetric(metric.prior)}</td>
                    <td>{formatMetric(metric.current)}</td>
                    <td><span className={`comparison-status ${metric.status === "comparable" ? "" : "comparison-status--no"}`}>{metric.status === "comparable" ? "可比较" : "不可比较"}</span></td>
                    <td>{metric.status === "comparable" ? `变化 ${metric.delta}` : metric.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="company-section">
          <p className="section-kicker">BUSINESS MODEL DRIVERS</p>
          <h2>公司特定驱动对比</h2>
          <p className="company-current">只在标识和定义都一致时比较；新出现、缺失或定义变化的驱动明确标为不可比较。</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>驱动指标</th><th>定义</th><th>{comparison.prior.date}</th><th>{comparison.current.date}</th><th>可比性</th><th>下一阈值</th></tr></thead>
              <tbody>
                {comparison.driverMetrics.map((metric) => (
                  <tr key={metric.driverId}>
                    <th>{metric.label}</th>
                    <td>{metric.definition}</td>
                    <td>{metric.prior?.displayValue ?? "未纳入"}</td>
                    <td>{metric.current?.displayValue ?? "未纳入"}</td>
                    <td><span className={`comparison-status ${metric.status === "comparable" ? "" : "comparison-status--no"}`}>{metric.status === "comparable" ? "可比较" : "不可比较"}</span></td>
                    <td>{metric.threshold}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="company-section">
          <p className="section-kicker">VALUATION & EVIDENCE</p>
          <h2>估值与证据变化</h2>
          <div className="snapshot-pair comparison-detail-grid">
            <article className="comparison-detail">
              <span>合理价值变化</span>
              <strong>HK${comparison.prior.fairValue.low}–{comparison.prior.fairValue.high} → HK${comparison.current.fairValue.low}–{comparison.current.fairValue.high}</strong>
              <p>{current.data.thesisChange.valuation}</p>
            </article>
            <article className="comparison-detail">
              <span>当前操作区间</span>
              <ul>{current.data.valuation.actionZones.map((zone) => <li key={zone.label}><strong>{zone.range}</strong> · {zone.label} · {zone.action}</li>)}</ul>
            </article>
            <article className="comparison-detail">
              <span>新增证据</span>
              <ol>{comparison.evidence.added.map((item) => <li key={item.id}>{item.title}（{item.publishedAt}）</li>)}</ol>
            </article>
            <article className="comparison-detail">
              <span>被替换的旧假设</span>
              <ul>{comparison.evidence.supersededAssumptions.map((item) => <li key={item}>{item}</li>)}</ul>
            </article>
          </div>
        </section>

        <section className="company-section">
          <p className="section-kicker">RESEARCH ARCHIVE</p>
          <h2>历史研究报告</h2>
          <div className="report-index">
            {snapshots.map(({ data }) => (
              <a className="report-link" href={`./${route.company}/reports/${data.snapshot.id}.html`} key={data.snapshot.id}>
                <time>{data.snapshot.createdAt.slice(0, 10)}</time>
                <strong>{data.summary.stance}</strong>
                <span>打开研究报告 →</span>
              </a>
            ))}
          </div>
        </section>
      </main>
    </>
  );
}
