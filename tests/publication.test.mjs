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

function listSnapshotCompanies() {
  return readdirSync(researchRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((companyId) => listCompanySnapshots(companyId).length > 0)
    .sort();
}

/**
 * Publishing is the expensive part of these tests and every assertion reads the
 * same output, so the build runs once per file rather than once per test.
 */
let publication;
function publishSite() {
  publication ??= spawnSync("npm", ["run", "publish"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(
    publication.status,
    0,
    `publication failed\nstdout:\n${publication.stdout}\nstderr:\n${publication.stderr}`,
  );
  return publication;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Mirrors formatPrice in @airesearch/research-ui. These tests are plain .mjs and
 * the package is .tsx, so it cannot be imported here; the existing assertions
 * spell the same rule out inline. Keep the two in step.
 */
function formatPrice(value, currency) {
  return `${currency === "HKD" ? "HK$" : `${currency} `}${value}`;
}

function assertLocalReferencesResolve(html, pagePath, label) {
  const references = [...html.matchAll(/(?:href|src)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    // A fragment addresses a position inside the target, not a different file.
    .map((reference) => reference.split("#")[0])
    .filter(
      (reference) => reference !== "",
    )
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

test("valuation scenario detail pairs stay on the definition-list grid", () => {
  const css = readFileSync(
    path.join(repoRoot, "apps", "web", "public", "assets", "research.css"),
    "utf8",
  );

  // Current snapshots wrap each dt/dd pair so React can key the component.
  // The wrapper must not become a grid item itself: that would place the whole
  // first component in the fixed 52px label column and wrap CJK text vertically.
  assert.match(
    css,
    /\.scenario-grid dl > div\s*\{\s*display:\s*contents;?\s*\}/,
  );
});

test("the site index covers exactly the companies that have a research snapshot", () => {
  publishSite();

  const companies = listSnapshotCompanies();
  const indexPath = path.join(siteRoot, "index.html");
  const indexHtml = readFileSync(indexPath, "utf8");

  const linked = [...indexHtml.matchAll(/href=["']\.\/companies\/([^"'/]+)\.html["']/g)]
    .map((match) => match[1]);
  // Both directions: no researched company missing from the index, and no card
  // pointing at a company that no longer has a snapshot.
  assert.deepEqual(
    [...linked].sort(),
    companies,
    "index company cards drifted from the companies that have snapshots",
  );
  assert.equal(new Set(linked).size, linked.length, "a company is carded twice");
  assertLocalReferencesResolve(indexHtml, indexPath, "site index");

  // Ordering is asserted as an invariant over the dates the cards actually
  // print, not by re-running the page's comparator: newest first, and companies
  // sharing a date always in the same order so the build stays reproducible.
  const cards = [...indexHtml.matchAll(
    /href=["']\.\/companies\/([^"'/]+)\.html["'][\s\S]*?<time>(\d{4}-\d{2}-\d{2})<\/time>/g,
  )].map(([, companyId, shownDate]) => ({ companyId, shownDate }));
  assert.equal(cards.length, companies.length, "a card is missing its research date");
  for (const { companyId, shownDate } of cards) {
    assert.equal(
      shownDate,
      listCompanySnapshots(companyId).at(-1).data.snapshot.dataCutoff.slice(0, 10),
      `${companyId} card shows a date other than its latest data cutoff`,
    );
  }
  for (let index = 1; index < cards.length; index += 1) {
    const previous = cards[index - 1];
    const current = cards[index];
    assert.ok(
      previous.shownDate > current.shownDate ||
        (previous.shownDate === current.shownDate &&
          previous.companyId < current.companyId),
      `index cards are out of order at ${previous.companyId} → ${current.companyId}`,
    );
  }

  for (const companyId of companies) {
    const latest = listCompanySnapshots(companyId).at(-1).data;
    const { company, summary, snapshot } = latest;
    for (const fragment of [
      company.name,
      company.ticker,
      summary.stance,
      // The research cutoff and the price timestamp are different facts; the
      // card must not let the reader read the older price as same-day.
      snapshot.dataCutoff.slice(0, 10),
      summary.referencePrice.asOf.slice(0, 10),
      formatPrice(summary.referencePrice.value, summary.referencePrice.currency),
      formatPrice(summary.fairValue.low, summary.fairValue.currency),
      summary.fairValue.high,
    ]) {
      assert.match(
        indexHtml,
        new RegExp(escapeRegExp(fragment)),
        `index card for ${companyId} is missing ${fragment}`,
      );
    }
  }

  // The single-company pilot framing is no longer true. Scoped to the retired
  // copy: a company's stance may legitimately mention a 试点 of its own.
  assert.doesNotMatch(indexHtml, /网易云音乐研究试点/);
  assert.doesNotMatch(indexHtml, /跨公司汇总与筛选将在后续阶段单独设计/);
});

test("publishes every structured company snapshot as auditable static HTML", () => {
  publishSite();

  const companies = listSnapshotCompanies();
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
      assert.ok(["1.0.0", "1.1.0"].includes(snapshot.data.schemaVersion));
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
  // The company page leads with how the money is made and where the company
  // stands, then the same-basis financials — see ADR-0016.
  assert.match(companyHtml, /当前研究/);
  assert.match(companyHtml, /商业模式/);
  assert.match(companyHtml, /行业地位/);
  assert.match(companyHtml, /最新财报对比/);
  assert.match(companyHtml, /核心驱动与最紧约束/);
  assert.match(companyHtml, /相对上次研究/);
  assert.match(companyHtml, /商业模式变化/);
  assert.match(companyHtml, /新增证据/);
  assert.match(companyHtml, /被替换的旧假设/);

  const latestData = pilotSnapshots.at(-1).data;
  if (latestData.schemaVersion === "1.1.0") {
    // Both share denominators are mandatory, and the divergence between them is
    // the finding the block exists to surface.
    for (const measure of latestData.marketPosition.measures) {
      assert.match(companyHtml, new RegExp(escapeRegExp(measure.label)));
      assert.match(companyHtml, new RegExp(escapeRegExp(measure.marketDefinition)));
    }
    for (const segment of latestData.businessModel.segments) {
      assert.match(companyHtml, new RegExp(escapeRegExp(segment.name)));
      assert.match(companyHtml, new RegExp(escapeRegExp(segment.payer)));
    }
    // Metric definitions are reachable without any client runtime.
    assert.match(companyHtml, /popover=/);
    assert.doesNotMatch(companyHtml, /onclick=/);
    // The valuation the page shows must be the one the engine computed.
    const base = latestData.valuation.scenarios.find((item) => item.name === "基准");
    assert.equal(latestData.summary.fairValue.low, base.computed.low);
    assert.equal(latestData.summary.fairValue.high, base.computed.high);
    assert.match(companyHtml, new RegExp(escapeRegExp(base.computed.center)));
    // Action zones tile the price line without overlapping or leaving a gap.
    const zones = latestData.valuation.actionZones;
    for (let index = 1; index < zones.length; index += 1) {
      assert.equal(zones[index].rangeLow, zones[index - 1].rangeHigh);
    }
    assert.equal(zones.at(0).rangeLow, null);
    assert.equal(zones.at(-1).rangeHigh, null);
    // A blocked ideal method must tell the reader what would unblock it.
    if (latestData.valuation.methodSelection.blockedBy.length > 0) {
      assert.match(companyHtml, /可以把估值升级为/);
      for (const item of latestData.valuation.methodSelection.blockedBy) {
        assert.match(companyHtml, new RegExp(escapeRegExp(item.dataItem)));
      }
    }
  }

  // Derived from the data, not pinned to a particular pair of snapshots: the
  // company page always compares the two most recent ones, so publishing a new
  // snapshot legitimately changes which values appear here.
  const [priorSnapshot, currentSnapshot] = pilotSnapshots.slice(-2);
  for (const snapshot of [priorSnapshot, currentSnapshot]) {
    const { referencePrice, stance, businessModelChange } = snapshot.data.summary;
    assert.match(companyHtml, new RegExp(escapeRegExp(`HK$${referencePrice.value}`)));
    assert.match(companyHtml, new RegExp(escapeRegExp(stance)));
    assert.match(companyHtml, new RegExp(escapeRegExp(businessModelChange)));
    assert.match(companyHtml, new RegExp(escapeRegExp(snapshot.data.snapshot.dataCutoff.slice(0, 10))));
  }

  // A driver that exists in only one of the compared snapshots must be rendered
  // as not-comparable rather than silently omitted or shown as a delta.
  const priorDriverIds = new Set(priorSnapshot.data.driverMetrics.map((driver) => driver.id));
  const currentDriverIds = new Set(currentSnapshot.data.driverMetrics.map((driver) => driver.id));
  const onlyInOne = [...new Set([...priorDriverIds, ...currentDriverIds])].filter(
    (id) => !priorDriverIds.has(id) || !currentDriverIds.has(id),
  );
  if (onlyInOne.length > 0) {
    assert.match(companyHtml, /不可比较/);
  }
  for (const driver of currentSnapshot.data.driverMetrics) {
    assert.match(companyHtml, new RegExp(escapeRegExp(driver.label)));
  }

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
  assert.match(latestReportHtml, /指标释义/);
  assert.match(
    latestReportHtml,
    new RegExp(escapeRegExp(pilotSnapshots.at(-1).data.summary.fairValue.low)),
  );
  assert.match(latestReportHtml, /\.\.\/\.\.\/\.\.\/assets\/research\.css/);
  assert.doesNotMatch(latestReportHtml, /(?:src|href)=["']\//);
  assert.doesNotMatch(latestReportHtml, /__next_f|\/_next\//);
});
