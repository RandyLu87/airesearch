import { listFinalCompanies, loadFinal, type FinalReport } from "../lib/final-report";

/**
 * Coverage is derived, never curated: a company earns a card by having a
 * financials-final.json, so publishing new research is the only step needed to
 * put it on the home page（研究流程第 6 步，docs/research/workflow/06-update-home.md）。
 */
function researchCoverage(): { companyId: string; final: FinalReport }[] {
  return listFinalCompanies()
    .map((companyId) => ({ companyId, final: loadFinal(companyId) }))
    // Newest research first at the granularity the card shows — the date — with
    // the company id as a tie-break so two companies published on the same day
    // always come out in the same order.
    .sort((left, right) =>
      String(right.final?.meta?.dataCutoff ?? "").slice(0, 10)
        .localeCompare(String(left.final?.meta?.dataCutoff ?? "").slice(0, 10))
      || left.companyId.localeCompare(right.companyId),
    );
}

/** 值可能是校验对象（取 value）或 unavailable（如实给原因），不吞字段。 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function text(value: any): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object" && value.status === "unavailable") {
    return `缺失：${value.reason ?? "未说明原因"}`;
  }
  if (typeof value === "object" && "value" in value) {
    const unit = value.currency ?? "";
    return `${value.value}${unit ? ` ${unit}` : ""}`;
  }
  return "—";
}

/** 公司卡片：代码、数据截止、一句话生意本质、股价与市值，指向公司分析页。 */
function CompanyCard({ companyId, final }: { companyId: string; final: FinalReport }) {
  const meta = final?.meta ?? {};
  const collection = final?.collection ?? {};
  const valuation = collection.currentValuation ?? {};
  // 卡片空间小：优先取短的一句话生意本质，长结论留给公司页。
  const oneLiner = collection.businessModelMoat?.oneLiner
    ?? final?.analysis?.dimensions?.businessEssence?.conclusion;
  return (
    <a className="report-link" href={`./companies/${companyId}.html`}>
      <div className="company-card-meta">
        <span>{text(collection.meta?.ticker)}</span>
        <span>数据截止 <time>{String(meta.dataCutoff ?? "").slice(0, 10) || "—"}</time></span>
      </div>
      <strong>{meta.companyName || companyId}</strong>
      <p className="company-card-stance">{text(oneLiner)}</p>
      <dl className="company-card-facts">
        <div>
          <dt>股价</dt>
          <dd>
            {text(valuation.sharePrice)}
            {valuation.priceAsOf ? <small>截至 <time>{text(valuation.priceAsOf).split("(")[0].split("（")[0]}</time></small> : null}
          </dd>
        </div>
        <div>
          <dt>市值</dt>
          <dd>{text(valuation.marketCap?.reported).split("(")[0].split("（")[0]}</dd>
        </div>
      </dl>
      <span>查看分析报告 →</span>
    </a>
  );
}

export default function HomePage() {
  const coverage = researchCoverage();

  return (
    <>
      <link rel="stylesheet" href="./assets/research.css" />
      <main className="company-page">
        <header className="company-header">
          {/* 评估页入口放在 eyebrow 里：它不占额外高度，第一张公司卡片仍然不用滚动。 */}
          <div className="company-eyebrow">
            <span>AIRESEARCH</span>
            <span>LONG-TERM VALUE</span>
            <span><a href="./evals.html">研究评估</a></span>
          </div>
          <h1>上市公司研究</h1>
          <p className="company-current">以商业模式、核心驱动、最新变化和当前价格隐含的假设为主线的长期价值研究。</p>
        </header>
        {/* Nothing stands between the header and the cards but the label: the
            first card has to be readable without scrolling. */}
        <section className="company-section coverage-section">
          <p className="section-kicker">COVERAGE</p>
          {coverage.length > 0 ? (
            <div className="report-index">
              {coverage.map(({ companyId, final }) => (
                <CompanyCard companyId={companyId} final={final} key={companyId} />
              ))}
            </div>
          ) : (
            <p className="company-note">暂无已发布的公司分析。完成一次研究流程（1–6 步）后，公司卡片会自动出现在这里。</p>
          )}
          <p className="coverage-note">每家公司一张卡，取该公司最新一次分析。价格按各自报告市场的原币种显示，不做汇率换算。</p>
        </section>
      </main>
    </>
  );
}
