import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * 发布链路测试 — 研究流程第 5/6/7 步（docs/research/workflow/05-render-site.md、
 * 06-update-home.md、07-evaluation-and-feedback.md）。
 *
 * 放一个夹具公司的 financials-final.json 进 research/companies/，跑一次真实的
 * npm run publish，断言公司分析页、首页卡片与研究评估页；测试收尾删除夹具并再
 * 发布一次，把 research/site 恢复到无夹具状态。
 *
 * 评估数据用环境变量指向临时目录，因此测试全程不读写真实的 research/evals/。
 * 全站只跑这一组发布周期：再加一次整体重建会与真实产物互相踩踏。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const researchRoot = path.join(repoRoot, "research", "companies");
const siteRoot = path.join(repoRoot, "research", "site");

const fixtureCompany = "us-tst-publication-fixture";
const fixtureDir = path.join(researchRoot, fixtureCompany);

/** 夹具评估记录：两条研究评估记录（远少于趋势线阈值）与一条缺陷记录。 */
const fixtureEvalsDir = mkdtempSync(path.join(tmpdir(), "airesearch-evals-"));
const fixtureRuns = [
  {
    company: fixtureCompany,
    companyName: "发布链路测试公司",
    ratedAt: "2026-08-05T21:30:00+08:00",
    dataCutoff: "2026-08-05",
    skillCommit: "abc1234",
    model: "test-model",
    machine: {
      validationRounds: 2, firstPassValidation: false, scores: { collection: 9.1 },
      outputTokens: 812345, activeMinutes: 96.4, userMessages: 31,
      correctionMessages: 7, costSource: "transcript",
    },
    rating: {
      trust: 3, insight: 2, readability: 4, actionable: 2, density: 3,
      vsLast: "worse", worstPart: "夹具缺陷：触发条件无法当天判定",
      changedMyPosition: false, familiarIndustry: true,
    },
  },
  {
    company: fixtureCompany,
    companyName: "发布链路测试公司",
    ratedAt: "2026-08-06T10:00:00+08:00",
    dataCutoff: "2026-08-06",
    skillCommit: "def5678",
    model: "test-model",
    // 成本取不到时字段为空：页面必须显示 —— 而不是 0。
    machine: {
      validationRounds: 1, firstPassValidation: true, scores: { collection: 9.6 },
      outputTokens: null, activeMinutes: null, userMessages: null,
      correctionMessages: null, costSource: "unavailable",
    },
    rating: {
      trust: 5, insight: 4, readability: 5, actionable: 4, density: 4,
      vsLast: "better", worstPart: "夹具缺陷：估值维度重复了采集里的原话",
      changedMyPosition: true, familiarIndustry: false,
    },
  },
];
const fixtureDefects = fixtureRuns.map((run) => ({
  at: run.ratedAt,
  company: run.company,
  step: "summary",
  symptom: run.rating.worstPart,
  skillCommit: run.skillCommit,
  status: "open",
}));

