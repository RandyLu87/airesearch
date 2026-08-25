/**
 * 字段取值 — 首页卡片与公司分析页共用的唯一一份实现。
 *
 * 两个页面都要把 financials-final.json 里的字段渲染成文本，历史上各写了一份
 * `text()`，于是「双重上市的股价渲染不出来」这类缺陷只在其中一处被修掉。
 * 契约的唯一正文在 docs/model/financials—model-template.json，渲染只有这一份实现。
 *
 * 与之配套的闸门在 docs/research/tools/data_validator.py 的 `resolve_field()`：
 * 首屏字段解析不出来就不放行发布。**两边的解析规则必须同时改**。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;

/**
 * 「没有数值」的两种占位，语义不同，不能混成一句话：
 * `unavailable` 是查不到（来源没有 / 未披露），`not-applicable` 是算不出
 * （分母为负、口径不成立）。亏损公司的 PE 属于后者，写成「缺失」会读成数据没采到。
 */
export const ABSENT_LABELS: Record<string, string> = {
  "unavailable": "未取得",
  "not-applicable": "不适用",
};

export function absentStatus(value: Json): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return typeof value.status === "string" && value.status in ABSENT_LABELS ? value.status : null;
}

/** 是否是规范的「取不到 / 不适用」占位对象。 */
export function isUnavailable(value: Json): boolean {
  return absentStatus(value) !== null;
}

/**
 * 字段对象里不承载数值的键：判断「这个对象是不是多口径映射」时必须先剔除它们，
 * 否则 source / note 之类的注解会被当成一个口径。
 */
const FIELD_ANNOTATION_KEYS = new Set([
  "source", "source1", "source2", "sources", "url", "note", "notes", "flag",
  "deviationPct", "unit", "currency", "status", "reason", "method", "toolOutput",
  "toolVerified", "asOf", "_dimension",
]);

function isQuoteObject(value: Json): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && "value" in value;
}

/**
 * 多市场 / 多币种字段：双重上市公司（H 股 + 美股 ADS）的股价与市值天然有两个口径。
 * 采集契约要求写成 `{ primary: <校验对象>, alt: [<校验对象>] }`——primary 是主上市地，
 * 正文读它，alt 跟在括号里，次口径不消失。
 *
 * 兼容分支：每个非注解键都挂着一个可渲染的校验对象时（如 `{hk: …, us_ads: …}`），
 * 并列渲染而不是丢弃。**只认校验对象，不认裸标量**——`{hk_hkd: 101219774273}` 这种
 * 把币种编进键名的写法没有单位可读，渲染层不替它猜，交给首屏闸门挡回去。
 */
function fieldLegs(value: Json): string[] | null {
  if (value.primary !== undefined) {
    const head = text(value.primary);
    if (head === "—") return null;
    const alt = (Array.isArray(value.alt) ? value.alt : [value.alt])
      .filter((item: Json) => item !== undefined && item !== null)
      .map((item: Json) => text(item))
      .filter((item: string) => item !== "—");
    return [head, ...alt];
  }
  const entries = Object.entries(value).filter(([key]) => !FIELD_ANNOTATION_KEYS.has(key));
  if (entries.length === 0) return null;
  if (!entries.every(([, item]) => isQuoteObject(item))) return null;
  const parts = entries.map(([, item]) => text(item)).filter((item) => item !== "—");
  return parts.length > 0 ? parts : null;
}

/** 主口径在前，次口径进括号：`49.92 HKD（12.90 USD）`。 */
function joinLegs(legs: string[]): string {
  return legs.length > 1 ? `${legs[0]}（${legs.slice(1).join(" / ")}）` : legs[0];
}

function multiListingText(value: Json): string | null {
  const legs = fieldLegs(value);
  return legs ? joinLegs(legs) : null;
}

/**
 * 数值兜底格式化：采集/分析文件的约定是大数字自己先写成缩写字符串
 * （`"113.99B"`、`"4.31B"`），渲染层原样输出。但约定不是校验规则，漏写会让原始
 * JS number（如 113990000000）直接拼进页面变成一串连续数字。这里只给整数部分
 * 加千分位，**不改动小数部分的精度**——`toLocaleString` 默认会把小数截到 3 位
 * 甚至更少，49.92 这类已经是合理精度的小数（如双币种换算价）会被它悄悄削掉
 * 尾数，那是比原始 bug 更隐蔽的数据失真。这里不猜测单位量级（不会自作主张缩成
 * "114B"）——缩写依赖 unit/currency 语境，只有写数据的人知道，渲染层不猜。
 * 只对裸数字生效：字符串数值（已经是 "113.99B" 这种约定格式）原样通过。
 */
