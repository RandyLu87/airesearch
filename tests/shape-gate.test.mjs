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
 * 首屏闸门只看四个字段，写法闸门扫全树，挡三类「页面认得出、读者看到的却是错的」：
 * 裸占位字符串（`"unavailable"` 当值写）、未缩写大数字（`23051044345` 直接渲染成 11 位
 * 数字，网易云音乐 hk-9899 就是这样发出去的），以及量级在 `unit` 与 `currency` 之间
 * 互相矛盾、渲染层无从判断 value 属于哪个量级的写法。
 *
 * 这三类都不是「取不到数」，而是写法不对——数据已经采到，要改的是形状。
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

test("a magnitude that only unit carries is not a defect any more", () => {
  // 腾讯 FY2024 收入原样（OWLL-27 清单里的 160 处同类写法）：量级只写在 unit 里，
  // 渲染层与 unit_label() 都保留它（`751,766 RMB million`），所以不再计写法问题。
  const fixture = structuredClone(clean);
  fixture.revenueStructure.latestFiscalYear.segments[0].revenue = {
    value: 751766, unit: "RMB million", currency: "RMB",
  };
  assert.deepEqual(runGate(fixture).problems, []);
});

test("the shape gate blocks unit and currency declaring different magnitudes", () => {
  // 两处各写一个量级，渲染层无从判断 value 是百万还是十亿——只能挡回去让人写清楚。
  const fixture = structuredClone(clean);
  fixture.revenueStructure.latestFiscalYear.segments[0].revenue = {
    value: 751766, unit: "RMB million", currency: "RMB billion",
  };
  const { code, problems } = runGate(fixture);
  assert.deepEqual(problems, [
    ["unit-overridden-by-currency", "revenueStructure.latestFiscalYear.segments[0].revenue"],
  ]);
  assert.equal(code, 1, "an ambiguous magnitude must fail the run");
});

test("the shape gate blocks a placeholder written into currency", () => {
  // 快手 hk-1024 原样：`currency: "-"` 非空，渲染层拿它当单位 → `43.3亿 -`。
  const fixture = structuredClone(clean);
  fixture.currentValuation.sharesOutstanding = { value: "43.3亿", unit: "股", currency: "-" };
  const { code, problems } = runGate(fixture);
  assert.deepEqual(problems, [
    ["placeholder-unit-label", "currentValuation.sharesOutstanding.currency"],
  ]);
  assert.equal(code, 1, "a placeholder currency must fail the run");
});

test("the shape gate accepts null for a field that has no unit", () => {
  // 「没有币种」的正确写法是 null——annotation() 当它没写，页面上只剩 `43.3亿 股`。
  const fixture = structuredClone(clean);
  fixture.currentValuation.sharesOutstanding = { value: "43.3亿", unit: "股", currency: null };
  assert.deepEqual(runGate(fixture).problems, []);
});

test("the shape gate blocks two notations for money inside one file", () => {
  // 理想汽车 hk-2015 原样：同一个市值一处 `"101.22B"`、一处 `"1044.61亿"`。
  const fixture = structuredClone(clean);
  fixture.currentValuation.marketCap.computed = { value: "23.05B", unit: "HKD" };
  const { code, problems } = runGate(fixture);
  // 夹具里金额只有 reported（`"230.51亿"`）与 computed 两处，并列时报后出现的那一套。
  assert.deepEqual(problems, [["mixed-notation", "currentValuation.marketCap.computed"]]);
  assert.equal(code, 1, "mixing notations must fail the run");
});

test("the notation check leaves counts and quoted source values alone", () => {
  // 夹具的金额一律用中文量级；这里加进来的英文缩写都在不参与比较的位置上：
  // 「3.49亿股」是计数单位（中文里的自然写法），`349.24M` 是 source1 里照抄的来源原文。
  const fixture = structuredClone(clean);
  fixture.currentValuation.sharesOutstanding = {
    value: "3.49亿",
    unit: "股",
    source1: { name: "stockanalysis.com", value: "349.24M" },
  };
  assert.deepEqual(runGate(fixture).problems, []);
});

/** 带双源的校验对象：source2 的缺失态是这一组用例要挡的写法。 */
function withSource2(source2, deviationPct) {
  const fixture = structuredClone(clean);
  fixture.revenueStructure.latestFiscalYear.segments[0].revenue = {
    value: "59.94亿",
    currency: "RMB",
    source1: { name: "公司 FY2025 年报", value: "59.94亿" },
    source2,
    deviationPct,
  };
  return fixture;
}

const REVENUE = "revenueStructure.latestFiscalYear.segments[0].revenue";

test("the shape gate blocks a null second source", () => {
  // 腾讯 hk-0700 原样：`source2: null` 与 `deviationPct: null` 并存，读的人看不出
  // 这个数是「只有单源」还是「忘了填」。
  const { code, problems } = runGate(withSource2(null, null));
  assert.deepEqual(problems, [["absent-source2-shape", `${REVENUE}.source2`]]);
  assert.equal(code, 1, "a null second source must fail the run");
});

test("the shape gate blocks the placeholder and prose forms of a missing second source", () => {
  // 网易云音乐 `{ name: "unavailable，仅单源" }`、Netflix 交叉验证记录 `{ name: "—" }`。
  for (const source2 of [{ name: "—", value: "—" }, { name: "unavailable，仅单源", url: "", value: null }]) {
    const { problems } = runGate(withSource2(source2, null));
    assert.deepEqual(problems, [["absent-source2-shape", `${REVENUE}.source2`]],
      `未挡住的写法：${JSON.stringify(source2)}`);
  }
});

test("the shape gate blocks a stale deviationPct next to an absent second source", () => {
  // source2 已是规范占位对象，deviationPct 还是 null——「没有第二个数」这件事只说了一半。
  const absent = { status: "unavailable", reason: "本次采集只取得单一独立来源" };
  const { code, problems } = runGate(withSource2(absent, null));
  assert.deepEqual(problems, [["deviation-without-source2", `${REVENUE}.deviationPct`]]);
  assert.equal(code, 1, "a null deviationPct without a second source must fail the run");
});

test("the shape gate accepts the canonical pair", () => {
  const fixture = withSource2(
    { status: "unavailable", reason: "本次采集只取得单一独立来源，未找到可用于交叉验证的第二来源" },
    { status: "not-applicable", reason: "仅单源，无第二来源可比，不计算偏差率（见 source2.reason）" },
  );
  assert.deepEqual(runGate(fixture).problems, []);
});

test("a real second source with a computed deviation stays untouched", () => {
  const fixture = withSource2({ name: "stockanalysis.com", value: "59.9亿" }, 0.07);
  assert.deepEqual(runGate(fixture).problems, []);
});
