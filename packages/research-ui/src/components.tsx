import type { CSSProperties, ReactNode } from "react";
import {
  lookupStandardMetric,
  lookupValuationMethod,
  periodsOfType,
  yearOnYearPair,
  type ResearchSnapshot,
} from "@airesearch/research-schema";

type CurrentSnapshot = Extract<ResearchSnapshot, { schemaVersion: "1.1.0" }>;
type Period = CurrentSnapshot["financialHistory"][number];
type FinancialValue = Period["revenue"];

export function formatPrice(value: string, currency: string) {
  return `${currency === "HKD" ? "HK$" : `${currency} `}${value}`;
}

export function formatFinancialValue(value?: FinancialValue) {
  if (!value) return "未披露";
  if (value.unit === "percent") return `${value.value}%`;
  if (value.unit === "percentage-point") return `${value.value} 个百分点`;
  if (value.unit === "currency") {
    const currency = value.currency === "CNY" ? "人民币" : value.currency;
    const scale = value.scale === "hundred-million"
      ? "亿元"
      : value.scale === "million"
        ? "百万元"
        : "元";
    return `${value.value} ${currency}${scale}`;
  }
  return value.value;
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

export function BusinessModelSection({
  snapshot,
  sourceIds,
}: {
  snapshot: CurrentSnapshot;
  sourceIds: (ids: string[]) => ReactNode;
}) {
  const latest = snapshot.financialHistory.at(-1);
  const total = latest ? Number(latest.revenue.value) : 0;
  const roster = new Map(snapshot.businessModel.segments.map((segment) => [segment.id, segment]));

  return (
    <>
      <p className="lead">{snapshot.summary.businessModel}</p>
      <div className="model-grid">
        <article>
          <span>因果链</span>
          <p>{snapshot.businessModel.causalChain}</p>
        </article>
        <article>
          <span>利润与现金来源</span>
          <p>{snapshot.businessModel.cashEngine}</p>
        </article>
        <article>
          <span>交付依赖</span>
          <p>{snapshot.businessModel.deliveryDependency}</p>
        </article>
      </div>
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
      {sourceIds(snapshot.businessModel.evidenceIds)}
    </>
  );
}

export function MarketPositionSection({
  snapshot,
  sourceIds,
}: {
  snapshot: CurrentSnapshot;
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
  snapshot: CurrentSnapshot;
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
  snapshot: CurrentSnapshot;
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
export function ValueBridge({ snapshot }: { snapshot: CurrentSnapshot }) {
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

/** What the current price already assumes, plus what would sharpen the estimate. */
export function ValuationMethodPanel({ snapshot }: { snapshot: CurrentSnapshot }) {
  const { methodSelection, impliedExpectation, healthCheck } = snapshot.valuation;
  const ideal = lookupValuationMethod(methodSelection.ideal);
  const adopted = lookupValuationMethod(methodSelection.adoptedPrimary);

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

      <p className="implied-line">
        <strong>反向估值</strong>
        当前价隐含
        {impliedExpectation.multipleLow && impliedExpectation.multipleHigh
          ? ` ${impliedExpectation.multipleLow}x–${impliedExpectation.multipleHigh}x（${impliedExpectation.metricLabel}）`
          : "（基准情景含多个估值组件，无法解出单一倍数）"}
        。{snapshot.valuation.currentExpectation}
      </p>

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