function formatNumeric(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const raw = Math.abs(value).toString();
  if (raw.includes("e") || raw.includes("E")) return String(value); // 科学计数法：不猜测展开方式，原样返回
  const [intPart, fracPart] = raw.split(".");
  const withSeparators = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = value < 0 ? "-" : "";
  return fracPart ? `${sign}${withSeparators}.${fracPart}` : `${sign}${withSeparators}`;
}

/**
 * 量级词表：`unit` 里可能出现的量级，**长的先匹配**（`万亿` 必须排在 `亿` 与 `万` 前面，
 * 否则 `万亿元` 会被读成 `万`）。这张表是 docs/research/tools/data_validator.py 的
 * `MAGNITUDES` 的镜像，改一处必须改另一处。
 */
const MAGNITUDES: Array<[string, number]> = [
  ["万亿", 1e12], ["trillion", 1e12],
  ["十亿", 1e9], ["billion", 1e9], ["bn", 1e9],
  ["亿", 1e8],
  ["千万", 1e7],
  ["百万", 1e6], ["million", 1e6], ["mn", 1e6],
  ["万", 1e4],
  ["千", 1e3], ["thousand", 1e3],
];

/** 单位串里声明的量级；没有量级词返回 null（`"HKD"`、`"股"`、`"currency"`）。 */
function magnitudeOf(label: string): number | null {
  const lower = label.toLowerCase();
  for (const [token, scale] of MAGNITUDES) {
    if (lower.includes(token)) return scale;
  }
  return null;
}

/**
 * 单位串去掉量级词后剩下的部分：`"百万"` → `""`，`"RMB million"` → `"RMB"`，
 * `"亿股"` → `"股"`。剩下东西就说明这个单位自己点明了计量对象，不需要 currency 补。
 */
function magnitudeRest(label: string): string {
  const lower = label.toLowerCase();
  for (const [token] of MAGNITUDES) {
    const at = lower.indexOf(token);
    if (at >= 0) return `${label.slice(0, at)}${label.slice(at + token.length)}`.replace(/[\s,，/·]+/g, " ").trim();
  }
  return label.trim();
}

/** 占位币种：`-` / `N/A` 这类「没写」的写法，拼进单位串只会变成 `140.19 million ADS N/A`。 */
const PLACEHOLDER_LABEL = /^(?:[-—–]+|n\/?a|未?披露|\?+)$/i;

/** 未缩写的裸数字：`751766` / `"751,766"`（缩写过的 `"7517.66亿"` 不算）。 */
const BARE_NUMBER = /^-?\d[\d,]*(\.\d+)?$/;

function isBareNumber(value: Json): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && BARE_NUMBER.test(value.trim());
}

function annotation(value: Json): string {
  return typeof value === "string" ? value.trim()
    : value === null || value === undefined || typeof value === "object" ? "" : String(value);
}

/**
 * 校验对象的单位串。默认取 `currency`（只写了 `unit` 的字段——双重上市的分支里很常见
 * ——同样要带上，否则 49.92 与 12.90 会并排出现而看不出一个是港元一个是美元）。
 *
 * 例外是「量级只写在 unit 里」：`{ value: 751766, unit: "RMB million", currency: "RMB" }`
 * 按 currency 优先渲染成 `751,766 RMB`，比真实值小 6 个量级（腾讯 FY2024 收入，
 * research/evals/defects.jsonl 记的那一类）。这种字段的语义是「数值 + 量级 + 币种」
 * 三元组，量级词不能被纯币种压掉，所以保留 `unit`，并在 `unit` 只写量级不写币种时
 * （`"百万"`）把 currency 接在后面。
 *
 * 只在 `value` 是裸数字时这么做：`value` 已经是缩写字符串（`"7517.66亿"`）时再叠一个
 * `unit` 的量级就是乘两次。currency 自己也带量级（`"RMB百万"`，仓库里真实存在）时
 * 照旧取 currency——那本来就没丢量级。
 *
 * currency 只补给**纯量级** unit（`"百万"`）：`unit` 去掉量级词后还剩东西，它自己就点明了
 * 计量对象——`"RMB million"` 的币种、`"亿股"` 的股数、`"million ADS"` 的凭证数——再接
 * currency 会拼出 `252.2 亿股 CNY`（招行 sharesOutstanding）这种读不通的串。
 */
