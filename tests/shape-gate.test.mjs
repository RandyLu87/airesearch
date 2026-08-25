import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * 写法闸门 — 研究流程第 4 步（docs/research/workflow/04-data-validation.md）。
 *
 * 首屏闸门只看四个字段，写法闸门扫全树，挡两类「页面认得出、读者看到的却是错的」：
 * 裸占位字符串（`"unavailable"` 当值写，百分比列里拼成 `unavailable%`）与未缩写
 * 大数字（`23051044345` 直接渲染成 11 位数字，网易云音乐 hk-9899 就是这样发出去的）。
 *
 * 这两类都不是「取不到数」，而是写法不对——数据已经采到，要改的是形状。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validator = path.join(repoRoot, "docs", "research", "tools", "data_validator.py");

/** 跑一次校验，返回 { code, problems }——problems 是写法闸门报出的 [type, path]。 */
function runGate(collection) {
  const dir = mkdtempSync(path.join(tmpdir(), "airesearch-shape-"));
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
    const entry = parsed.results.find((res) => res.step === "collection");
    return {
      code: result.status,
      gapTypes: entry.gaps.map((gap) => gap.type),
      requiredSlots: entry.requiredSlots,
      filled: entry.filled,
      problems: entry.shapeProblems.map((problem) => [problem.type, problem.path]),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 契约内的写法：市值缩写成字符串，缺失写成完整占位对象。 */
const clean = {
  meta: { companyId: "hk-0000-fixture", dataCutoff: "2026-08-20" },
  currentValuation: {
    sharePrice: { value: 112.6, currency: "HKD" },
    marketCap: { reported: { value: "230.51亿", currency: "HKD" } },
    pe: "11.99x",
  },
  revenueStructure: {
    latestFiscalYear: {
      segments: [
        {
          name: "在线音乐服务",
          revenue: { value: "59.94亿", currency: "RMB" },
          grossMarginPct: { status: "unavailable", reason: "年报未按分部披露毛利率，已查 2025 年报与 2026 中报" },
        },
      ],
    },
  },
};

test("the shape gate passes abbreviated numbers and canonical absent objects", () => {
  const { code, problems } = runGate(clean);
  assert.deepEqual(problems, []);
  // 分数低于阈值仍会挡（这份夹具只有几个槽位），但不该是写法问题挡的。
  assert.equal(problems.length, 0, `code=${code}`);
});

test("the shape gate blocks an unabbreviated market cap", () => {
  // 网易云音乐 hk-9899 原样：页头渲染成 `23,051,044,345 HKD`。
  const fixture = structuredClone(clean);
  fixture.currentValuation.marketCap.reported = {
    value: 23051044345,
    currency: "HKD",
    source: "FMP company profile-symbol",
  };
  const { code, problems } = runGate(fixture);
  assert.deepEqual(problems, [["unabbreviated-number", "currentValuation.marketCap.reported"]]);
  assert.equal(code, 1, "an unabbreviated large number must fail the run");
});

test("stringifying a large number without abbreviating it does not slip through", () => {
  // 渲染层的 formatNumeric 只作用于 number，字符串原样输出——加引号不改任何东西。
  const fixture = structuredClone(clean);
  fixture.currentValuation.marketCap.reported = { value: "23,051,044,345", currency: "HKD" };
  const { code, problems } = runGate(fixture);
  assert.deepEqual(problems, [["unabbreviated-number", "currentValuation.marketCap.reported"]]);
  assert.equal(code, 1, "a stringified-but-unabbreviated number must fail the run");
});

test("an unabbreviated number costs its slot instead of inflating the denominator", () => {
  // 命中的字段 walk() 本来记满权重；写法闸门要把那 1 分收回，而不是只多加一个 0 分槽位。
  const base = runGate(clean);
  const fixture = structuredClone(clean);
  fixture.currentValuation.marketCap.reported = { value: 23051044345, currency: "HKD" };
  const hit = runGate(fixture);
  assert.equal(hit.requiredSlots, base.requiredSlots, "分母不该被抬高");
  assert.equal(hit.filled, base.filled - 1, "命中的槽位应从已填里扣掉");
});

test("the shape gate blocks a bare absent string", () => {
  // 5 年趋势表把「取不到」写成裸字符串，渲染层拼上后缀 → `unavailable%`。
  const fixture = structuredClone(clean);
  fixture.revenueStructure.latestFiscalYear.segments[0].grossMarginPct = "unavailable";
  const { code, problems } = runGate(fixture);
  assert.deepEqual(problems, [
    ["bare-absent-string", "revenueStructure.latestFiscalYear.segments[0].grossMarginPct"],
  ]);
  assert.equal(code, 1, "a bare absent string must fail the run");
});

test("a bare absent string is a gap, not a filled slot", () => {
  // 这条是缺陷的根因：resolve_field() 会把裸字符串 str() 成非 None，
  // 不单独拦就被当作「已填」计满权重，分数上看不出问题。
  const fixture = structuredClone(clean);
  fixture.revenueStructure.latestFiscalYear.segments[0].name = "unavailable";
  const { gapTypes } = runGate(fixture);
  assert.ok(gapTypes.includes("bare-absent-string"), `gaps were: ${gapTypes.join(", ")}`);
  assert.equal(gapTypes.filter((type) => type === "bare-absent-string").length, 1,
    "walk() 与写法扫描各记一次的话，同一个字段会被扣两次分");
});

test("the shape gate leaves small numbers and provenance copies alone", () => {
  // 股价、倍数不缩写；source1/source2 里的数值副本没有单位，也不是渲染位。
  const fixture = structuredClone(clean);
  fixture.currentValuation.sharesOutstanding = {
    value: "2.05亿",
    unit: "股",
    source1: { name: "FMP shares-float", value: 204716202 },
  };
  assert.deepEqual(runGate(fixture).problems, []);
});
