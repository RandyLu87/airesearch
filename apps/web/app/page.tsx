import {
  listResearchCompanyIds,
  listResearchSnapshots,
} from "@airesearch/research-schema";
import { CompanyCoverageCard } from "@airesearch/research-ui";
import path from "node:path";

function repoRoot() {
  return path.resolve(process.cwd(), "../..");
}

/**
 * Coverage is derived, never curated: a company earns a card by having a
 * canonical snapshot, so publishing new research is the only step needed to put
 * it on the home page. This is not the 查询投影 of CONTEXT.md — it filters
 * nothing and computes nothing across companies.
 */
function researchCoverage() {
  const root = repoRoot();
  return listResearchCompanyIds(root)
    .map((companyId) => {
      // listResearchCompanyIds only returns directories that hold a snapshot;
      // the guard is what lets the type narrow.
      const latest = listResearchSnapshots(root, companyId).at(-1);
      if (!latest) {
        throw new Error(`No research snapshot found for ${companyId}`);
      }
      return { companyId, snapshot: latest.data };
    })
    // Newest research first at the granularity the card shows — the date, not
    // the hour — with the company id as a tie-break so two companies published
    // on the same day always come out in the same order.
    .sort((left, right) =>
      right.snapshot.snapshot.dataCutoff
        .slice(0, 10)
        .localeCompare(left.snapshot.snapshot.dataCutoff.slice(0, 10))
      || left.companyId.localeCompare(right.companyId),
    );
}

export default function HomePage() {
  const coverage = researchCoverage();

  return (
    <>
      <link rel="stylesheet" href="./assets/research.css" />
      <main className="company-page">
        <header className="company-header">
          <div className="company-eyebrow"><span>AIRESEARCH</span><span>LONG-TERM VALUE</span></div>
          <h1>上市公司研究</h1>
          <p className="company-current">以商业模式、核心驱动、最新变化和安全边际为主线的长期价值研究。</p>
        </header>
        {/* Nothing stands between the header and the cards but the label: the
            first card has to be readable without scrolling. */}
        <section className="company-section coverage-section">
          <p className="section-kicker">COVERAGE</p>
          <div className="report-index">
            {coverage.map(({ companyId, snapshot }) => (
              <CompanyCoverageCard companyId={companyId} snapshot={snapshot} key={companyId} />
            ))}
          </div>
          <p className="coverage-note">每家公司一张卡，取该公司最新一份研究快照。价格按各自报告市场的原币种显示，不做汇率换算。</p>
        </section>
      </main>
    </>
  );
}
