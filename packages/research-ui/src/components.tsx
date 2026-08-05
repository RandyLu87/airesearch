import type { CSSProperties, ReactNode } from "react";
import {
  fairValueOf,
  isCurrentSnapshot,
  lookupStandardMetric,
  lookupValuationMethod,
  marketCapOf,
  periodsOfType,
  splitCausalChain,
  stanceOf,
  yearOnYearPair,
  type CurrentSnapshot,
  type FrozenSnapshot,
  type ResearchSnapshot,
  type StructuredSnapshot,
} from "@airesearch/research-schema";

type Period = CurrentSnapshot["financialHistory"][number];
type FinancialValue = Period["revenue"];

export function formatPrice(value: string, currency: string) {
  return `${currency === "HKD" ? "HK$" : `${currency} `}${value}`;
}

/** The currency belongs to the range, not to each of its ends. */
export function formatRange(low: string, high: string, currency: string) {
  return `${formatPrice(low, currency)}–${high}`;
}

/**
 * A market capitalisation with its scale spelled out.
 *
 * The scale is part of the number, not a footnote: "86" means nothing until you
 * know whether it is yuan or hundreds of millions of them.
 */
export function formatMarketCap(cap: {
  value: string;
  currency: string;
  scale: "one" | "million" | "hundred-million";
}) {
  const suffix = cap.scale === "hundred-million" ? "亿" : cap.scale === "million" ? "百万" : "";
  return `${cap.currency} ${cap.value}${suffix}`;
}

/**
 * The percentile as a header cell, in the same shape as market cap and price.
 *
 * It is a price fact and sits beside the other two rather than under them, so the
 * header really is the three facts ADR-0021 describes.
 */
export function MultiplePercentileCell({
  percentile,
}: {
  percentile: CurrentSnapshot["summary"]["multiplePercentile"];
}) {
  if (percentile.status === "unavailable") {
    return (
      <div>
        <span>{percentile.metricLabel} 历史分位</span>
        <strong>不可用</strong>
        <small>{percentile.reason}</small>
      </div>
    );
  }
  return (
    <div>
      <span>{percentile.metricLabel} 历史分位</span>
      <strong>{percentile.percentile}%</strong>
      <small>
        当前 {percentile.value}× · {percentile.windowFrom}–{percentile.windowTo} · {percentile.adjustmentBasis}
      </small>
    </div>
  );
}

/** The same reading as a standalone paragraph, for the company page's fact bar. */
export function MultiplePercentileBlock({
  percentile,
}: {
  percentile: CurrentSnapshot["summary"]["multiplePercentile"];
}) {
  if (percentile.status === "unavailable") {
    return (
      <p className="multiple-percentile multiple-percentile--unavailable">
        {percentile.metricLabel} 历史分位不可用：{percentile.reason}
      </p>
    );
  }
  return (
    <p className="multiple-percentile">
      当前 {percentile.metricLabel} <strong>{percentile.value}×</strong>，
      位于 {percentile.windowFrom}–{percentile.windowTo} 自身区间的{" "}
      <strong>{percentile.percentile}%</strong> 分位
      <small>价格序列口径：{percentile.adjustmentBasis}</small>
    </p>
  );
}

/**
 * One company on the site index.
 *
 * Reads through the version accessors rather than a field, because what a card
 * can say about a company depends on which contract its latest research was
 * written under: 1.2.0 leads with what the company costs today, and the two
 * frozen generations keep the stance and fair value they published with.
 */
export function CompanyCoverageCard({
  companyId,
  snapshot,
}: {
  companyId: string;
  snapshot: ResearchSnapshot;
}) {
  const { company, summary } = snapshot;
  const { referencePrice } = summary;
  const stance = stanceOf(snapshot);
  const fairValue = fairValueOf(snapshot);
  const marketCap = marketCapOf(snapshot);

  return (
    <a className="report-link" href={`./companies/${companyId}.html`}>
      <div className="company-card-meta">
        <span>{company.ticker}</span>
        <span>数据截止 <time>{snapshot.snapshot.dataCutoff.slice(0, 10)}</time></span>
      </div>
      <strong>{company.name}</strong>
      <p className="company-card-stance">
        {stance ? `${stance.stance}（确信度 ${stance.confidence}）` : summary.businessModel}
      </p>
      <dl className="company-card-facts">
        <div>
          <dt>参考价格</dt>
          <dd>
            {formatPrice(referencePrice.value, referencePrice.currency)}
            {/* The price carries its own timestamp because it can predate the
                research cutoff above; an unlabelled date would read as same-day. */}
            <small>截至 <time>{referencePrice.asOf.slice(0, 10)}</time></small>
          </dd>
        </div>
        {marketCap ? (
          <div>
            <dt>市值</dt>
            <dd>{formatMarketCap(marketCap)}</dd>
          </div>
        ) : null}
        {fairValue ? (
          <div>
            <dt>合理价值</dt>
            <dd>{formatRange(fairValue.low, fairValue.high, fairValue.currency)}</dd>
          </div>
        ) : null}
      </dl>
      <span>查看公司研究主页 →</span>
    </a>
  );
}

/**
 * The currency-and-scale suffix, without the number.
 *
 * Split out so a chart that puts the unit in its title and a table that puts it
 * after every figure cannot drift apart — the waterfall used to spell the same
 * unit "USD百万" while the segment table said "USD百万元".
 */
export function financialUnitLabel(value: FinancialValue) {
  const currency = value.currency === "CNY" ? "人民币" : value.currency ?? "";
  const scale = value.scale === "hundred-million"
    ? "亿元"
    : value.scale === "million"
      ? "百万元"
      : "元";
  return `${currency}${scale}`;
}

export function formatFinancialValue(value?: FinancialValue) {
  if (!value) return "未披露";
  if (value.unit === "percent") return `${value.value}%`;
  if (value.unit === "percentage-point") return `${value.value} 个百分点`;
  if (value.unit === "currency") return `${value.value} ${financialUnitLabel(value)}`;
  return value.value;
}

type ProseShape =
  | { kind: "plain"; text: string }
  | { kind: "paragraphs"; paragraphs: string[] }
  | { kind: "enumerated"; lead: string; items: string[]; tail: string };

/**
 * Break a long research paragraph along the structure its author already wrote.
 *
 * Two structures exist in this prose and both are mechanical to detect, so
 * neither needs a schema field: an explicit `(1)(2)(3)` enumeration, and
 * sentences ended by the full-width 。 (unambiguous in Chinese — decimals use a
 * half-width period, so "29.68%" never splits).
 *
 * Sentences are grouped to at least `MIN_PARAGRAPH` characters rather than one
 * per paragraph. Ungrouped, a constraint like AMD's would break into six
 * fragments, some of them eight characters long, which reads worse than the wall
 * it replaced. Measured over the four current companies this yields a median
 * paragraph of 81 characters and never fewer than 46.
 *
 * Short text is returned untouched: netease and Circle have no field over 112
 * characters, and splitting those would only add noise.
 */
const MIN_PARAGRAPH = 45;
/**
 * The last paragraph may be shorter than the rest — a brief closing sentence is
 * normal typography. Without this floor the merge-the-remainder rule cancelled
 * the split outright whenever a field had exactly two sentences and the second
 * fell just under MIN_PARAGRAPH: AMD's cash engine is 211 characters split
 * 170 + 41, and 41 lost to 45 collapsed it back into one wall of text.
 */
const MIN_FINAL_PARAGRAPH = 25;
const SPLIT_ABOVE = 110;

