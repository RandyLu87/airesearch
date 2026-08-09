import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * 首屏可渲染性闸门 — 研究流程第 4/5 步（docs/research/workflow/04-data-validation.md）。
 *
 * 完整性分数只看槽位填没填，看不出「填了但页面显示不出来」：理想汽车把股价与市值
 * 按上市地拆成自定义键，槽位全满拿到 9.7 分，页头却是两个破折号
 * （research/evals/defects.jsonl 2026-08-09）。这组用例锁住那道补上的闸门——
 * 它必须挡住页面渲染不出的形状，同时放行契约内的每一种写法。
 *
 * 解析规则在两处实现：docs/research/tools/data_validator.py 的 resolve_field()
 * 与 apps/web/lib/field-text.ts 的 text()。改一处必须改另一处，这里只测 Python 一侧，
 * 渲染一侧由 publication.test.mjs 从真实 HTML 上断言。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validator = path.join(repoRoot, "docs", "research", "tools", "data_validator.py");

const quoteObject = { value: 44.18, currency: "HKD", flag: "ok" };

/** 只有首屏四格的最小采集文件：其余槽位缺失只影响分数，不影响这道闸门。 */
function collectionWith(valuation, dataCutoff = "2026-08-07") {
  return { meta: { companyId: "hk-0000-fixture", dataCutoff }, currentValuation: valuation };
}

/** 跑一次校验，返回 { code, problems }——problems 是首屏闸门报出的字段标签。 */
function runGate(collection) {
  const dir = mkdtempSync(path.join(tmpdir(), "airesearch-headline-"));
  try {
    const file = path.join(dir, "financials-collection.json");
    writeFileSync(file, JSON.stringify(collection));
    const result = spawnSync(
      "python3",
      [validator, "check", "--collection", file, "--json"],
      // 记账写到临时目录：闸门测试不能碰真实的 research/evals/。
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, AIRESEARCH_EVALS_DIR: dir } },
    );
    assert.notEqual(result.status, 2, `validator errored:\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    const collectionResult = parsed.results.find((entry) => entry.step === "collection");
    return {
      code: result.status,
      problems: collectionResult.headlineProblems.map((problem) => problem.label),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const renderable = [
  ["scalar strings", {
    marketCap: { reported: "190.36B HKD（双源中位数）" },
    sharePrice: quoteObject,
    pe: "9.77x",
  }],
  ["verified objects", {
    marketCap: { reported: { value: "190.36B", currency: "HKD" } },
    sharePrice: quoteObject,
    pe: { value: "9.77x" },
  }],
  ["a dual-listed { primary, alt } field", {
    marketCap: {
      reported: {
        primary: { value: "101.22B", currency: "HKD" },
        alt: [{ value: "13.03B", currency: "USD" }],
        source: "FMP",
      },
    },
    sharePrice: { primary: quoteObject, alt: [{ value: 12.89, currency: "USD" }] },
    pe: "9.77x",
  }],
  ["absent values carrying a reason", {
    marketCap: { reported: "190.36B HKD" },
    sharePrice: quoteObject,
    pe: { status: "not-applicable", reason: "TTM(2025Q2-2026Q1)净利润为负" },
  }],
];

for (const [label, valuation] of renderable) {
  test(`the headline gate passes ${label}`, () => {
    assert.deepEqual(runGate(collectionWith(valuation)).problems, []);
  });
}

test("the headline gate blocks currency-in-the-key market caps", () => {
  // 理想汽车原样：数字都在，但没有单位可读，页面只能显示破折号。
  const { code, problems } = runGate(collectionWith({
    marketCap: { reported: { hk_hkd: 101219774273, us_usd: 13025761661, source: "FMP" } },
    sharePrice: quoteObject,
    pe: "9.77x",
  }));
  assert.deepEqual(problems, ["市值"]);
  assert.equal(code, 1, "an unrenderable headline field must fail the run");
});

test("the headline gate blocks a status without a reason", () => {
  // 只写 status 的字段在页面上和「没这个字段」没有区别。
  const { problems } = runGate(collectionWith({
    marketCap: { reported: "190.36B HKD" },
    sharePrice: quoteObject,
    pe: { status: "unavailable" },
  }));
  assert.deepEqual(problems, ["PE"]);
});

test("the headline gate blocks a missing data cutoff", () => {
  const { problems } = runGate(collectionWith({
    marketCap: { reported: "190.36B HKD" },
    sharePrice: quoteObject,
    pe: "9.77x",
  }, ""));
  assert.deepEqual(problems, ["数据截止"]);
});

test("a full slot sheet does not buy a pass on the headline gate", () => {
  // 这条是缺陷记录的核心：9.7 分与页头空白同时成立过。
  const { problems } = runGate(collectionWith({
    marketCap: { reported: { hk_hkd: 101219774273 } },
    sharePrice: { hk: quoteObject, us_ads: { value: 12.89, currency: "USD" } },
    pe: { status: "not-applicable", reason: "TTM 净利润为负" },
  }));
  // 股价的 {hk, us_ads} 每支都是校验对象，渲染层并列显示得出来；
  // 市值把币种编进键名，没有单位可读，必须被挡下。
  assert.deepEqual(problems, ["市值"]);
});
