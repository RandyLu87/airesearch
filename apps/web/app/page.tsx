export default function HomePage() {
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
          <p className="section-kicker">PILOT</p>
          <h2>网易云音乐研究试点</h2>
          <p className="company-current">当前版本聚焦单公司、双快照报告呈现；跨公司汇总与筛选将在后续阶段单独设计。</p>
          <a className="report-link" href="./companies/hk-9899-netease-cloud-music.html">
            <time>09899.HK</time><strong>网易云音乐</strong><span>查看公司研究主页 →</span>
          </a>
        </section>
      </main>
    </>
  );
}