export function splitProse(text: string): ProseShape {
  const markers = [...text.matchAll(/[（(](\d+)[）)]\s*/g)];
  if (markers.length >= 2) {
    const items: string[] = [];
    let tail = "";
    for (const [index, marker] of markers.entries()) {
      const start = (marker.index ?? 0) + marker[0].length;
      const end = index + 1 < markers.length ? markers[index + 1].index ?? text.length : text.length;
      let chunk = text.slice(start, end).trim();
      // The enumeration closes with 。 and anything after it is a concluding
      // remark about the whole list, not part of the last item.
      if (index + 1 === markers.length) {
        const stop = chunk.indexOf("。");
        if (stop !== -1) {
          tail = chunk.slice(stop + 1).trim();
          chunk = chunk.slice(0, stop + 1);
        }
      }
      items.push(chunk.replace(/[；;]$/, ""));
    }
    return {
      kind: "enumerated",
      lead: text.slice(0, markers[0].index ?? 0).trim(),
      items,
      tail,
    };
  }

  if (text.length > SPLIT_ABOVE) {
    const sentences = (text.match(/[^。]+。|[^。]+$/g) ?? [])
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    const paragraphs: string[] = [];
    let current = "";
    for (const sentence of sentences) {
      current += sentence;
      if (current.length >= MIN_PARAGRAPH) {
        paragraphs.push(current);
        current = "";
      }
    }
    // Only a genuinely tiny remainder joins the previous paragraph.
    if (current) {
      if (paragraphs.length > 0 && current.length < MIN_FINAL_PARAGRAPH) {
        paragraphs[paragraphs.length - 1] += current;
      } else {
        paragraphs.push(current);
      }
    }
    if (paragraphs.length >= 2) return { kind: "paragraphs", paragraphs };
  }

  return { kind: "plain", text };
}

/**
 * Long prose, broken up when it has structure to break on.
 *
 * Renders a `<p>` when the text is left whole and a `<div>` when it is not, so
 * the result is valid wherever a block goes — including inside the `<li>` of a
 * bullet or risk list, where a nested `<p>` inside `<p>` would not be.
 */
export function ProseBlock({ text, className }: { text: string; className?: string }) {
  const shape = splitProse(text);
  if (shape.kind === "plain") return <p className={className}>{shape.text}</p>;

  return (
    <div className={className ? `${className} prose-block` : "prose-block"}>
      {shape.kind === "paragraphs"
        ? shape.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)
        : (
          <>
            {shape.lead ? <p>{shape.lead}</p> : null}
            <ol className="prose-enum">
              {shape.items.map((item, index) => <li key={index}>{item}</li>)}
            </ol>
            {shape.tail
              ? splitProse(shape.tail).kind === "paragraphs"
                ? (splitProse(shape.tail) as { paragraphs: string[] }).paragraphs.map(
                    (paragraph, index) => <p key={index}>{paragraph}</p>,
                  )
                : <p>{shape.tail}</p>
              : null}
          </>
        )}
    </div>
  );
}

/**
 * A CSS `<dashed-ident>` unique to this note.
 *
 * Anchor names have to be ASCII identifiers, and these ids carry Chinese
 * (`note-share-规模`), so stripping non-ASCII would collide. Hash instead.
 */
function anchorName(id: string): string {
  let hash = 5381;
  for (let index = 0; index < id.length; index += 1) {
    hash = ((hash << 5) + hash + id.charCodeAt(index)) >>> 0;
  }
  return `--anchor-${hash.toString(36)}`;
}

/**
 * The ⓘ affordance behind every metric name.
 *
 * Native `popover` rather than an inline `<details>`: these notes sit inside
 * table headers, and a horizontally scrolling `.table-wrap` would clip anything
 * positioned normally. The top layer is never clipped, and light-dismiss plus
 * Esc come free without a line of JavaScript — the published HTML has to work
 * opened straight off the filesystem.
 *
 * The panel is anchored to its own trigger (see `--note-anchor` in the CSS).
 * Left at the browser default it lands dead centre of the viewport, which reads
 * as a modal dialog rather than as a definition for the word you just tapped.
 *
 * On paper a popover cannot open at all, so print hides these and emits
 * `MetricGlossary` instead.
 */
export function MetricNote({
  id,
  title,
  formula,
  body,
  pitfall,
  note,
}: {
  id: string;
  title: string;
  formula?: string;
  body: string;
  pitfall?: string;
  note?: string;
}) {
  const popoverId = `note-${id}`;
  // Both the trigger and the panel read this, and custom properties inherit
  // down the DOM even after the popover is lifted into the top layer.
  const anchorStyle = { "--note-anchor": anchorName(popoverId) } as CSSProperties;
  return (
    <span className="metric-note-anchor" style={anchorStyle}>
      <button
        type="button"
        className="metric-note-toggle"
        aria-label={`查看${title}的定义`}
        // Spelled lowercase on purpose. React does not recognise `popoverTarget`
        // (it passes it through verbatim as camelCase), and while the HTML parser
        // lowercases attribute names anyway, emitting the spec spelling removes
        // one variable from a control that has already failed once.
        {...({ popovertarget: popoverId } as Record<string, string>)}
      >
        ⓘ
      </button>
      <span id={popoverId} popover="auto" className="metric-note">
        <strong className="metric-note-title">{title}</strong>
        {formula ? <code className="metric-note-formula">{formula}</code> : null}
        <span className="metric-note-body">{body}</span>
        {note ? <span className="metric-note-company">本公司口径：{note}</span> : null}
        {pitfall ? <span className="metric-note-pitfall">⚠ {pitfall}</span> : null}
      </span>
    </span>
  );
}

/** A ⓘ note sourced from the shared standard-metric dictionary. */
export function StandardMetricNote({
  metricId,
  scope,
  companyNote,
}: {
  metricId: string;
  scope: string;
  companyNote?: string;
}) {
  const definition = lookupStandardMetric(metricId);
  if (!definition) return null;
  return (
    <MetricNote
      id={`${scope}-${metricId}`}
      title={definition.label}
      formula={definition.formula}
      body={`${definition.definition} ${definition.why}`}
      pitfall={definition.pitfall}
      note={companyNote}
    />
  );
}

/**
 * Print-only definition list.
 *
 * On screen the ⓘ popovers do this job. On paper a popover cannot open, and
 * expanding every note inline would wreck the tables it lives in — so the same
 * content is emitted once, at the end, as footnotes. Hidden with `display:none`
 * until `@media print`.
 */
