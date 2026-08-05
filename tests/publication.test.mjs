import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * 发布链路测试 — 研究流程第 5/6 步（docs/research/workflow/05-render-site.md、06-update-home.md）。
 *
 * 放一个夹具公司的 financials-final.json 进 research/companies/，跑一次真实的
 * npm run publish，断言公司分析页与首页卡片；测试收尾删除夹具并再发布一次，
 * 把 research/site 恢复到无夹具状态。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const researchRoot = path.join(repoRoot, "research", "companies");
const siteRoot = path.join(repoRoot, "research", "site");

const fixtureCompany = "us-tst-publication-fixture";
const fixtureDir = path.join(researchRoot, fixtureCompany);

const fixtureFinal = {
  finalVersion: "1.0.0",
  meta: {
    companyId: fixtureCompany,
    companyName: "发布链路测试公司",
    generatedAt: "2026-08-05T21:00:00+08:00",
    dataCutoff: "2026-08-05",
    validation: {
      threshold: 7,
      scores: { collection: 9.1, analysis: 8.4, summary: 9.6 },
      validatedAt: "2026-08-05T21:00:00+08:00",
    },
    sources: {
      collection: `research/companies/${fixtureCompany}/financials-collection.json`,
      analysis: `research/companies/${fixtureCompany}/financials-analysis.json`,
      summary: `research/companies/${fixtureCompany}/financials-summary.json`,
    },
  },
  collection: {
    meta: { companyId: fixtureCompany, ticker: "TST" },
    businessModelMoat: { oneLiner: "测试公司以订阅方式向开发者收费。" },
    currentValuation: {
      priceAsOf: "2026-08-05 15:00",
      sharePrice: { value: "12.34", currency: "USD", flag: "ok" },
      marketCap: { reported: "1234 百万 USD" },
      // 页面必须如实渲染 unavailable 的原因，而不是显示 0 或留白。
      pe: { status: "unavailable", reason: "尚未盈利，TTM PE 无意义" },
    },
  },
  analysis: {
    dimensions: {
      businessEssence: {
        title: "生意本质",
        conclusion: "订阅收入占八成，现金先收后付。",
        analysis: {
          revenueBreakdown: {
            period: "FY2025",
            items: [
              {
                segment: "订阅",
                revenue: "100 百万 USD",
                sharePct: "80%",
                source: { name: "年报", url: "https://example.com/10k" },
              },
            ],
          },
          profitabilityTrend5y: { series: [] },
        },
        inquiry: { question: "这门生意好在哪？", answer: "现金流前置，边际成本趋零。" },
        dataGaps: [],
      },
    },
  },
  summary: {
    dimensionSummary: [
      {
        dimensionId: "businessQuality",
        title: "生意质量",
        conclusion: "订阅模式成立。",
        confidence: 8,
        scoreBasis: "收入结构与留存均有双源数据。",
      },
    ],
    strategies: {
      noPosition: { title: "空仓者", advice: "等待回撤到测试区间。", triggers: [] },
      holding: { title: "持仓者", advice: "持有并跟踪续费率。", triggers: [] },
      sellSignals: { title: "卖出信号", signals: [] },
      addSignals: { title: "加仓信号", signals: [] },
    },
    disclaimer: "本总结不构成个性化投资建议。",
  },
};

function runPublish() {
  const result = spawnSync("npm", ["run", "publish"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `publication failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

/** The rendered text with markup removed. */
function pageText(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ");
}

function assertLocalReferencesResolve(html, pagePath, label) {
  const references = [...html.matchAll(/(?:href|src)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    // A fragment addresses a position inside the target, not a different file.
    .map((reference) => reference.split("#")[0])
    .filter((reference) => reference !== "")
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

before(() => {
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(
    path.join(fixtureDir, "financials-final.json"),
    JSON.stringify(fixtureFinal, null, 2),
  );
  runPublish();
});

// 夹具与其页面都不属于仓库内容：删掉夹具后再发布一次，让 research/site 回到
// 无夹具状态。清理放 after 而不是最后一个 test，断言失败时也会执行。
after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
  runPublish();
});

test("publishes a company analysis page from financials-final.json", () => {
  const pagePath = path.join(siteRoot, "companies", `${fixtureCompany}.html`);
  assert.equal(existsSync(pagePath), true, `missing ${pagePath}`);
  const html = readFileSync(pagePath, "utf8");
  const text = pageText(html);

  for (const heading of ["维度总结与信心度", "策略建议", "生意本质", "数据与免责声明"]) {
    assert.equal(text.includes(heading), true, `page misses section ${heading}`);
  }
  assert.equal(text.includes("发布链路测试公司"), true);
  assert.equal(text.includes("订阅收入占八成"), true);
  assert.equal(text.includes("8 / 10"), true, "confidence score missing");
  assert.equal(text.includes("本总结不构成个性化投资建议。"), true);
  // 完整性得分来自合并脚本记录的校验结果。
  assert.equal(text.includes("9.1 / 8.4 / 9.6"), true, "validation scores missing");
  assertLocalReferencesResolve(html, pagePath, "company analysis page");
});

test("missing values render their reason, never zeros or blanks", () => {
  const html = readFileSync(path.join(siteRoot, "companies", `${fixtureCompany}.html`), "utf8");
  assert.equal(
    pageText(html).includes("缺失：尚未盈利，TTM PE 无意义"),
    true,
    "unavailable field must surface its reason",
  );
});

test("the site index derives exactly one card per financials-final.json", () => {
  const indexPath = path.join(siteRoot, "index.html");
  const html = readFileSync(indexPath, "utf8");
  const cardLinks = [...html.matchAll(/class="report-link" href="\.\/companies\/([^"]+)\.html"/g)]
    .map((match) => match[1])
    .sort();
  // 覆盖是派生的：卡片集合必须与带 financials-final.json 的公司目录一一对应，
  // 夹具之外仓库里已有的真实研究同样各得一张卡。
  const expected = readdirSync(researchRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()
      && existsSync(path.join(researchRoot, entry.name, "financials-final.json")))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(cardLinks, expected);
  assert.equal(cardLinks.includes(fixtureCompany), true);
  const text = pageText(html);
  assert.equal(text.includes("数据截止 2026-08-05"), true, "card must show the data cutoff");
  // 卡片空间小：文案优先取短的 businessModelMoat.oneLiner，长结论留给公司页。
  assert.equal(text.includes("测试公司以订阅方式向开发者收费。"), true, "card must show the one-liner");
  assertLocalReferencesResolve(html, indexPath, "site index");
});

test("the sentinel placeholder never reaches the published site", () => {
  assert.equal(existsSync(path.join(siteRoot, "companies", "__no-analysis__.html")), false);
  assert.equal(existsSync(path.join(siteRoot, "companies", "__no-analysis__")), false);
});
