import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const researchRoot = path.join(repoRoot, "research", "companies");
const siteRoot = path.join(repoRoot, "research", "site");
const pilotCompany = "hk-9899-netease-cloud-music";

function listCompanySnapshots(companyId) {
  const directory = path.join(researchRoot, companyId, "snapshots");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const source = readFileSync(path.join(directory, name));
      return {
        stem: name.slice(0, -5),
        source,
        data: JSON.parse(source.toString("utf8")),
      };
    })
    .sort((left, right) =>
      left.data.snapshot.createdAt.localeCompare(right.data.snapshot.createdAt),
    );
}

function assertLocalReferencesResolve(html, pagePath, label) {
  const references = [...html.matchAll(/(?:href|src)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter(
      (reference) =>
        !reference.startsWith("#") &&
        !reference.startsWith("http://") &&
        !reference.startsWith("https://") &&
        !reference.startsWith("data:"),
    );
  for (const reference of references) {
    assert.equal(
      existsSync(path.resolve(path.dirname(pagePath), reference)),
      true,
      `broken local reference in ${label}: ${reference}`,
    );
  }
}

test("publishes every structured company snapshot as auditable static HTML", () => {
  const result = spawnSync("npm", ["run", "publish"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `publication failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  const companies = readdirSync(researchRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((companyId) => listCompanySnapshots(companyId).length > 0)
    .sort();
  assert.ok(companies.includes(pilotCompany), "missing the Cloud Music pilot");

  for (const companyId of companies) {
    const snapshots = listCompanySnapshots(companyId);
    const companyPath = path.join(siteRoot, "companies", `${companyId}.html`);
    assert.equal(existsSync(companyPath), true, `missing company page: ${companyId}`);
    const companyHtml = readFileSync(companyPath, "utf8");
    const latest = snapshots.at(-1);
    const latestHash = createHash("sha256").update(latest.source).digest("hex");
    assert.match(companyHtml, new RegExp(`name=["']research-snapshot-sha256["'][^>]+content=["']${latestHash}["']`));
    assert.match(companyHtml, /name=["']research-publication-version["'][^>]+content=["']0\.1\.0["']/);
    assertLocalReferencesResolve(companyHtml, companyPath, `${companyId} company page`);

    for (const snapshot of snapshots) {
      assert.equal(snapshot.data.schemaVersion, "1.0.0");
      assert.ok(snapshot.data.driverMetrics.every((driver) =>
        driver.definitionVersion && driver.periodType && driver.accountingBasis,
      ));
      assert.ok(snapshot.data.financialHistory.every((period) =>
        period.periodType &&
        period.accountingBasis &&
        period.revenue?.value !== undefined &&
        period.revenue?.unit &&
        period.revenue?.scale &&
        Number.isInteger(period.revenue?.precision),
      ));

      const reportPath = path.join(
        siteRoot,
        "companies",
        companyId,
        "reports",
        `${snapshot.stem}.html`,
      );
      assert.equal(existsSync(reportPath), true, `missing report: ${companyId}/${snapshot.stem}`);
      const reportHtml = readFileSync(reportPath, "utf8");
      const expectedHash = createHash("sha256").update(snapshot.source).digest("hex");
      assert.match(reportHtml, new RegExp(`<meta[^>]+name=["']research-snapshot-sha256["'][^>]+content=["']${expectedHash}["']`));
      assert.match(reportHtml, /<meta[^>]+name=["']research-publication-version["'][^>]+content=["']0\.1\.0["']/);
      assert.match(reportHtml, /什么会提高当前判断/);
      assert.match(reportHtml, /什么会降低当前判断/);
      assert.match(reportHtml, /核心经营驱动实际值/);
      assertLocalReferencesResolve(reportHtml, reportPath, `${companyId}/${snapshot.stem}`);
    }

    const publishedReports = readdirSync(
      path.join(siteRoot, "companies", companyId, "reports"),
    ).filter((name) => name.endsWith(".html")).sort();
    assert.deepEqual(
      publishedReports,
      snapshots.map(({ stem }) => `${stem}.html`).sort(),
      `published report set drifted for ${companyId}`,
    );
  }

  const publishedCompanyPages = readdirSync(path.join(siteRoot, "companies"))
    .filter((name) => name.endsWith(".html"))
    .sort();
  assert.deepEqual(
    publishedCompanyPages,
    companies.map((companyId) => `${companyId}.html`),
    "published company pages drifted from snapshot companies",
  );

  for (const asset of [
    "assets/research.css",
    "assets/research.js",
    "assets/fonts/InterVariable.woff2",
    "assets/fonts/LICENSE.txt",
  ]) {
    assert.equal(existsSync(path.join(siteRoot, asset)), true, `missing ${asset}`);
  }

  const pilotSnapshots = listCompanySnapshots(pilotCompany);
  const companyHtml = readFileSync(
    path.join(siteRoot, "companies", `${pilotCompany}.html`),
    "utf8",
  );
  assert.match(companyHtml, /当前研究/);
  assert.match(companyHtml, /2026-07-31/);
  assert.match(companyHtml, /Watchlist/);
  assert.match(companyHtml, /观察/);
  assert.match(companyHtml, /HK\$126\.6/);
  assert.match(companyHtml, /HK\$127\.4/);
  assert.match(companyHtml, /置信度/);
  assert.match(companyHtml, /商业模式变化/);
  assert.match(companyHtml, /参数变化/);
  assert.match(companyHtml, /研究快照对比/);
  assert.match(companyHtml, /公司特定驱动对比/);
  assert.match(companyHtml, /估值与证据变化/);
  assert.match(companyHtml, /新增证据/);
  assert.match(companyHtml, /Annual Report 2025/);
  assert.match(companyHtml, /被替换的旧假设/);
  assert.match(companyHtml, /2025 年经营现金流尚不可得/);
  assert.match(companyHtml, /不可比较/);
  assert.match(companyHtml, /口径不兼容：periodType/);
  for (const { stem } of pilotSnapshots) {
    assert.match(companyHtml, new RegExp(`reports/${stem}\\.html`));
  }

  const latestReportHtml = readFileSync(
    path.join(siteRoot, "companies", pilotCompany, "reports", `${pilotSnapshots.at(-1).stem}.html`),
    "utf8",
  );
  assert.match(latestReportHtml, /投资判断摘要/);
  assert.match(latestReportHtml, /商业模式与核心驱动/);
  assert.match(latestReportHtml, /已查阅资料/);
  assert.match(latestReportHtml, /<details>/);
  assert.match(latestReportHtml, /href=["']#source-/);
  assert.match(latestReportHtml, /target=["']_blank["'][^>]+rel=["']noreferrer["']/);
  assert.match(latestReportHtml, /calculation/);
  assert.match(latestReportHtml, /inference/);
  assert.match(latestReportHtml, /<svg[^>]+role=["']img["']/);
  assert.match(latestReportHtml, /财务趋势/);
  assert.match(latestReportHtml, /核心驱动趋势/);
  assert.match(latestReportHtml, /利润率与资本回报/);
  assert.match(latestReportHtml, /估值情景/);
  assert.match(latestReportHtml, /69\.98 人民币亿元/);
  assert.match(latestReportHtml, /HK\$120\.0–138\.0/);
  assert.match(latestReportHtml, /\.\.\/\.\.\/\.\.\/assets\/research\.css/);
  assert.doesNotMatch(latestReportHtml, /(?:src|href)=["']\//);
  assert.doesNotMatch(latestReportHtml, /__next_f|\/_next\//);
});