export function MetricGlossary({ snapshot }: { snapshot: ResearchSnapshot }) {
  const metricIds = [...new Set(snapshot.standardMetrics.map((metric) => metric.metricId))];
  const notes = new Map(
    snapshot.standardMetrics
      .filter((metric) => metric.definitionNote)
      .map((metric) => [metric.metricId, metric.definitionNote as string]),
  );

  return (
    <section className="metric-glossary" id="metric-glossary" aria-label="指标释义">
      <h2>指标释义</h2>
      <dl>
        {metricIds.map((metricId) => {
          const definition = lookupStandardMetric(metricId);
          if (!definition) return null;
          return (
            <div key={metricId}>
              <dt>{definition.label}</dt>
              <dd>{definition.formula}</dd>
              <dd>{definition.definition}{definition.why}</dd>
              {notes.get(metricId) ? <dd>本公司口径：{notes.get(metricId)}</dd> : null}
              {definition.pitfall ? <dd>⚠ {definition.pitfall}</dd> : null}
            </div>
          );
        })}
        {snapshot.driverMetrics.map((driver) => (
          <div key={driver.id}>
            <dt>{driver.label}（公司特定驱动）</dt>
            <dd>{driver.definition}</dd>
            <dd>因果作用：{driver.causalRole}</dd>
            <dd>历史基线：{driver.baseline}；验证阈值：{driver.threshold}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫"];

/**
 * The causal chain as a vertical stepped flow.
 *
 * Deliberately CSS rather than SVG, unlike the four decision charts of
 * ADR-0004: link labels run from 4 to 54 characters across the current
 * companies, and only flow text wraps. A fixed `viewBox` would have to truncate,
 * and what gets truncated is exactly the evidence — "（2026-03-28 为 257 亿美元）".
 *
 * Ordinals only, no stage names. The mandated template has seven links but real
 * chains have six to eight, so mapping position to a stage label would mislabel
 * any company that does not happen to have eight.
 */
function CausalChainFlow({ chain }: { chain: string }) {
  const links = splitCausalChain(chain);
  if (links.length < 2) return <p className="model-prose">{chain}</p>;

  return (
    <div className="causal-flow">
      <ol>
        {links.map((link, index) => (
          <li key={index}>
            <span className="causal-step" aria-hidden="true">
              {CIRCLED[index] ?? `${index + 1}.`}
            </span>
            <p>
              <span className="visually-hidden">{`第 ${index + 1} 环：`}</span>
              {link}
            </p>
          </li>
        ))}
      </ol>
      {/* The return path stays as a mark, not a sentence: the dashed stub
          continues the spine and the arrow turns back up. Screen readers and
          paper still get the closure spelled out, since neither can read a
          dashed line. */}
      <p className="causal-loop">
        {/* A plain up arrow, not ↺: the loop glyph has poor coverage in the
            local Inter/PingFang stack and renders as a smudge at this size. */}
        <span className="causal-loop-mark" aria-hidden="true">↑</span>
        <span className="causal-loop-note">
          {CIRCLED[links.length - 1] ?? links.length} → {CIRCLED[0]}
        </span>
      </p>
    </div>
  );
}

/**
 * Keep hyphen- and slash-joined tokens on one line inside the narrow ring cards.
 *
 * A card is about 17 characters wide, and the default break opportunity after a
 * hyphen splits "2026-03-28" into "2026-" / "03-28" — the reader has to
 * reassemble a date. Same for "HBM4/CoWoS" and "EPYC/Instinct". This wraps such
 * tokens in a nowrap span; the DOM text is untouched, so copy-paste and search
 * still see the original string. Long tokens are left alone rather than forced
 * to overflow the card.
 */
function keepTokensIntact(text: string): ReactNode[] {
  return text
    .split(/([A-Za-z0-9]+(?:[-/][A-Za-z0-9]+)+)/g)
    .map((part, index) =>
      index % 2 === 1 && part.length <= 16
        ? <span className="nowrap" key={index}>{part}</span>
        : part,
    );
}

/** Geometry of the flywheel ring, shared by the card layer and the arc layer. */
// Height is tuned so the tallest card at the top and the shortest at the
// bottom both sit close to the box edge; a taller box just adds dead space.
const RING = { width: 1000, height: 726, rx: 330, ry: 292 };

function ringPoint(angle: number) {
  return {
    x: RING.width / 2 + RING.rx * Math.sin(angle),
    y: RING.height / 2 - RING.ry * Math.cos(angle),
  };
}

/**
 * The causal chain as a flywheel: full-text cards placed around a ring.
 *
 * Cards carry the complete link text, not a summary. That matters — every
 * mechanical way of shortening these labels to fit a conventional ring either
 * overflowed or changed the meaning ("扣除人员、合规与软件投入形成股东现金流"
 * truncates to "扣除人员"), and a real summary would have to be authored into the
 * snapshot, which no published snapshot has.
 *
 * Positions come from the node count at build time, so nothing here needs
 * tuning per company: with eight cards the centres sit 291px apart on the ring
 * while a card is 210px wide, so adjacent cards cannot collide however long
 * their text runs. Fewer nodes only spreads them further.
 *
 * PC only. The ring needs ~970px; print has 673mm-equivalent and phones far
 * less, so both fall back to `CausalChainFlow`, which carries the same text.
 */
function CausalChainRing({ links, companyName }: { links: string[]; companyName: string }) {
  const step = (Math.PI * 2) / links.length;
  // The arc runs behind the cards it connects — they have an opaque background
  // and paint after the track — so it can start early and read as a continuous
  // ring. The arrowhead cannot: it has to land in the visible gap, so it gets a
  // wider clearance of its own.
  const arcPad = step * 0.13;
  const headPad = step * 0.31;

  return (
    <div className="flywheel" style={{ aspectRatio: `${RING.width} / ${RING.height}` }}>
      <svg className="flywheel-track" viewBox={`0 0 ${RING.width} ${RING.height}`} aria-hidden="true">
        {links.map((_, index) => {
          const from = ringPoint(index * step + arcPad);
          const to = ringPoint((index + 1) * step - arcPad);
          const head = (index + 1) * step - headPad;
          const point = ringPoint(head);
          // Tangent of (rx sin θ, −ry cos θ) is (rx cos θ, ry sin θ).
          const rotation =
            (Math.atan2(RING.ry * Math.sin(head), RING.rx * Math.cos(head)) * 180) / Math.PI;
          return (
            <g key={index}>
              <path
                className="flywheel-arc"
                d={`M ${from.x.toFixed(1)} ${from.y.toFixed(1)} A ${RING.rx} ${RING.ry} 0 0 1 ${to.x.toFixed(1)} ${to.y.toFixed(1)}`}
              />
              <polygon
                className="flywheel-head"
                points="0,-5 11,0 0,5"
                transform={`translate(${point.x.toFixed(1)} ${point.y.toFixed(1)}) rotate(${rotation.toFixed(1)})`}
              />
            </g>
          );
        })}
      </svg>
      <div className="flywheel-hub">
        {/* Name and label on separate lines: "Circle Internet Group 增长飞轮"
            on one line wrapped as "…增长飞" / "轮". No link count and no
            "末环回指首环" caption — a closed ring of arrows states both, and
            captioning a graphic with what it already shows is noise. */}
        <strong>{companyName}</strong>
        <em>增长飞轮</em>
      </div>
      <ol className="flywheel-cards">
        {links.map((link, index) => {
          const { x, y } = ringPoint(index * step);
          return (
            <li
              key={index}
              style={{ left: `${(x / RING.width) * 100}%`, top: `${(y / RING.height) * 100}%` }}
            >
              <span className="flywheel-badge" aria-hidden="true">{index + 1}</span>
              <p>
                <span className="visually-hidden">{`第 ${index + 1} 环：`}</span>
                {keepTokensIntact(link)}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

type WaterfallBar = {
  key: string;
  label: string;
  value: number;
  display: string;
  kind: "segment" | "cost" | "total";
};

/**
 * Segment operating profit less unallocated cost, as a waterfall.
 *
 * Every number is derived: the bars are `financialHistory[].segments[]`, the
 * subtotal is their sum, and the unallocated block is that sum minus the
 * period's operating profit. The composition of the unallocated block —
 * acquisition amortisation versus stock compensation — exists only in the
 * author's `cashEngine` prose, so it stays in the caption instead of being
 * regex-scraped into a number nobody can check.
 *
 * Returns null when segment operating profit is absent, which is the case for
 * every company whose ledger records segment revenue only.
 */
function CashEngineWaterfall({
  period,
  roster,
}: {
  period: Period;
  roster: Map<string, StructuredSnapshot["businessModel"]["segments"][number]>;
}) {
  const priced = (period.segments ?? []).filter((segment) => segment.operatingProfit);
  if (priced.length === 0 || !period.operatingMargin) return null;

  const unit = priced[0].operatingProfit as FinancialValue;
  const segmentSum = priced.reduce(
    (sum, segment) => sum + Number((segment.operatingProfit as FinancialValue).value),
    0,
  );
  const operatingProfit =
    (Number(period.revenue.value) * Number(period.operatingMargin.value)) / 100;
  const unallocated = segmentSum - operatingProfit;
  const digits = unit.precision;
  const show = (value: number) => value.toFixed(digits);

  const bars: WaterfallBar[] = [
    ...priced.map((segment) => {
      const value = Number((segment.operatingProfit as FinancialValue).value);
      return {
        key: segment.segmentId,
        label: roster.get(segment.segmentId)?.name ?? segment.segmentId,
        value,
        display: `${value >= 0 ? "+" : "−"}${show(Math.abs(value))}`,
        kind: "segment" as const,
      };
    }),
    { key: "segment-subtotal", label: "分部合计", value: segmentSum, display: show(segmentSum), kind: "total" },
    { key: "unallocated", label: "未分摊成本", value: -unallocated, display: `−${show(Math.abs(unallocated))}`, kind: "cost" },
    { key: "operating-profit", label: "经营利润", value: operatingProfit, display: show(operatingProfit), kind: "total" },
  ];

  // One shared scale so a negative segment reads as shorter-and-opposite rather
  // than merely shorter. AMD's data centre segment was −155 in 2025 Q2.
  const reach = Math.max(...bars.map((bar) => Math.abs(bar.value)), 1);
  const rowHeight = 26;
  const height = bars.length * rowHeight + 16;
  const axis = 168;
  const halfWidth = 132;

  return (
    <figure className="decision-chart cash-waterfall">
      <div className="chart-title">
        利润结构：分部利润扣除未分摊成本（{period.period}，{financialUnitLabel(unit)}）
      </div>
      <svg
        role="img"
        aria-label={`${period.period} 分部经营利润合计 ${show(segmentSum)}，扣除未分摊成本 ${show(Math.abs(unallocated))} 后为经营利润 ${show(operatingProfit)}`}
        viewBox={`0 0 340 ${height}`}
        style={{ height: `${height}px` }}
      >
        <title>{`${period.period} 现金引擎瀑布`}</title>
        {bars.map((bar, index) => {
          const y = 8 + index * rowHeight;
          const width = (Math.abs(bar.value) / reach) * halfWidth;
          return (
            <g key={bar.key}>
              <text x="0" y={y + 13} className="waterfall-label">{bar.label}</text>
              <rect
                x={bar.value >= 0 ? axis : axis - width}
                y={y + 3}
                width={Math.max(width, 0.6)}
                height="13"
                className={`waterfall-bar waterfall-bar--${bar.kind}`}
              />
              <text x="338" y={y + 13} textAnchor="end" className={`waterfall-value waterfall-value--${bar.kind}`}>
                {bar.display}
              </text>
            </g>
          );
        })}
        <line x1={axis} y1="8" x2={axis} y2={height - 8} className="waterfall-axis" />
      </svg>
    </figure>
  );
}

/**
 * The declared moats, each shown with the drivers that hold it up.
 *
 * Resolving `driverIds` to driver labels here is what makes the binding visible
 * to a reader rather than only to the checker: a moat whose supporting metric is
 * named, dated and thresholded reads differently from one that is asserted.
 */
function MoatBlock({
  snapshot,
  sourceIds,
}: {
  snapshot: StructuredSnapshot;
  sourceIds: (ids: string[]) => ReactNode;
}) {
  const moats = snapshot.businessModel.moat ?? [];
  if (moats.length === 0) {
    return (
      <>
        <h3 className="block-heading">护城河与转折点</h3>
        <p className="model-prose moat-absent">本次研究未声明护城河。</p>
      </>
    );
  }
  const drivers = new Map(snapshot.driverMetrics.map((metric) => [metric.id, metric]));

  return (
    <>
      <h3 className="block-heading">护城河与转折点</h3>
      <div className="moat-list">
        {moats.map((moat) => (
          <article className="moat-card" key={moat.id}>
            <div className="moat-head">
              <span className="moat-type">
                {moat.type}
                {moat.typeNote ? `——${moat.typeNote}` : ""}
              </span>
              <span className={`moat-trend moat-trend--${moat.trend}`}>{moat.trend}</span>
            </div>
            <p className="moat-mechanism">{moat.mechanism}</p>
            <dl>
              <div>
                <dt>支撑驱动</dt>
                <dd>
                  {moat.driverIds
                    .map((id) => {
                      const driver = drivers.get(id);
                      return driver ? `${driver.label}（${driver.displayValue}）` : id;
                    })
                    .join("、")}
                </dd>
              </div>
              <div>
                <dt>什么会摧毁它</dt>
                <dd className="cell-prose">{moat.breaker}</dd>
              </div>
            </dl>
            {sourceIds(moat.evidenceIds)}
          </article>
        ))}
      </div>
    </>
  );
}

export function BusinessModelSection({
  snapshot,
  sourceIds,
}: {
  snapshot: StructuredSnapshot;
  sourceIds: (ids: string[]) => ReactNode;
}) {
  const latest = snapshot.financialHistory.at(-1);
  const total = latest ? Number(latest.revenue.value) : 0;
  const roster = new Map(snapshot.businessModel.segments.map((segment) => [segment.id, segment]));
  // Below five links the ring reads as a polygon with big empty gaps, so those
  // chains keep the stepped flow on every viewport.
  const ringLinks = splitCausalChain(snapshot.businessModel.causalChain);

  return (
    <>
      <p className="lead">{snapshot.summary.businessModel}</p>
      <h3 className="block-heading">因果链</h3>
      {/* Two registers of the same text: the ring on a desktop screen, the
          stepped flow on phones and on paper, where the ring does not fit.
          CSS picks one — the other is `display:none`, so assistive technology
          and search engines see exactly one copy. */}
      {ringLinks.length >= 5 ? (
        <CausalChainRing links={ringLinks} companyName={snapshot.company.name} />
      ) : null}
      <CausalChainFlow chain={snapshot.businessModel.causalChain} />
      <h3 className="block-heading">交付依赖</h3>
      <ProseBlock className="model-prose" text={snapshot.businessModel.deliveryDependency} />
      <h3 className="block-heading">收入结构（{latest?.period ?? "最新期间"}）</h3>
      <div className="segment-list">
        {(latest?.segments ?? []).map((segment) => {
          const meta = roster.get(segment.segmentId);
          const value = segment.revenue ? Number(segment.revenue.value) : null;
          const share = value !== null && total > 0 ? (value / total) * 100 : null;
          return (
            <article className="segment-row" key={segment.segmentId}>
              <div className="segment-head">
                <strong>{meta?.name ?? segment.segmentId}</strong>
                <span className={`segment-role segment-role--${meta?.role ?? "辅助"}`}>
                  {meta?.role}
                </span>
                <em>{share !== null ? `${share.toFixed(1)}%` : "未披露"}</em>
              </div>
              {share !== null ? (
                <div className="segment-bar" role="presentation">
                  <span style={{ width: `${Math.min(100, share)}%` }} />
                </div>
              ) : null}
              <dl>
                <div><dt>付费者</dt><dd>{meta?.payer ?? "—"}</dd></div>
                <div><dt>收费方式</dt><dd>{meta?.chargingMode ?? "—"}</dd></div>
                <div>
                  <dt>本期收入</dt>
                  <dd>
                    {segment.status === "unavailable"
                      ? `未取证——${segment.reason ?? ""}`
                      : formatFinancialValue(segment.revenue)}
                  </dd>
                </div>
              </dl>
            </article>
          );
        })}
      </div>
      <MoatBlock snapshot={snapshot} sourceIds={sourceIds} />
      {latest ? <CashEngineWaterfall period={latest} roster={roster} /> : null}
      {/* The cash engine prose is the caption for the waterfall when there is
          one, and stands on its own when segment operating profit is missing. */}
      <h3 className="block-heading">利润与现金来源</h3>
      <ProseBlock className="model-prose" text={snapshot.businessModel.cashEngine} />
      {sourceIds(snapshot.businessModel.evidenceIds)}
    </>
  );
}

export function MarketPositionSection({
  snapshot,
  sourceIds,
}: {
  snapshot: StructuredSnapshot;
  sourceIds: (ids: string[]) => ReactNode;
}) {
  const { marketPosition } = snapshot;
  return (
    <>
      <div className="share-grid">
        {marketPosition.measures.map((measure) => (
          <article className="share-card" key={measure.basis}>
            <div className="share-head">
              <span>{measure.basis}份额</span>
              <span className={`trend trend--${measure.trend}`}>{measure.trend}</span>
            </div>
            <h3>
              {measure.label}
              <MetricNote
                id={`share-${measure.basis}`}
                title={measure.label}
                body={`市场定义：${measure.marketDefinition} 分母包含：${measure.denominatorIncludes.join("、")}。`}
                pitfall={
                  measure.denominatorExcludes.length > 0
                    ? `分母排除了 ${measure.denominatorExcludes
                        .map((item) => `${item.name}（${item.reason}）`)
                        .join("；")}`
                    : undefined
                }
              />
            </h3>
            <strong>
              {measure.status === "unavailable" ? "未取证" : measure.displayValue}
            </strong>
            <p className="share-rank">
              {measure.rank ? `${measure.rank} · ` : ""}
              截至 {measure.asOf}
            </p>
            {measure.status === "unavailable" ? <p className="share-reason">{measure.reason}</p> : null}
            <ul className="share-denominator">
              <li>分母：{measure.denominatorIncludes.join("、")}</li>
              {measure.denominatorExcludes.map((item) => (
                <li className="share-excluded" key={item.name}>
                  排除 {item.name}——{item.reason}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
      {marketPosition.divergence ? (
        <p className="divergence-callout">
          <strong>两口径背离</strong>
          {marketPosition.divergence}
        </p>
      ) : null}
      <h3 className="block-heading">主要竞争者</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>竞争者</th><th>份额</th><th>说明</th></tr>
          </thead>
          <tbody>
            {marketPosition.competitors.map((competitor) => (
              <tr key={competitor.name}>
                <th>{competitor.name}</th>
                <td>{competitor.share}</td>
                <td className="cell-prose">{competitor.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="concentration">{marketPosition.concentrationTrend}</p>
      {sourceIds(marketPosition.evidenceIds)}
    </>
  );
}

const PERIOD_TYPE_LABEL = {
  "fiscal-year": "年度",
  "half-year": "半年度",
  quarter: "季度",
} as const;

type PeriodType = keyof typeof PERIOD_TYPE_LABEL;

/** Reporting cadences this company actually discloses, in coarse-to-fine order. */
function availableCadences(periods: readonly Period[], minimum: number): PeriodType[] {
  return (["fiscal-year", "half-year", "quarter"] as PeriodType[]).filter(
    (type) => periodsOfType(periods, type).length >= minimum,
  );
}

/**
 * CSS-only tab group.
 *
 * Radio inputs and sibling selectors, no script. Which cadences exist is known
 * at build time, so a Hong Kong issuer simply never renders a quarterly tab
 * rather than showing an empty one.
 */
function CadenceTabs({
  group,
  cadences,
  render,
}: {
  group: string;
  cadences: PeriodType[];
  render: (cadence: PeriodType) => ReactNode;
}) {
  if (cadences.length === 0) {
    return <p className="empty-note">账本里还没有可比的报告期。</p>;
  }
  const missing = (["fiscal-year", "half-year", "quarter"] as PeriodType[]).filter(
    (type) => !cadences.includes(type),
  );
  return (
    <div className={`cadence-tabs cadence-tabs--${cadences.length}`}>
      {/* Naming the absent cadences matters: one lonely tab otherwise reads as
          a broken control rather than as data nobody has entered yet. */}
      {missing.length > 0 ? (
        <p className="cadence-missing">
          账本中尚无{missing.map((type) => PERIOD_TYPE_LABEL[type]).join("、")}口径的可比期间
          {missing.includes("quarter") ? "（港股发行人通常不披露季度数据）" : ""}。
        </p>
      ) : null}
      {cadences.map((cadence, index) => (
        <input
          key={cadence}
          type="radio"
          name={group}
          id={`${group}-${cadence}`}
          className={`cadence-input cadence-input--${index + 1}`}
          defaultChecked={index === 0}
        />
      ))}
      <nav className="cadence-nav" aria-label="报告期口径">
        {cadences.map((cadence, index) => (
          <label
            key={cadence}
            htmlFor={`${group}-${cadence}`}
            className={`cadence-label cadence-label--${index + 1}`}
          >
            {PERIOD_TYPE_LABEL[cadence]}
          </label>
        ))}
      </nav>
      {cadences.map((cadence, index) => (
        <div key={cadence} className={`cadence-panel cadence-panel--${index + 1}`}>
          <h4 className="cadence-panel-heading">{PERIOD_TYPE_LABEL[cadence]}口径</h4>
          {render(cadence)}
        </div>
      ))}
    </div>
  );
}

type Row = {
  key: string;
  label: string;
  metricId?: string;
  pick: (period: Period) => FinancialValue | undefined;
};

const CONSOLIDATED_ROWS: Row[] = [
  { key: "revenue", label: "收入", metricId: "revenue", pick: (period) => period.revenue },
  { key: "revenueGrowth", label: "收入增速", metricId: "revenue-growth", pick: (period) => period.revenueGrowth },
  { key: "grossMargin", label: "毛利率", metricId: "gross-margin", pick: (period) => period.grossMargin },
  { key: "operatingMargin", label: "经营利润率", metricId: "operating-margin", pick: (period) => period.operatingMargin },
  { key: "netProfit", label: "净利润", metricId: "net-profit", pick: (period) => period.netProfit },
  { key: "operatingCashFlow", label: "经营现金流", metricId: "operating-cash-flow", pick: (period) => period.operatingCashFlow },
  { key: "freeCashFlow", label: "近似自由现金流", metricId: "free-cash-flow", pick: (period) => period.freeCashFlow },
];

function changeCell(prior?: FinancialValue, current?: FinancialValue): string {
  if (!prior || !current) return "不可比";
  const before = Number(prior.value);
  const after = Number(current.value);
  if (current.unit === "percent" || current.unit === "percentage-point") {
    const delta = after - before;
    return `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pp`;
  }
  if (before === 0) return "不可比";
  const delta = (after / before - 1) * 100;
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
}

function segmentShare(period: Period, segmentId: string): string {
  const segment = period.segments?.find((item) => item.segmentId === segmentId);
  if (!segment || segment.status === "unavailable" || !segment.revenue) return "未取证";
  const total = Number(period.revenue.value);
  if (total === 0) return "—";
  return `${((Number(segment.revenue.value) / total) * 100).toFixed(1)}%`;
}

function periodHeading(period: Period): ReactNode {
  return (
    <>
      {period.period}
      {period.status === "calculated" ? <small className="period-derived">推算</small> : null}
    </>
  );
}

/**
 * The company page's financial block: two same-basis columns and the change.
 *
 * Year on year rather than the two most recently published filings. For a Hong
 * Kong issuer those two are the annual report and the interim — one covering
 * twice the span of the other — and putting them side by side manufactures a
 * collapse out of nothing but period length.
 */
export function LatestComparison({
  snapshot,
  sourceIds,
}: {
  snapshot: StructuredSnapshot;
  sourceIds: (ids: string[]) => ReactNode;
}) {
  const roster = new Map(snapshot.businessModel.segments.map((segment) => [segment.id, segment]));
  const cadences = availableCadences(snapshot.financialHistory, 2).filter(
    (cadence) => yearOnYearPair(snapshot.financialHistory, cadence) !== null,
  );

  return (
    <CadenceTabs group="latest-comparison" cadences={cadences} render={(cadence) => {
      const pair = yearOnYearPair(snapshot.financialHistory, cadence);
      if (!pair) return <p className="empty-note">该口径下还没有可同比的两期。</p>;
      const { prior, current } = pair;
      return (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>科目</th>
                <th>{periodHeading(prior)}</th>
                <th>{periodHeading(current)}</th>
                <th>同比变化</th>
              </tr>
            </thead>
            <tbody>
              {CONSOLIDATED_ROWS.map((row) => {
                const before = row.pick(prior);
                const after = row.pick(current);
                if (!before && !after) return null;
                return (
                  <tr key={row.key}>
                    <th>
                      {row.label}
                      {row.metricId ? (
                        <StandardMetricNote metricId={row.metricId} scope={`cmp-${cadence}`} />
                      ) : null}
                    </th>
                    <td>{formatFinancialValue(before)}</td>
                    <td>{formatFinancialValue(after)}</td>
                    <td className="cell-change">{changeCell(before, after)}</td>
                  </tr>
                );
              })}
              {snapshot.businessModel.segments.map((segment) => (
                <tr className="row-segment" key={segment.id}>
                  <th>
                    <span className="segment-indent">{roster.get(segment.id)?.name ?? segment.id}占比</span>
                  </th>
                  <td>{segmentShare(prior, segment.id)}</td>
                  <td>{segmentShare(current, segment.id)}</td>
                  <td className="cell-change">—</td>
                </tr>
              ))}
            </tbody>
          </table>
          {sourceIds([...new Set([...prior.evidenceIds, ...current.evidenceIds])])}
        </div>
      );
    }} />
  );
}

/** The report page's fuller table: every period of a cadence within two years. */
export function PeriodHistoryTable({
  snapshot,
  years = 2,
  sourceIds,
}: {
  snapshot: StructuredSnapshot;
  years?: number;
  sourceIds: (ids: string[]) => ReactNode;
}) {
  const roster = new Map(snapshot.businessModel.segments.map((segment) => [segment.id, segment]));
  const perYear = { "fiscal-year": 1, "half-year": 2, quarter: 4 } as const;
  const cadences = availableCadences(snapshot.financialHistory, 2);

  return (
    <CadenceTabs group="period-history" cadences={cadences} render={(cadence) => {
      const periods = periodsOfType(
        snapshot.financialHistory,
        cadence,
        years * perYear[cadence],
      );
      return (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>科目</th>
                {periods.map((period) => <th key={period.period}>{periodHeading(period)}</th>)}
              </tr>
            </thead>
            <tbody>
              {CONSOLIDATED_ROWS.map((row) => (
                <tr key={row.key}>
                  <th>
                    {row.label}
                    {row.metricId ? (
                      <StandardMetricNote metricId={row.metricId} scope={`hist-${cadence}`} />
                    ) : null}
                  </th>
                  {periods.map((period) => (
                    <td key={period.period}>{formatFinancialValue(row.pick(period))}</td>
                  ))}
                </tr>
              ))}
              {snapshot.businessModel.segments.map((segment) => (
                <tr className="row-segment" key={segment.id}>
                  <th>
                    <span className="segment-indent">{roster.get(segment.id)?.name ?? segment.id}占比</span>
                  </th>
                  {periods.map((period) => (
                    <td key={period.period}>{segmentShare(period, segment.id)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {sourceIds([...new Set(periods.flatMap((period) => period.evidenceIds))])}
        </div>
      );
    }} />
  );
}

/**
 * The value bridge: where each unit of value comes from, and what is taken back
 * out again, against the price you can actually pay today.
 */
/**
 * Every attributed assumption set, side by side, each solved against today's price.
 *
 * Deliberately not a verdict. A seat shows whose numbers it uses, what that
 * source's lean is, what its own component range multiplies out to, and what
 * multiple the current price implies on the same metric. Two of those four are
 * arithmetic and the other two are citations, so a reader comparing them is
 * comparing published numbers rather than being walked to a conclusion.
 *
 * Seats keep the order the snapshot declares. No seat is marked primary, because
 * marking one would reintroduce the "基准" the previous contract had — a private
 * forecast wearing the word "base".
 */
export function AssumptionSetPanel({ snapshot }: { snapshot: CurrentSnapshot }) {
  const currency = snapshot.valuation.tradingCurrency;
  const price = snapshot.summary.referencePrice.value;

  return (
    <div className="assumption-sets">
      <p className="assumption-sets-note">
        每一组假设都署名到本仓库以外的来源，并标出该来源的已知偏向。区间由引擎从组件算出，
        「价格隐含」是把当前价 {formatPrice(price, currency)} 反解到同一个指标上的结果。
        没有哪一组被标为基准。
      </p>
      {snapshot.valuation.assumptionSets.map((set) => (
        <article className="assumption-set" key={set.id}>
          <div className="assumption-set-head">
            <span className="assumption-set-kind">{set.sourceKind}</span>
            <strong>{set.sourceLabel}</strong>
          </div>
          {/* The bias sits above the numbers, not in a footnote: a short
              report and an issuer's guidance render identically otherwise. */}
          <p className="assumption-set-bias">
            <span>来源偏向</span>
            {set.sourceBias}
          </p>
          {set.status === "unavailable" || !set.computed ? (
            <p className="assumption-set-missing">
              本次未取到：{set.reason}
            </p>
          ) : (
            <>
              <dl className="assumption-set-facts">
                <div>
                  <dt>该组假设对应</dt>
                  <dd>
                    {formatPrice(set.computed.low, currency)}–{set.computed.high}
                    <small>中枢 {set.computed.center}</small>
                  </dd>
                </div>
                <div>
                  <dt>当前价格隐含</dt>
                  <dd>
                    {set.impliedExpectation?.multipleLow === null ||
                    set.impliedExpectation === undefined ? (
                      "组件不止一项倍数项，无法反解出单一倍数"
                    ) : (
                      <>
                        {set.impliedExpectation.multipleLow}×–
                        {set.impliedExpectation.multipleHigh}×
                        <small>作用在{set.impliedExpectation.metricLabel}上</small>
                      </>
                    )}
                  </dd>
                </div>
              </dl>
              <p className="assumption-set-assumptions">{set.assumptions}</p>
              <ul className="assumption-set-components">
                {(set.components ?? []).map((component) => (
                  <li key={component.id}>
                    <span>{component.kind === "multiple" ? "倍数项" : "面值项"}</span>
                    {component.kind === "multiple"
                      ? `${component.metricLabel} ${component.metricLow}–${component.metricHigh} × ${component.multipleLow}–${component.multipleHigh}x`
                      : `${component.amount}${component.discountPct ? `（折价 ${component.discountPct}%）` : ""}`}
                  </li>
                ))}
              </ul>
            </>
          )}
        </article>
      ))}
    </div>
  );
}

/**
 * Where the price and one named source part company, on one observable.
 *
 * Both columns are someone else's number. The row that matters is the last one:
 * which link of the causal chain the two readings diverge at, because that is
 * what the next filing can settle.
 */
export function DisagreementPanel({ snapshot }: { snapshot: CurrentSnapshot }) {
  const { disagreement, assumptionSets } = snapshot.valuation;
  if (!disagreement) return null;
  const against = assumptionSets.find((set) => set.id === disagreement.assumptionSetId);

  return (
    <div className="disagreement">
      <p className="disagreement-anchor">
        锚定驱动 <strong>{disagreement.driverId}</strong>
        {against ? <span>对照 {against.sourceLabel}</span> : null}
      </p>
      <dl>
        <div>
          <dt>当前价格隐含</dt>
          <dd>{disagreement.marketAssumption}</dd>
        </div>
        <div>
          <dt>该来源假设</dt>
          <dd>{disagreement.referenceAssumption}</dd>
        </div>
        <div>
          <dt>分歧落在因果链哪一环</dt>
          <dd>{disagreement.divergenceLink}</dd>
        </div>
      </dl>
      {disagreement.converged ? (
        <p className="disagreement-converged">
          两者几乎重合：当前价格与该来源的假设指向同一条路径。
        </p>
      ) : null}
    </div>
  );
}

export function FrozenValueBridge({ snapshot }: { snapshot: FrozenSnapshot }) {
  const base = snapshot.valuation.scenarios.find((scenario) => scenario.name === "基准");
  if (!base) return null;

  const price = Number(snapshot.summary.referencePrice.value);
  const currency = snapshot.valuation.tradingCurrency;
  const mid = (entry: { perShareLow: string; perShareHigh: string }) =>
    (Number(entry.perShareLow) + Number(entry.perShareHigh)) / 2;

  const total = Number(base.computed.center);
  const span = Math.max(total, price, ...base.computed.bridge.map((entry) => Math.abs(mid(entry))));
  const scale = (value: number) => (Math.abs(value) / (span || 1)) * 100;

  let running = 0;
  const bars = base.computed.bridge.map((entry) => {
    const delta = mid(entry);
    const start = delta >= 0 ? running : running + delta;
    running += delta;
    return { entry, delta, start, end: running };
  });

  return (
    <figure className="value-bridge">
      <figcaption className="chart-title">
        价值构成（基准情景，{currency} / 股）
      </figcaption>
      <ol className="bridge-rows">
        {bars.map(({ entry, delta, start }) => (
          <li key={entry.id}>
            <span className="bridge-label">
              {delta < 0 ? "− " : bars[0].entry.id === entry.id ? "" : "+ "}
              {entry.label}
            </span>
            <span className="bridge-track">
              <span
                className={`bridge-bar bridge-bar--${delta < 0 ? "cut" : entry.kind}`}
                style={{ marginInlineStart: `${scale(start)}%`, width: `${Math.max(0.6, scale(delta))}%` }}
              />
            </span>
            <span className="bridge-value">
              {delta >= 0 ? "" : "−"}
              {Math.abs(delta).toFixed(1)}
            </span>
          </li>
        ))}
        <li className="bridge-total">
          <span className="bridge-label">= 合理价值中枢</span>
          <span className="bridge-track">
            <span className="bridge-bar bridge-bar--total" style={{ width: `${scale(total)}%` }} />
          </span>
          <span className="bridge-value">{base.computed.center}</span>
        </li>
        <li className="bridge-price">
          <span className="bridge-label">当前价格</span>
          <span className="bridge-track">
            <span className="bridge-marker" style={{ insetInlineStart: `${scale(price)}%` }} />
          </span>
          <span className="bridge-value">{price.toFixed(1)}</span>
        </li>
      </ol>
      <p className="bridge-range">
        基准区间 {formatPrice(base.computed.low, currency)}–{base.computed.high}
        （熊市 {snapshot.valuation.scenarios.find((item) => item.name === "熊市")?.computed.low}–
        {snapshot.valuation.scenarios.find((item) => item.name === "熊市")?.computed.high}
        ，牛市 {snapshot.valuation.scenarios.find((item) => item.name === "牛市")?.computed.low}–
        {snapshot.valuation.scenarios.find((item) => item.name === "牛市")?.computed.high}）
      </p>
    </figure>
  );
}

/**
 * What management said and what it did with the money, across dates.
 *
 * Counts and the outstanding list, never a delivery grade: the denominator
 * depends on which promises were recorded, so a grade would be improvable by
 * writing down fewer soft ones. Buyback rows carry the valuation they were
 * executed at, which is what turns "bought back while expensive" from an
 * impression into something a reader can check against today's value range.
 */
export function CommitmentPanel({ snapshot }: { snapshot: StructuredSnapshot }) {
  const summary = snapshot.commitmentSummary;
  if (!summary) return null;
  const { counts, outstanding, latestResolution, capitalAllocation } = summary;
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);

  return (
    <div className="commitment-panel">
      <p className="company-note">
        覆盖自 {summary.coverageFrom}，共 {total} 条记录。只呈现计数与未结清清单，不给兑现率档位——
        分母取决于录入了哪些承诺，档位会让一个可被挑选操纵的数字看起来像评级。
      </p>
      <div className="commitment-counts">
        {(Object.entries(counts) as Array<[string, number]>).map(([status, count]) => (
          <article key={status}>
            <span>{status}</span>
            <strong>{count}</strong>
          </article>
        ))}
      </div>
      {total === 0 ? (
        <p className="density-clear">台账为空：这段时间没有可判定的承诺，而不是没有查。</p>
      ) : null}

      {outstanding.length > 0 ? (
        <>
          <h4 className="block-heading">未结清</h4>
          <ul className="commitment-outstanding">
            {outstanding.map((entry) => (
              <li key={entry.id}>
                <span className={`commitment-status commitment-status--${entry.status}`}>{entry.status}</span>
                <strong>{entry.commitment}</strong>
                <em>到期：{entry.dueBy}</em>
              </li>
            ))}
          </ul>
        </>
      ) : total > 0 ? (
        <p className="density-clear">没有未兑现或部分兑现的承诺。</p>
      ) : null}

      {latestResolution ? (
        <p className="commitment-latest">
          最近一次结算：{latestResolution.resolvedAt} · {latestResolution.status} ·{" "}
          {latestResolution.commitment}
        </p>
      ) : null}

      {capitalAllocation.length > 0 ? (
        <>
          <h4 className="block-heading">资本配置逐笔</h4>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>时间</th><th>类型</th><th>内容</th><th>金额</th><th>当时估值</th><th>事后评估</th></tr>
              </thead>
              <tbody>
                {capitalAllocation.map((entry) => (
                  <tr key={entry.id}>
                    <th>{entry.statedAt}</th>
                    <td>{entry.kind}</td>
                    <td className="cell-prose">{entry.commitment}</td>
                    <td>{entry.amount ? formatFinancialValue(entry.amount) : "—"}</td>
                    <td className="cell-prose">{entry.valuationAtTime ?? "—"}</td>
                    <td className="cell-prose">{entry.returnAssessment ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * How much of this research rests on missing values and inference.
 *
 * Rendered even when nothing fires: "0 条规则被触发" is the useful reading, and a
 * block that only appears on weak research would let a reader mistake its
 * absence for a page that simply does not report density.
 */
export function EvidenceDensityPanel({ snapshot }: { snapshot: StructuredSnapshot }) {
  const block = snapshot.evidenceDensity;
  if (!block) return null;
  const { computed, responses } = block;
  const pct = (value: string) => `${(Number(value) * 100).toFixed(1)}%`;
  const rows = [
    { label: "缺失值占比", value: pct(computed.unavailableShare), note: "标准指标、驱动与份额口径中 unavailable 的比例" },
    { label: "推断类证据占比", value: pct(computed.inferenceShare), note: "evidence 中 kind 为 inference 的比例" },
    { label: "低置信度驱动", value: pct(computed.lowConfidenceDriverShare), note: "置信度为「低」的驱动比例" },
    { label: "只靠推断支撑的驱动", value: pct(computed.unsupportedDriverShare), note: "所引用证据全为 inference 的驱动比例" },
  ];

  return (
    <div className="evidence-density">
      <p className="company-note">
        由引擎从本份快照自身统计，作者不得手写。它标出结论有多少建立在缺失值与推断之上，
        但不阻断发布——证据稀薄有时是被研究对象的事实。
      </p>
      <div className="density-grid">
        {rows.map((row) => (
          <article key={row.label}>
            <span>{row.label}</span>
            <strong>{row.value}</strong>
            <small>{row.note}</small>
          </article>
        ))}
      </div>
      {computed.idealMethodBlocked ? (
        <p className="density-method">理想估值方法与实际采用的主方法不同，缺口见上方「补齐以下数据」清单。</p>
      ) : null}
      {responses.length === 0 ? (
        <p className="density-clear">没有证据密度规则被触发。</p>
      ) : (
        <ul className="density-responses">
          {responses.map((entry) => (
            <li key={entry.ruleId}>
              <span className={`health-response health-response--${entry.response}`}>{entry.response}</span>
              <strong>{entry.observed}</strong>
              <span>{entry.note}</span>
              {(entry.blockedBy ?? []).length > 0 ? (
                <ol className="density-blocked">
                  {(entry.blockedBy ?? []).map((gap) => (
                    <li key={gap.dataItem}>
                      <strong>{gap.dataItem}</strong>
                      <span>{gap.whyNeeded}</span>
                      <em>取自：{gap.whereToGet}</em>
                    </li>
                  ))}
                </ol>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Which method this company's accounting admits, and what would let it improve.
 *
 * Under 1.2.0 the reverse valuation and the disagreement have moved out of here:
 * the price implication is computed once per attributed seat and belongs beside
 * the seat, and the disagreement gets its own block. What is left is all method —
 * which is a fact about the company's disclosures, not a view about its price.
 */
export function ValuationMethodPanel({ snapshot }: { snapshot: StructuredSnapshot }) {
  const { methodSelection, healthCheck } = snapshot.valuation;
  const frozen = isCurrentSnapshot(snapshot) ? null : snapshot;
  const ideal = lookupValuationMethod(methodSelection.ideal);
  const adopted = lookupValuationMethod(methodSelection.adoptedPrimary);
  const frozenDisagreement = frozen?.valuation.disagreement;
  const disagreementDriver = frozenDisagreement
    ? snapshot.driverMetrics.find((metric) => metric.id === frozenDisagreement.driverId)
    : undefined;

  return (
    <div className="valuation-method">
      <div className="method-pair">
        <article>
          <span>本次采用</span>
          <strong>
            {adopted?.label ?? methodSelection.adoptedPrimary}
            <MetricNote
              id="method-adopted"
              title={adopted?.label ?? methodSelection.adoptedPrimary}
              body={`适用于：${adopted?.bestFor ?? ""} 必需输入：${adopted?.requires.join("、") ?? ""}。`}
              pitfall={adopted?.pitfall}
            />
          </strong>
          <p>{methodSelection.adoptedRationale}</p>
        </article>
        <article className={methodSelection.ideal === methodSelection.adoptedPrimary ? "" : "method-ideal"}>
          <span>更理想的方法</span>
          <strong>
            {ideal?.label ?? methodSelection.ideal}
            <MetricNote
              id="method-ideal"
              title={ideal?.label ?? methodSelection.ideal}
              body={`适用于：${ideal?.bestFor ?? ""} 必需输入：${ideal?.requires.join("、") ?? ""}。`}
              pitfall={ideal?.pitfall}
            />
          </strong>
          <p>{methodSelection.idealRationale}</p>
        </article>
      </div>

      {frozen ? (
        <p className="implied-line">
          <strong>反向估值</strong>
          当前价隐含
          {frozen.valuation.impliedExpectation.multipleLow &&
          frozen.valuation.impliedExpectation.multipleHigh
            ? ` ${frozen.valuation.impliedExpectation.multipleLow}x–${frozen.valuation.impliedExpectation.multipleHigh}x（${frozen.valuation.impliedExpectation.metricLabel}）`
            : "（基准情景含多个估值组件，无法解出单一倍数）"}
          。{frozen.valuation.currentExpectation}
        </p>
      ) : null}

      {frozenDisagreement ? (
        <div className={`disagreement${frozenDisagreement.converged ? " disagreement--converged" : ""}`}>
          <h4>
            {frozenDisagreement.converged ? "与市场没有实质分歧" : "分歧点"}
            <span className="disagreement-driver">
              {disagreementDriver?.label ?? frozenDisagreement.driverId}
              {disagreementDriver ? ` · ${disagreementDriver.displayValue}` : ""}
            </span>
          </h4>
          <dl>
            <div><dt>市场假设</dt><dd className="cell-prose">{frozenDisagreement.marketAssumption}</dd></div>
            <div><dt>我的假设</dt><dd className="cell-prose">{frozenDisagreement.ourAssumption}</dd></div>
            <div>
              <dt>{frozenDisagreement.converged ? "这意味着什么" : "如果市场对了"}</dt>
              <dd className="cell-prose">{frozenDisagreement.ifMarketIsRight}</dd>
            </div>
          </dl>
        </div>
      ) : null}

      {methodSelection.blockedBy.length > 0 ? (
        <div className="upgrade-hint">
          <h4>补齐以下数据可以把估值升级为「{ideal?.label ?? methodSelection.ideal}」</h4>
          <ol>
            {methodSelection.blockedBy.map((item) => (
              <li key={item.dataItem}>
                <strong>{item.dataItem}</strong>
                <span>{item.whyNeeded}</span>
                <em>取自：{item.whereToGet}</em>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {healthCheck.length > 0 ? (
        <details className="health-check">
          <summary>估值方法体检：{healthCheck.length} 条规则被触发</summary>
          <ul>
            {healthCheck.map((entry) => (
              <li key={entry.ruleId}>
                <span className={`health-response health-response--${entry.response}`}>
                  {entry.response}
                </span>
                <strong>{entry.observed}</strong>
                <span>{entry.note}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <h4 className="block-heading">交叉验证</h4>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>方法</th><th>结果</th><th>关键假设</th><th>与主方法的差异</th></tr>
          </thead>
          <tbody>
            {methodSelection.crossChecks.map((check) => {
              const method = lookupValuationMethod(check.methodId);
              return (
                <tr key={check.methodId}>
                  <th>{method?.label ?? check.methodId}</th>
                  <td>{formatPrice(check.valueLow, snapshot.valuation.tradingCurrency)}–{check.valueHigh}</td>
                  <td className="cell-prose">{check.keyAssumptions}</td>
                  <td className="cell-prose">{check.note}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
