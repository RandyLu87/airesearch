import {
  listResearchCompanyIds,
  listResearchSnapshots,
} from "@airesearch/research-schema";
import path from "node:path";

export default function HomePage() {
  const repoRoot = path.resolve(process.cwd(), "../..");
  const companies = listResearchCompanyIds(repoRoot).map((companyId) => ({
    companyId,
    current: listResearchSnapshots(repoRoot, companyId).at(-1),
  }));
  return (
    <>
      <link rel="stylesheet" href="./assets/research.css" />
      <main className="company-page">
        <header className="company-header">
          <div className="company-eyebrow"><span>AIRESEARCH</span><span>LONG-TERM VALUE</span></div>
          <h1>上市公司研究</h1>
          <p className="company-current">以商业模式、核心驱动、最新变化和安全边际为主线的长期价值研究。</p>
        </header>
        <section className="company-section">
          <p className="section-kicker">COMPANIES</p>
          <h2>公司索引</h2>
          <div className="report-index">
            {companies.map(({ companyId, current }) => current ? (
              <a className="report-link" href={`./companies/${companyId}.html`} key={companyId}>
                <time>{current.data.company.ticker}</time><strong>{current.data.company.name}</strong><span>查看公司研究主页 →</span>
              </a>
            ) : null)}
          </div>
        </section>
      </main>
    </>
  );
}