function writeJsonl(filename, records) {
  writeFileSync(
    path.join(fixtureEvalsDir, filename),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}

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
      // 双重上市：两个上市地的价格是同一个字段的两个口径（_spec.multiListing），
      // 页面必须两个都渲染，而不是因为顶层没有 value 就退回破折号。
      sharePrice: {
        primary: { value: "12.34", currency: "USD", flag: "ok" },
        alt: [{ value: "98.70", currency: "HKD", flag: "ok" }],
      },
      marketCap: { reported: "1234 百万 USD（双源中位数）" },
      // 亏损公司的 PE 是「算不出」而不是「查不到」，且原因里的括号不能把它截断。
      pe: {
        status: "not-applicable",
        reason: "TTM(2025Q2-2026Q1)净利润为负，PE 不适用",
      },
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
          // 长字段按 ①②③ 分点书写（docs/research/workflow/02-multi-dimension-analysis.md），
          // 页面必须把每点断成独立一行，而不是糊成一整段。
          stickiness: {
            level: "强",
            mechanism: "① 数据沉淀在平台内，迁移要重做接入。② 年约加预付款，违约成本高。③ 工作流与 API 深度绑定。",
            evidence: [],
          },
          // 句末标点后的小数不是列表序号：这一句必须整段留在一行。
          operatingLeverage: {
            observation: "费用增速低于收入增速。11.8 个百分点的差额来自规模摊薄。",
            evidence: [],
          },
        },
        inquiry: { question: "这门生意好在哪？", answer: "现金流前置，边际成本趋零。" },
        dataGaps: [],
      },
      valuation: {
        title: "估值",
        conclusion: "当前价格隐含的增长假设偏乐观。",
        analysis: {
          currentMultiples: {
            // 裸数字（不是约定的缩写字符串）：渲染层必须自己补千分位，
            // 不能把 1234000000 原样拼进页面（research/evals/defects.jsonl 2026-08-10）。
            marketCap: { value: 1234000000, currency: "USD" },
            ps: { value: "4.2x", source: { name: "工具验算", url: "https://example.com/ps" } },
            // 查不到与算不出是两回事：这一格必须说「未取得」。
            peg: { status: "unavailable", reason: "卖方一致预期未覆盖，无增速可用" },
          },
        },
        inquiry: { question: "贵不贵？", answer: "以现价买入需要三年翻倍。" },
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
      {
        // 第 3 步的第七个维度（docs/research/workflow/03-analysis-summary.md）：
        // 结论是转述第 2 步落盘证据的客观陈述，卡片必须与其他维度一样渲染出来。
        dimensionId: "corporateCulture",
        title: "企业文化",
        conclusion: "工程师文化：管理层公开信连续五年逐条复盘错误决策。",
        confidence: 6.5,
        scoreBasis: "引用 dimensions.management.analysis.culture；证据为单源 Level 3，向中性收敛。",
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

/** evalsDir 省略时读真实的 research/evals/——收尾恢复必须还原真实站点。 */
function runPublish(evalsDir) {
  const env = evalsDir ? { ...process.env, AIRESEARCH_EVALS_DIR: evalsDir } : process.env;
  const result = spawnSync("npm", ["run", "publish"], { cwd: repoRoot, encoding: "utf8", env });
  assert.equal(
    result.status,
    0,
    `publication failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

/**
 * 页面骨架，剥掉内联的 <style>/<script>。
 *
 * 发布时整份 research.css 会内联进 HTML（见 apps/web/scripts/copy-output.mjs），
 * 于是样式表里的每个类名都字面出现在文件里。断言「某元素没被渲染」必须先剥掉它，
 * 否则命中的是 CSS 规则而不是标记。
 */
function markup(html) {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
}

/** The rendered text with markup removed. */
function pageText(html) {
  return markup(html)
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ");
}

function assertLocalReferencesResolve(html, pagePath, label) {
  const references = [
    ...[...html.matchAll(/(?:href|src)=["']([^"']+)["']/g)].map((m) => m[1]),
    // 内联样式里的 url() 同样是这一页要发的请求。它们原本相对 assets/research.css
    // 解析，内联后改为相对文档解析，由发布脚本按页面层级重写——写错了字体就 404，
    // 而 href/src 扫描看不见这类引用。
    ...[...html.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((m) => m[1]),
  ]
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
  writeJsonl("runs.jsonl", fixtureRuns);
  writeJsonl("defects.jsonl", fixtureDefects);
  runPublish(fixtureEvalsDir);
});

// 夹具与其页面都不属于仓库内容：删掉夹具后再发布一次，让 research/site 回到
// 无夹具状态——这一次不覆盖评估目录，读真实的 research/evals/。清理放 after
// 而不是最后一个 test，断言失败时也会执行。
after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
  rmSync(fixtureEvalsDir, { recursive: true, force: true });
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
  // 企业文化维度卡：结论客观陈述 + 信心度都要出现在页面上，防止「模板加了、前端没显示」。
  assert.equal(text.includes("工程师文化：管理层公开信连续五年逐条复盘错误决策。"), true, "corporate culture conclusion missing");
  assert.equal(text.includes("6.5 / 10"), true, "corporate culture confidence missing");
  assert.equal(text.includes("本总结不构成个性化投资建议。"), true);
  // 完整性得分来自合并脚本记录的校验结果。
  assert.equal(text.includes("9.1 / 8.4 / 9.6"), true, "validation scores missing");
  assertLocalReferencesResolve(html, pagePath, "company analysis page");
});

test("point-numbered long fields render one point per line", () => {
  const html = readFileSync(path.join(siteRoot, "companies", `${fixtureCompany}.html`), "utf8");
  const points = [...html.matchAll(/<span class="prose-point">([^<]*)<\/span>/g)].map((m) => m[1]);
  // 三个 ① 点各自成为一个 .prose-point（CSS 里 display:block），序号不写进同一段。
  assert.equal(points.includes("① 数据沉淀在平台内，迁移要重做接入。"), true, `points: ${points}`);
  assert.equal(points.includes("② 年约加预付款，违约成本高。"), true, `points: ${points}`);
  assert.equal(points.includes("③ 工作流与 API 深度绑定。"), true, `points: ${points}`);
  // 句首小数（11.8）不是序号，不能把整句劈开。
  assert.equal(
    points.some((point) => point.startsWith("11.8")),
    false,
    `a decimal after a full stop must not split a line: ${points}`,
  );
  // 单点字段不该被包成 .prose-point——它没有分点结构。
  assert.equal(
    points.some((point) => point.includes("现金流前置")),
    false,
    "single-point text must stay a plain paragraph",
  );
});

test("missing values render their reason, never zeros or blanks", () => {
  const html = readFileSync(path.join(siteRoot, "companies", `${fixtureCompany}.html`), "utf8");
  const text = pageText(html);
  // 查不到 = 未取得，原因照登。
  assert.equal(
    text.includes("未取得：卖方一致预期未覆盖，无增速可用"),
    true,
    "unavailable field must surface its reason",
  );
  // 算不出 = 不适用；页头给短标签，原因跟在副行，**不能**在第一个括号处被截断。
  assert.equal(text.includes("不适用"), true, "a not-applicable field needs its own label");
  assert.equal(
    text.includes("TTM(2025Q2-2026Q1)净利润为负，PE 不适用"),
    true,
    "the reason must survive intact instead of being cut at the first bracket",
  );
});

test("a dual-listed price renders every leg instead of a dash", () => {
  const html = readFileSync(path.join(siteRoot, "companies", `${fixtureCompany}.html`), "utf8");
  const indexHtml = readFileSync(path.join(siteRoot, "index.html"), "utf8");
  for (const [label, page] of [["company page", html], ["site index", indexHtml]]) {
    const text = pageText(page);
    assert.equal(
      text.includes("12.34 USD（98.70 HKD）"),
      true,
      `${label} must render both listings of a dual-listed price`,
    );
  }
  // 页头三格不该出现「有数据却只给破折号」：市值与股价都必须是实值。
  assert.equal(pageText(html).includes("1234 百万 USD"), true, "market cap must render");
});

test("a bare numeric value gets thousand separators instead of a raw digit blob", () => {
  const html = readFileSync(path.join(siteRoot, "companies", `${fixtureCompany}.html`), "utf8");
  const text = pageText(html);
  // 采集/分析文件里理应先把大数字写成缩写字符串（"113.99B" 这类），但漏写时
  // 渲染层必须兜底加千分位，而不是把裸 JS number 原样拼进页面。
  assert.equal(
    text.includes("1,234,000,000 USD"),
    true,
    `a bare number must render with thousand separators, got: ${text.includes("1234000000") ? "raw digits" : "neither form found"}`,
  );
  assert.equal(text.includes("1234000000"), false, "the unformatted digit blob must not reach the page");
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

test("the site index links to the evaluation page", () => {
  const indexPath = path.join(siteRoot, "index.html");
  const html = readFileSync(indexPath, "utf8");
  assert.equal(html.includes('href="./evals.html"'), true, "missing evaluation page entry");
  assertLocalReferencesResolve(html, indexPath, "site index");
});

test("the evaluation page renders one ledger row per evaluation record", () => {
  const pagePath = path.join(siteRoot, "evals.html");
  assert.equal(existsSync(pagePath), true, `missing ${pagePath}`);
  const html = readFileSync(pagePath, "utf8");
  const text = pageText(html);

  for (const heading of ["研究评估", "研究台账", "最差的一处"]) {
    assert.equal(text.includes(heading), true, `page misses section ${heading}`);
  }
  // 每条评估记录一行；均分由五项评分算出，不取记录里的现成字段。
  assert.equal(text.includes("2.8"), true, "first record average missing");
  assert.equal(text.includes("4.4"), true, "second record average missing");
  assert.equal(text.includes("更差"), true);
  assert.equal(text.includes("一次过"), true);
  assert.equal(text.includes("2 轮"), true, "a reworked validation must not read as first-pass");
  assert.equal(text.includes("812,345"), true, "output tokens missing");
  // 行为指标：改变过仓位的次数比自评分诚实。
  assert.equal(text.includes("1 / 2"), true, "changed-position count missing");
  // 缺陷原文不折叠——它是这一页最该被读到的东西。
  assert.equal(text.includes("夹具缺陷：触发条件无法当天判定"), true);
  assert.equal(text.includes("夹具缺陷：估值维度重复了采集里的原话"), true);
  assertLocalReferencesResolve(html, pagePath, "evaluation page");
});

test("missing cost metrics render as a dash, never as zero", () => {
  const html = readFileSync(path.join(siteRoot, "evals.html"), "utf8");
  // 取不到成本不等于没花钱：空值必须显示破折号，显示 0 会读成"这次几乎没成本"。
  assert.equal(html.includes("<td>812,345</td>"), true, "a real cost must survive intact");
  assert.equal(html.includes("<td>0</td>"), false, "an unavailable cost must not become 0");
  // 第二条记录的 token 与耗时为空，干预/纠错两个数也都为空。
  assert.equal(
    (html.match(/<td>—<\/td>/g) ?? []).length >= 2,
    true,
    `expected dashes for the unavailable row: ${html.match(/<td>[^<]*<\/td>/g)}`,
  );
  assert.equal(html.includes("<td>— / —</td>"), true, "unknown intervention counts stay dashes");
  assert.equal(pageText(html).includes("成本指标取自会话日志"), true);
});

test("the ledger withholds the trend line below the sample threshold", () => {
  const html = readFileSync(path.join(siteRoot, "evals.html"), "utf8");
  // 两条记录远低于阈值：只出台账，不画趋势线。
  assert.equal(markup(html).includes("evals-trend"), false, "trend line must not appear");
  assert.equal(
    pageText(html).includes("样本量为 2 条，不足 10 条"),
    true,
    "the page must say why the trend line is missing",
  );
});

// 这条必须排在最后：它用空的评估目录再发布一次，之后由 after 恢复真实站点。
test("the evaluation page still builds with no evaluation records", () => {
  const emptyEvalsDir = mkdtempSync(path.join(tmpdir(), "airesearch-evals-empty-"));
  try {
    // 全新克隆没有 research/evals/，构建失败会连带打挂整条发布链路。
    runPublish(emptyEvalsDir);
    const html = readFileSync(path.join(siteRoot, "evals.html"), "utf8");
    const text = pageText(html);
    assert.equal(text.includes("暂无评估记录"), true, "empty state must explain itself");
    assert.equal(html.includes("<table"), false, "an empty ledger must not render a table");
  } finally {
    rmSync(emptyEvalsDir, { recursive: true, force: true });
  }
});