function unitLabel(field: Json): string {
  const unit = annotation(field.unit);
  // 占位币种当成没写：`-` / `n/a` 非空，会在下面每一条「取 currency」的分支里压过真正
  // 的单位——快手 sharesOutstanding（`43.3亿` / unit `股` / currency `-`）渲染成
  // `43.3亿 -`，读者看不出计量的是股数。
  const declared = annotation(field.currency);
  const currency = PLACEHOLDER_LABEL.test(declared) ? "" : declared;
  if (!unit || !currency) return currency || unit;
  if (!isBareNumber(field.value)) return currency;
  if (magnitudeOf(unit) === null || magnitudeOf(currency) !== null) return currency;
  if (magnitudeRest(unit) !== "") return unit;
  return `${unit} ${currency}`;
}

/** 把任意值渲染成文本：校验对象取 value，缺失 / 不适用如实给原因，不吞字段。 */
export function text(value: Json): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return formatNumeric(value);
  if (typeof value === "string") return value;
  const absent = absentStatus(value);
  if (absent) return `${ABSENT_LABELS[absent]}：${value.reason ?? "未说明原因"}`;
  if (typeof value === "object" && !Array.isArray(value)) {
    if ("value" in value) {
      const unit = unitLabel(value);
      const rendered = typeof value.value === "number" ? formatNumeric(value.value) : String(value.value);
      return `${rendered}${unit ? ` ${unit}` : ""}`;
    }
    const multi = multiListingText(value);
    if (multi) return multi;
  }
  return "—";
}

/** 括号注释的起点；没有注释时返回 `raw.length`。百分比后缀要插在它前面，不能拼在整串末尾。 */
export function noteIndex(raw: string): number {
  const marks = ["(", "（"].map((mark) => raw.indexOf(mark)).filter((index) => index >= 0);
  return marks.length > 0 ? Math.min(...marks) : raw.length;
}

/** 去掉数值后面的括号注释：摘要位只放数字，长注释留给正文。 */
export function stripNote(raw: string): string {
  return raw.slice(0, noteIndex(raw)).trim();
}

/**
 * 百分比字段渲染：value 按规范本身可能已带 `%`（见
 * docs/research/workflow/02-multi-dimension-analysis.md「数字纯净」规则），
 * 缺失 / 不适用说明或 `—` 占位更不该被拼接单位——仅当数值以纯数字结尾时才补 `%`。
 *
 * 「纯数字结尾」按**括号注释之前**的那一段判断：`-29.38%（净利润换算，非公司列示科目）`
 * 整串不以 `%` 结尾，按整串判断就会再拼一个 → `…科目）%`（网易云音乐 hk-9899 的 5 年
 * 趋势表）。后缀补在注释前面，注释原样留在末尾。
 */
export function pctText(value: Json): string {
  const raw = text(value);
  if (raw === "—" || isUnavailable(value)) return raw;
  const cut = noteIndex(raw);
  const head = raw.slice(0, cut).trimEnd();
  // 注释排在数字前面（`（同比口径）12.5`）时 head 是空的，没有「注释前那一段」可判断，
  // 退回按整串末尾补——否则该补的 `%` 会整个丢掉。
  const anchor = head === "" ? raw.trimEnd() : head;
  if (anchor.endsWith("%") || !/\d$/.test(anchor)) return raw;
  return head === "" ? `${anchor}%` : `${head}%${raw.slice(cut)}`;
}

export function clampText(raw: string, limit: number): string {
  return raw.length > limit ? `${raw.slice(0, limit)}…` : raw;
}

export type Headline = { value: string; note?: string; title?: string };

/**
 * 摘要位取值。成功值去掉括号注释，但**缺失说明不走同一条截断**——
 * `TTM(2025Q2-2026Q1)GAAP净利润为负…` 在第一个括号处被砍掉只剩「TTM」，
 * 既不给数也不给因。缺失时正文位给短标签，原因进副行，完整原文进 title。
 */
export function headline(value: Json): Headline {
  const absent = absentStatus(value);
  if (absent) {
    const reason = String(value.reason ?? "未说明原因");
    return { value: ABSENT_LABELS[absent], note: clampText(reason, 42), title: reason };
  }
  // 多市场字段先逐口径去注释再拼：拼完再截断的话，括号里的次口径会被整段当成
  // 注释砍掉——`12.34 USD（98.70 HKD）` 会退化成只剩主上市地。
  const legs = value && typeof value === "object" && !Array.isArray(value) && !("value" in value)
    ? fieldLegs(value)
    : null;
  if (legs) {
    const stripped = legs.map(stripNote).filter(Boolean);
    const full = joinLegs(legs);
    const head = joinLegs(stripped);
    return { value: head, title: head === full ? undefined : full };
  }
  const raw = text(value);
  if (raw === "—") return { value: "—" };
  const head = stripNote(raw);
  return { value: head || raw, title: head === raw ? undefined : raw };
}
