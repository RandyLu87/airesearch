import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteRoot = path.join(repoRoot, "research", "site");

test("publishes the Cloud Music company page and both dated research reports", () => {
  const result = spawnSync("npm", ["run", "publish"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(
    result.status,
    0,
    `publication failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  const expectedPages = [
    "companies/hk-9899-netease-cloud-music.html",
    "companies/hk-9899-netease-cloud-music/reports/2026-03-26-2203-analysis.html",
    "companies/hk-9899-netease-cloud-music/reports/2026-07-31-1927-analysis.html",
  ];

  for (const relativePage of expectedPages) {
    assert.equal(
      existsSync(path.join(siteRoot, relativePage)),
      true,
      `missing published page: ${relativePage}`,
    );
  }

  const snapshotStems = [
    "2026-03-26-2203-analysis",
    "2026-07-31-1927-analysis",
  ];

  for (const stem of snapshotStems) {
    const snapshotPath = path.join(
      repoRoot,
      "research",
      "companies",
      "hk-9899-netease-cloud-music",
      "snapshots",
      `${stem}.json`,
    );
    const reportPath = path.join(
      siteRoot,
      "companies",
      "hk-9899-netease-cloud-music",
      "reports",
      `${stem}.html`,
    );
    const snapshotSource = readFileSync(snapshotPath);
    const snapshot = JSON.parse(snapshotSource.toString("utf8"));
    const expectedHash = createHash("sha256").update(snapshotSource).digest("hex");
    const reportHtml = readFileSync(reportPath, "utf8");

    assert.equal(snapshot.schemaVersion, "1.0.0");
    assert.match(
      reportHtml,
      new RegExp(
        `<meta[^>]+name=["']research-snapshot-sha256["'][^>]+content=["']${expectedHash}["']`,
      ),
      `report does not identify its source snapshot: ${stem}`,
    );
    assert.match(
      reportHtml,
      /<meta[^>]+name=["']research-publication-version["'][^>]+content=["']0\.1\.0["']/,
    );

    const relativeReferences = [
      ...reportHtml.matchAll(/(?:href|src)=["']([^"']+)["']/g),
    ]
      .map((match) => match[1])
      .filter(
        (reference) =>
          !reference.startsWith("#") &&
          !reference.startsWith("http://") &&
          !reference.startsWith("https://") &&
          !reference.startsWith("data:"),
      );
    for (const reference of relativeReferences) {
      assert.equal(
        existsSync(path.resolve(path.dirname(reportPath), reference)),
        true,
        `broken local reference in ${stem}: ${reference}`,
      );
    }
  }

  const companyHtml = readFileSync(
    path.join(
      siteRoot,
      "companies",
      "hk-9899-netease-cloud-music.html",
    ),
    "utf8",
  );
  assert.match(companyHtml, /当前研究/);
  assert.match(companyHtml, /2026-07-31/);
  assert.match(companyHtml, /reports\/2026-03-26-2203-analysis\.html/);
  assert.match(companyHtml, /reports\/2026-07-31-1927-analysis\.html/);
  assert.match(companyHtml, /研究快照对比/);
  assert.match(companyHtml, /Watchlist/);
  assert.match(companyHtml, /观察/);
  assert.match(companyHtml, /HK\$126\.6/);
  assert.match(companyHtml, /HK\$127\.4/);
  assert.match(companyHtml, /不可比较/);
  assert.match(companyHtml, /置信度/);
  assert.match(companyHtml, /商业模式变化/);
  assert.match(companyHtml, /公司特定驱动对比/);
  assert.match(companyHtml, /估值与证据变化/);
  assert.match(companyHtml, /新增证据/);
  assert.match(companyHtml, /被替换的旧假设/);

  const latestReportHtml = readFileSync(
    path.join(
      siteRoot,
      "companies",
      "hk-9899-netease-cloud-music",
      "reports",
      "2026-07-31-1927-analysis.html",
    ),
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
  assert.match(latestReportHtml, /\.\.\/\.\.\/\.\.\/assets\/research\.css/);
  assert.doesNotMatch(latestReportHtml, /(?:src|href)=["']\//);
  assert.doesNotMatch(latestReportHtml, /__next_f|\/_next\//);

  for (const asset of [
    "assets/research.css",
    "assets/research.js",
    "assets/fonts/InterVariable.woff2",
    "assets/fonts/LICENSE.txt",
  ]) {
    assert.equal(existsSync(path.join(siteRoot, asset)), true, `missing ${asset}`);
  }
});
