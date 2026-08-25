import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { pctText, text } from "../apps/web/lib/field-text.ts";

/**
 * 字段渲染 — apps/web/lib/field-text.ts。
 *
 * 这份实现有一个 Python 镜像（docs/research/tools/data_validator.py 的 resolve_field()）
 * 充当发布闸门，两边的解析规则必须一致。所以这里既锁住渲染结果本身，也逐个夹具
 * 跟 Python 侧对一遍——闸门放行的写法必须正是页面渲得对的写法。
 *
 * 缺陷记录：腾讯 FY2024 收入 `{value: 751766, unit: "RMB million", currency: "RMB"}`
 * 在 `currency ?? unit` 的取值规则下渲染成 `751,766 RMB`，比真实值小 6 个量级
 * （OWLL-27 清单，全仓库同类写法 160 处）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validator = path.join(repoRoot, "docs", "research", "tools", "data_validator.py");

/** 跑 Python 镜像的 resolve_field()，返回它解析出来的文本。 */
function resolveInPython(field) {
  const script = [
    "import importlib.util, json, sys",
    `spec = importlib.util.spec_from_file_location("dv", ${JSON.stringify(validator)})`,
    "mod = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "print(json.dumps(mod.resolve_field(json.loads(sys.argv[1]))))",
  ].join("\n");
  const result = spawnSync("python3", ["-c", script, JSON.stringify(field)], { encoding: "utf8" });
  assert.equal(result.status, 0, `python mirror failed:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

/** 千分位是渲染层独有的（Python 侧不加），比对镜像时抹掉。 */
function comparable(rendered) {
  return rendered.replace(/,/g, "");
}

const fields = {
  "量级只在 unit 里": [{ value: 751766, unit: "RMB million", currency: "RMB" }, "751,766 RMB million"],
  "unit 只写量级不写币种": [{ value: 751766, unit: "百万", currency: "RMB" }, "751,766 百万 RMB"],
  "中文量级单位自带币种": [{ value: 2611, unit: "亿元", currency: "CNY" }, "2,611 亿元"],
  "currency 自己带量级": [{ value: 751766, unit: "RMB million", currency: "RMB百万" }, "751,766 RMB百万"],
  "value 已缩写": [{ value: "7517.66亿", unit: "RMB million", currency: "RMB" }, "7517.66亿 RMB"],
  "没有量级词": [{ value: 44.18, currency: "HKD" }, "44.18 HKD"],
  "只写了 unit": [{ value: 12.9, unit: "USD" }, "12.9 USD"],
  "多市场字段": [
    { primary: { value: 49.92, currency: "HKD" }, alt: [{ value: 12.9, currency: "USD" }] },
    "49.92 HKD（12.9 USD）",
  ],
};

test("a magnitude written only in unit survives rendering", () => {
  // 修复前是 `751,766 RMB`：unit 的 million 被纯币种 currency 压掉。
  assert.equal(text(fields["量级只在 unit 里"][0]), "751,766 RMB million");
});

test("a bare magnitude unit keeps the currency next to it", () => {
  assert.equal(text(fields["unit 只写量级不写币种"][0]), "751,766 百万 RMB");
});

test("an already abbreviated value is not stacked with the unit magnitude", () => {
  // `"7517.66亿"` 再叠一个 million 就是乘两次——只有裸数字才补 unit 的量级。
  assert.equal(text(fields["value 已缩写"][0]), "7517.66亿 RMB");
});

test("field-text.ts and the python gate resolve every fixture the same way", () => {
  for (const [name, [field, expected]] of Object.entries(fields)) {
    const rendered = text(field);
    assert.equal(rendered, expected, `${name} 渲染结果变了`);
    assert.equal(comparable(rendered), comparable(String(resolveInPython(field))),
      `${name} 在渲染层与闸门之间不一致`);
  }
});

test("a percentage with a trailing note gets exactly one % sign", () => {
  // 网易云音乐 hk-9899 的 5 年趋势表原样：修复前渲染成 `…非公司列示科目）%`。
  const raw = "-29.38%（净利润按母公司权益持有人应占溢利换算，非公司列示科目）";
  assert.equal(pctText(raw), raw);
});

test("a percentage note does not swallow the % suffix either", () => {
  // 注释前那段是纯数字：后缀补在注释前面，不是整串末尾。
  assert.equal(pctText("41.8（含一次性版权摊销）"), "41.8%（含一次性版权摊销）");
});

test("pctText leaves absent placeholders and non-numeric text alone", () => {
  assert.equal(pctText({ status: "not-applicable", reason: "净利润为负，毛利率口径不成立" }),
    "不适用：净利润为负，毛利率口径不成立");
  assert.equal(pctText(null), "—");
  assert.equal(pctText({ value: 12.3, unit: "percent" }), "12.3 percent");
  assert.equal(pctText({ value: 12.3 }), "12.3%");
});
