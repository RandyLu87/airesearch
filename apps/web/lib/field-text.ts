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

/** 把任意值渲染成文本：校验对象取 value，缺失 / 不适用如实给原因，不吞字段。 */
export function text(value: Json): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" || typeof value === "number") return String(value);
  const absent = absentStatus(value);
  if (absent) return `${ABSENT_LABELS[absent]}：${value.reason ?? "未说明原因"}`;
  if (typeof value === "object" && !Array.isArray(value)) {
    if ("value" in value) {
      // 单位优先取 currency；只写了 unit 的字段（双重上市的分支里很常见）同样要带上，
      // 否则 49.92 与 12.90 会并排出现而看不出一个是港元一个是美元。
      const unit = value.currency ?? value.unit ?? "";
      return `${value.value}${unit ? ` ${unit}` : ""}`;
    }
    const multi = multiListingText(value);
    if (multi) return multi;
  }
  return "—";
}

/** 去掉数值后面的括号注释：摘要位只放数字，长注释留给正文。 */
export function stripNote(raw: string): string {
  return raw.split("(")[0].split("（")[0].trim();
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
