import type { Metadata } from "next";
import { isValidElement, type ReactNode } from "react";
import { existsSync } from "node:fs";
import { finalPath, listFinalCompanies, loadFinal } from "../../../lib/final-report";
import { headline, isUnavailable, pctText, stripNote, text, type Json } from "../../../lib/field-text";

/**
 * 公司分析页 — 研究流程第 5 步（docs/research/workflow/05-render-site.md）。
 *
 * 输入是 build_final.py 合并三份校验通过文件后生成的
 * research/companies/<company>/financials-final.json（financials—final-template.json 契约）。
 * 校验闸门在合并脚本里，本页只负责渲染：字段缺失或 unavailable 时如实显示原因，
 * 不用 0 或空字符串代替。
 *
 * 阅读层级原则：结论与数字一眼可读；溯源件（打分依据、依据字段路径、证据清单、
 * 缺口）默认折叠（.fold），点开才展开——它们保证可复核，但不该淹没正文。
 */

export const dynamicParams = false;

/**
 * output: export 不接受空的静态参数表，所以没有任何公司有 financials-final.json 时
 * 用一个哨兵参数占位；copy-output.mjs 在拷贝阶段删除哨兵页，不会进入 research/site。
 */
const PLACEHOLDER_COMPANY = "__no-analysis__";

export function generateStaticParams() {
  const companies = listFinalCompanies().map((company) => ({ company }));
  return companies.length > 0 ? companies : [{ company: PLACEHOLDER_COMPANY }];
}

type AnalysisPageProps = { params: Promise<{ company: string }> };

/**
 * 摘要条的一格：数值 + 副行说明。取不到数值时正文位给短标签（未取得 / 不适用），
 * 副行让位给缺失原因——页头的三格是这一页最先被读到的地方，只给一个破折号
 * 等于既不给数也不给因。
 */
function SummaryCell({ label, field, note }: { label: string; field: Json; note?: ReactNode }) {
  const cell = headline(field);
  return (
    <div>
      <span>{label}</span>
      <strong title={cell.title}>{cell.value}</strong>
      {cell.note ?? note ? <small title={cell.title}>{cell.note ?? note}</small> : null}
    </div>
  );
}

/**
 * 分点断行：分析文件里的长字段按「① ② ③」（或 `1)`、换行）分点书写
 * （见 docs/research/workflow/02-multi-dimension-analysis.md），这里按点切开，
 * 每点独占一行——否则序号会糊在同一段里，分点等于没分。
 * 只切出 1 段时按普通文本渲染，不加行结构。
 *
 * `1)` 形式必须紧跟句末标点，且序号后不能再接数字：否则「任期 11.8 年」这类
 * 句首小数会被当成列表序号，把一句话劈成两行。
 */
const POINT_BOUNDARY = /\s*(?:\n+|(?=[①-⑳])|(?<=[。；;])\s*(?=\d{1,2}[.)）](?!\d)))/;

function splitPoints(raw: string): string[] {
  const parts = raw.split(POINT_BOUNDARY).map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [];
}

/** 分点内容（不含块级包装，可直接放进 dd / p / li）。 */
function Points({ value }: { value: Json }) {
  const raw = text(value);
  const points = splitPoints(raw);
  if (points.length === 0) return <>{raw}</>;
  return (
    <>
      {points.map((point, index) => (
        <span className="prose-point" key={index}>{point}</span>
      ))}
    </>
  );
}

/** 段落形态的分点叙述。 */
function Prose({ value, className }: { value: Json; className?: string }) {
  return <p className={className}><Points value={value} /></p>;
}

const CJK = /[　-〿㐀-鿿＀-￯]/;

/**
 * 页头标题的排版分档。CSS 量不到字符数，只能在渲染时算好交给样式表。
 *
 * `cjk`：汉字字形填满整个 em 方框，页头 `line-height: .82` 那种收紧的编辑式行距在
 * 拉丁标题上成立（字母有升部降部，行框里留得出空隙），中文标题一折行就会物理重叠。
 *
 * `scale`：按视觉宽度（汉字记 2、拉丁记 1）分三档，让长短不一的公司名落在相近的
 * 视觉体量上——目标是最多两行，而不是让「中国平安保险(集团)股份有限公司」这种
 * 三行标题吃掉整屏。当前五家公司的宽度落在 22–30。
 */
function titleTypography(name: string): { cjk: string; scale: string } {
  const width = [...name].reduce((sum, ch) => sum + (CJK.test(ch) ? 2 : 1), 0);
  return {
    cjk: String(CJK.test(name)),
    scale: width >= 27 ? "sm" : width >= 21 ? "md" : "lg",
  };
}

/** 双源校验对象的误差标记。 */
function flagMark(value: Json): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  if (value.flag === "ok") return " ✅";
  if (value.flag === "minor-diff") return " ⚠️";
  if (value.flag === "major-diff") return " ❌";
  return "";
}

/**
 * 来源渲染为不带名称的可点击标记：页面只留一枚「来源」小胶囊，名称与时点收进
 * title 提示（悬停可见），完整出处永远在 JSON 数据文件里——简洁但不丢可追溯性。
 * 没有可点击 URL 的来源不渲染标记（纯名称对读者没有信息量）。
 */
function SourceLink({ source }: { source: Json }) {
  if (!source?.url || source.url === "unavailable") return null;
  const tooltip = [source.name, source.asOf].filter(Boolean).join(" · ");
  return (
    <a className="source-pill" href={source.url} rel="noreferrer" title={tooltip}>来源</a>
  );
}

/** 折叠溯源块：正文只留摘要行，展开才见全文。 */
function Fold({ label, children }: { label: string; children: Json }) {
  return (
    <details className="fold">
      <summary>{label}</summary>
      {children}
    </details>
  );
}

function EvidenceFold({ items, label }: { items: Json; label?: string }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <Fold label={`${label ?? "证据"} ${items.length} 条`}>
      <ul>
        {items.map((item: Json, index: number) => (
          <li key={index}>
            {text(item.metric)}：{text(item.value)}
            {item.asOf ? `（${text(item.asOf)}）` : null}{" "}
            <SourceLink source={item.source} />
          </li>
        ))}
      </ul>
    </Fold>
  );
}

function Inquiry({ inquiry }: { inquiry: Json }) {
  if (!inquiry?.question) return null;
  return (
    <aside className="inquiry-block">
      <p className="q">追问 · {inquiry.question}</p>
      <Prose className="a" value={inquiry.answer} />
    </aside>
  );
}

function DataGaps({ gaps }: { gaps: Json }) {
  if (!Array.isArray(gaps) || gaps.length === 0) return null;
  return (
    <Fold label={`数据缺口 ${gaps.length} 项`}>
      <ul>
        {gaps.map((gap: Json, index: number) => (
          <li key={index}>
            {/* 缺口条目历史上有 item / field 两种键名，两种都认，否则整条只剩「—」 */}
            {typeof gap === "string" ? gap : `${text(gap.item ?? gap.field ?? gap.path)}——${text(gap.reason)}`}
          </li>
        ))}
      </ul>
    </Fold>
  );
}

function Section({ id, kicker, title, children }: {
  id: string; kicker: string; title: string; children: Json;
}) {
  return (
    <section className="company-section" aria-labelledby={id}>
      <p className="section-kicker">{kicker}</p>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

/**
 * 键值行：承载长文本的 dt/dd（四列窄栏放长段会变成高塔，改用全宽行）。
 * 值可以直接给原始字段（对象、unavailable 占位都交给 Points → text 处理），
 * 也可以给已经拼好的 JSX。
 */
function KvList({ rows }: { rows: [string, Json][] }) {
  return (
    <dl className="kv-list">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{isValidElement(value) ? value : <Points value={value} />}</dd>
        </div>
      ))}
    </dl>
  );
}

export async function generateMetadata({ params }: AnalysisPageProps): Promise<Metadata> {
  const route = await params;
  if (!existsSync(finalPath(route.company))) return {};
  const final = loadFinal(route.company);
  return {
    title: `${final.meta?.companyName ?? route.company}分析报告`,
    other: { "research-final-version": final.finalVersion ?? "" },
  };
}

export default async function AnalysisPage({ params }: AnalysisPageProps) {
  const route = await params;
  if (!existsSync(finalPath(route.company))) {
    // 哨兵路由（或文件被移除）：输出占位页，copy-output.mjs 不会把它带进 research/site。
    return <main className="company-page"><p>暂无分析报告。</p></main>;
  }
  const final = loadFinal(route.company);
  const collection = final.collection ?? {};
  const analysis = final.analysis ?? {};
  const summary = final.summary ?? {};
  const dims = analysis.dimensions ?? {};
  const valuation = collection.currentValuation ?? {};
  const scores = final.meta?.validation?.scores ?? {};
  const essence = dims.businessEssence ?? {};
  /**
   * 收入结构表的金额单位：分析文件用 revenueBreakdown.unit 显式声明（如「亿元」），
   * 未声明时退回报告币种的百万口径——否则跨市场公司会被标上错误币种。
   */
  const revenueUnitLabel = essence.analysis?.revenueBreakdown?.unit
    ?? `百万 ${collection.meta?.reportingCurrency ?? "USD"}`;
  const moat = dims.moat ?? {};
  const inversion = dims.inversion ?? {};
  const management = dims.management ?? {};
  const industry = dims.industryTrend ?? {};
  const dimValuation = dims.valuation ?? {};
  const strategies = summary.strategies ?? {};
  const scenario = dimValuation.analysis?.threeScenario ?? {};
  const peers = (dimValuation.analysis?.vsPeers ?? []) as Json[];
  const peerRows = peers.filter((peer: Json) => peer.name !== "对比结论");
  const peerVerdict = peers.find((peer: Json) => peer.name === "对比结论");
  const companyName = final.meta?.companyName || route.company;
  const companyTitle = titleTypography(companyName);

  return (
    <>
      <link rel="stylesheet" href="../assets/research.css" />
      <script defer src="../assets/research.js" />
      <main className="company-page">
        {/* ① 页头：一句话生意本质（短），长结论放进「生意本质」一节 */}
        <header className="company-header">
          <div className="company-eyebrow">
            <span>COMPANY ANALYSIS</span>
            <span>{collection.meta?.ticker ?? route.company}</span>
          </div>
          <h1 data-cjk={companyTitle.cjk} data-title-scale={companyTitle.scale}>
            {companyName}
          </h1>
          <p className="company-current">{text(collection.businessModelMoat?.oneLiner ?? essence.conclusion)}</p>
        </header>

        {/* ① 摘要条：全部是采集与校验得出的事实 */}
        <div className="company-summary">
          <SummaryCell
            label="市值"
            field={valuation.marketCap?.reported}
            note={`${text(final.meta?.dataCutoff).slice(0, 10)} 前双源验证`}
          />
          <SummaryCell
            label="股价"
            field={valuation.sharePrice}
            note={valuation.priceAsOf
              ? <>截至 <time>{stripNote(text(valuation.priceAsOf))}</time></>
              : undefined}
          />
          <SummaryCell label="PE" field={valuation.pe} note="TTM 口径" />
          <div>
            <span>数据完整性</span>
            <strong>{["collection", "analysis", "summary"].map((k) => scores[k] ?? "—").join(" / ")}</strong>
            <small>采集 / 分析 / 总结，满分 10</small>
          </div>
          <div><span>数据截止</span><strong>{text(final.meta?.dataCutoff).slice(0, 10)}</strong></div>
        </div>

        {/* ② 维度总结与信心度（第 3 步产出）：分数与结论直读，打分依据折叠 */}
        <Section id="dimension-summary" kicker="CONCLUSIONS AND CONFIDENCE" title="维度总结与信心度">
          <div className="driver-grid">
            {(summary.dimensionSummary ?? []).map((dim: Json) => (
              <article className="driver-card" key={dim.dimensionId}>
                <h3>{dim.title}</h3>
                <strong>{text(dim.confidence)} / 10</strong>
                <Prose className="dim-conclusion" value={dim.conclusion} />
                <Fold label="打分依据">
                  <Prose value={dim.scoreBasis} />
                </Fold>
              </article>
            ))}
          </div>
          <p className="company-note">信心度为价值投资视角下对该维度的看多程度（0–10，越高越看多）；最大风险按可控程度、估值按价格吸引力打分；企业文化按文化对长期股东的有利程度打分，结论为基于已落盘证据的客观陈述。</p>
        </Section>

        {/* ③ 策略建议（第 3 步产出）：建议 + 触发条件直读，字段溯源折叠 */}
        <Section id="strategies" kicker="WHAT TO DO ABOUT IT" title="策略建议">
          <div className="strategy-grid">
            {[strategies.noPosition, strategies.holding].filter(Boolean).map((strategy: Json) => (
              <article key={strategy.title}>
                <h3>{strategy.title}</h3>
                <Prose className="advice" value={strategy.advice} />
                {Array.isArray(strategy.triggers) && strategy.triggers.length > 0 ? (
                  <>
                    <ul className="trigger-lines">
                      {strategy.triggers.map((trigger: Json, index: number) => (
                        <li key={index}>
                          <strong>{text(trigger.condition)}</strong>
                          <span className="then"> —— {text(trigger.action)}</span>
                        </li>
                      ))}
                    </ul>
                    <Fold label="各触发条件的依据">
                      <ul>
                        {strategy.triggers.map((trigger: Json, index: number) => (
                          <li key={index}><Points value={trigger.basis} /></li>
                        ))}
                      </ul>
                    </Fold>
                  </>
                ) : null}
              </article>
            ))}
          </div>
          {[strategies.sellSignals, strategies.addSignals].filter((s: Json) => Array.isArray(s?.signals) && s.signals.length > 0)
            .map((group: Json) => (
              <div key={group.title}>
                <h3 className="block-heading">{group.title}</h3>
                <ul className="signal-list">
                  {group.signals.map((signal: Json, index: number) => (
                    <li key={index}>
                      <strong className="signal-name">{text(signal.signal)}</strong>
                      <Prose className="signal-desc" value={signal.observable} />
                      <Fold label="依据">
                        <Prose value={signal.basis} />
                      </Fold>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </Section>

        {/* ④ 生意本质 */}
        <Section id="business-essence" kicker="WHAT THE BUSINESS IS" title="生意本质">
          <p className="section-lead">{text(essence.conclusion)}</p>
          <h3 className="block-heading">收入结构（{text(essence.analysis?.revenueBreakdown?.period)}）</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>分部</th><th>收入（{revenueUnitLabel}）</th><th>占比（%）</th><th>来源</th></tr></thead>
              <tbody>
                {(essence.analysis?.revenueBreakdown?.items ?? []).map((item: Json, index: number) => (
                  <tr key={index}>
                    <td>{text(item.segment)}</td>
                    <td>{text(item.revenue)}</td>
                    <td>{text(item.sharePct)}</td>
                    <td><SourceLink source={item.source} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(essence.analysis?.profitabilityTrend5y?.series ?? []).length > 0 ? (
            <>
              <h3 className="block-heading">5 年盈利能力趋势</h3>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>财年</th><th>毛利率</th><th>经营利润率</th><th>净利率</th><th>来源</th></tr></thead>
                  <tbody>
                    {(essence.analysis?.profitabilityTrend5y?.series ?? []).map((row: Json, index: number) => (
                      <tr key={index}>
                        <td>{text(row.fiscalYear)}</td>
                        <td>{pctText(row.grossMarginPct)}</td>
                        <td>{pctText(row.operatingMarginPct)}</td>
                        <td>{pctText(row.netMarginPct)}</td>
                        <td><SourceLink source={row.source} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {essence.analysis?.profitabilityTrend5y?.interpretation ? (
                <Fold label="趋势解读">
                  <Prose value={essence.analysis.profitabilityTrend5y.interpretation} />
                </Fold>
              ) : null}
            </>
          ) : null}
          <h3 className="block-heading">商业模式与粘性</h3>
          <KvList rows={[
            ["商业模式", `${text(essence.analysis?.businessModelCanvas?.salesModel)} · ${text(essence.analysis?.businessModelCanvas?.productForm)}`],
            [`粘性 / 锁定 · ${text(essence.analysis?.stickiness?.level)}`, essence.analysis?.stickiness?.mechanism],
            [`毛利率 vs 同行 · ${pctText(essence.analysis?.grossMarginVsPeers?.companyPct)}`, essence.analysis?.grossMarginVsPeers?.whyHigherOrLower],
            ["经营杠杆", essence.analysis?.operatingLeverage?.observation],
          ]} />
          <EvidenceFold items={[...(essence.analysis?.stickiness?.evidence ?? []), ...(essence.analysis?.operatingLeverage?.evidence ?? [])]} label="本节证据" />
          <Inquiry inquiry={essence.inquiry} />
          <DataGaps gaps={essence.dataGaps} />
        </Section>

        {/* ⑤ 护城河 */}
        <Section id="moat" kicker="WHAT PROTECTS IT" title="护城河评估">
          <p className="section-lead">{text(moat.conclusion)}</p>
          <div className="table-wrap">
            <table className="analysis-table">
              <thead><tr><th>类型</th><th>验证方法</th><th>判定</th><th>证据</th></tr></thead>
              <tbody>
                {(moat.analysis?.types ?? []).map((row: Json, index: number) => (
                  <tr key={index}>
                    <td>{text(row.type)}</td>
                    <td>{text(row.test)}</td>
                    <td>{text(row.verdict)}</td>
                    <td><EvidenceFold items={row.evidence} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <KvList rows={[
            [`过去 5 年 · ${text(moat.analysis?.trendPast5y?.direction)}`, moat.analysis?.trendPast5y?.basis],
            [`未来 5 年 · ${text(moat.analysis?.trendNext5y?.direction)}`, moat.analysis?.trendNext5y?.basis],
          ]} />
          <Inquiry inquiry={moat.inquiry} />
          <DataGaps gaps={moat.dataGaps} />
        </Section>

        {/* ⑥ 逆向思考与风险清单 */}
        <Section id="inversion" kicker="HOW IT COULD FAIL" title="逆向思考与风险清单">
          <p className="section-lead">{text(inversion.conclusion)}</p>
          <div className="table-wrap">
            <table className="analysis-table">
              <thead><tr><th>失败路径</th><th>概率</th><th>影响</th><th>证据</th></tr></thead>
              <tbody>
                {(inversion.analysis?.failurePaths ?? []).map((row: Json, index: number) => (
                  <tr key={index}>
                    <td>{text(row.path)}</td>
                    <td>{text(row.probability)}</td>
                    <td>{text(row.impact)}</td>
                    <td><EvidenceFold items={row.evidence} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="block-heading">历史类比</h3>
          <ul className="signal-list">
            {(inversion.analysis?.historicalAnalogies ?? []).map((item: Json, index: number) => (
              <li key={index}>
                <strong className="signal-name">{text(item.company)}</strong>
                <p className="signal-desc">{text(item.similarity)}；结局：{text(item.outcome)} <SourceLink source={item.source} /></p>
              </li>
            ))}
          </ul>
          <h3 className="block-heading">空方论点</h3>
          <ul className="signal-list">
            {(inversion.analysis?.bearCase ?? []).map((item: Json, index: number) => (
              <li key={index}>
                <strong className="signal-name">{text(item.point)}</strong>
                <p className="signal-desc">持有者：{text(item.holder)}</p>
                <EvidenceFold items={item.evidence} />
              </li>
            ))}
          </ul>
          <Fold label={`跨学科检验 ${(inversion.analysis?.crossDisciplinaryChecks ?? []).length} 项 · 偏误自查 ${(inversion.analysis?.biasSelfCheck ?? []).length} 项`}>
            <ul>
              {(inversion.analysis?.crossDisciplinaryChecks ?? []).map((item: Json, index: number) => (
                <li key={`m${index}`}><strong>{text(item.model)}</strong>：<Points value={item.finding} /></li>
              ))}
              {(inversion.analysis?.biasSelfCheck ?? []).map((item: Json, index: number) => (
                <li key={`b${index}`}><strong>{text(item.bias)}</strong>：<Points value={item.check} /></li>
              ))}
            </ul>
          </Fold>
          <Inquiry inquiry={inversion.inquiry} />
          <DataGaps gaps={inversion.dataGaps} />
        </Section>

        {/* ⑦ 管理层 */}
        <Section id="management" kicker="WHO RUNS IT" title="管理层评估">
          <p className="section-lead">{text(management.conclusion)}</p>
          <h3 className="block-heading">关键决策复盘</h3>
          <div className="table-wrap">
            <table className="analysis-table">
              <thead><tr><th>时间</th><th>决策</th><th>结果</th><th>评分</th></tr></thead>
              <tbody>
                {(management.analysis?.keyDecisions ?? []).map((row: Json, index: number) => (
                  <tr key={index}>
                    <td>{text(row.date)}</td>
                    <td>{text(row.decision)}</td>
                    <td>{text(row.outcome)} <SourceLink source={row.source} /></td>
                    <td>{text(row.rating)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <KvList rows={[
            ["研发回报", management.analysis?.capitalAllocation?.rdReturn],
            ["并购记录", management.analysis?.capitalAllocation?.maTrackRecord],
            ["回购时机", management.analysis?.capitalAllocation?.buybackTiming],
            ["管理层持股", management.analysis?.alignment?.ownership],
            ["薪酬结构", management.analysis?.alignment?.compensation],
            ["减持记录", management.analysis?.alignment?.insiderSelling],
            ["团队稳定性", management.analysis?.organization?.teamStability],
            ["关键人风险", management.analysis?.organization?.keyPersonRisk],
            ["企业文化", management.analysis?.culture],
          ]} />
          <EvidenceFold items={[...(management.analysis?.capitalAllocation?.evidence ?? []), ...(management.analysis?.alignment?.evidence ?? [])]} label="本节证据" />
          <Inquiry inquiry={management.inquiry} />
          <DataGaps gaps={management.dataGaps} />
        </Section>

        {/* ⑧ 行业与长期趋势 */}
        <Section id="industry-trend" kicker="WHERE THE WORLD IS GOING" title="行业与长期趋势">
          <p className="section-lead">{text(industry.conclusion)}</p>
          <KvList rows={[
            ["范式转移", `${text(industry.analysis?.paradigmShift?.verdict)}`],
            ["历史类比", industry.analysis?.historicalAnalogy],
            ["TAM", `${text(industry.analysis?.tam?.current)}；阶段：${text(industry.analysis?.tam?.growthCurve)}`],
            ["价值链位置", industry.analysis?.valueChainPosition],
            ["技术路线风险", industry.analysis?.techRouteRisk],
            ["客户集中度", industry.analysis?.concentration?.customers],
            ["供应商集中度", industry.analysis?.concentration?.suppliers],
          ]} />
          <Fold label="范式转移正反方证据与 TAM 天花板检验">
            <Prose value={industry.analysis?.paradigmShift?.reasoning} />
            <Prose value={industry.analysis?.tam?.ceiling} />
          </Fold>
          <EvidenceFold items={industry.analysis?.concentration?.evidence} label="本节证据" />
          <Inquiry inquiry={industry.inquiry} />
          <DataGaps gaps={industry.dataGaps} />
        </Section>

        {/* ⑨ 估值 */}
        <Section id="valuation" kicker="WHAT THE PRICE IMPLIES" title="估值分析">
          <p className="section-lead">{text(dimValuation.conclusion)}</p>
          <h3 className="block-heading">三情景（{text(scenario.inputs?.years)} 年，工具精确计算）</h3>
          <div className="action-zones">
            {[["乐观", scenario.optimistic], ["中性", scenario.neutral], ["悲观", scenario.pessimistic]]
              .filter(([, value]) => Boolean(value))
              .map(([label, value]: Json) => (
                <div key={label}>
                  <strong>{stripNote(text(value.targetPrice))}</strong>
                  <span>{label}</span>
                  <p>隐含回报 {text(value.impliedReturnPct)}</p>
                </div>
              ))}
          </div>
          <Fold label="三情景假设依据与工具输出">
            <Prose value={scenario.assumptionBasis} />
            <p className="tool-output">{text(scenario.toolOutput)}</p>
          </Fold>
          <h3 className="block-heading">当前倍数</h3>
          <div className="table-wrap">
            <table className="analysis-table">
              <thead><tr><th>指标</th><th>数值</th><th>来源</th></tr></thead>
              <tbody>
                {/* pb / roe / roa / dividendYieldPct / debtRatioPct 是银行保险等重资本行业的核心锚点，
                    非金融公司不填就不渲染（下面的 !cell 直接跳过），不影响既有页面 */}
                {["marketCap", "pe", "ps", "pb", "roe", "roa", "dividendYieldPct", "debtRatioPct", "peg", "evToRevenue"].map((key) => {
                  const cell = dimValuation.analysis?.currentMultiples?.[key];
                  if (!cell) return null;
                  return (
                    <tr key={key}>
                      <td>{key}</td>
                      <td>{text(cell)}{flagMark(cell)}</td>
                      <td><SourceLink source={cell.source} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <KvList rows={[
            ["反向 DCF", dimValuation.analysis?.reverseDcf?.impliedGrowth],
            [`vs 自身历史 · ${text(dimValuation.analysis?.vsOwnHistory?.metric)} 当前 ${text(dimValuation.analysis?.vsOwnHistory?.currentValue)}`, dimValuation.analysis?.vsOwnHistory?.historicalRange],
            ["或有稀释", dimValuation.analysis?.dilutionNote],
          ]} />
          {peerRows.length > 0 ? (
            <>
              <h3 className="block-heading">同行对比</h3>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>公司</th><th>PE（TTM / Fwd）</th><th>PS</th><th>来源</th></tr></thead>
                  <tbody>
                    {peerRows.map((peer: Json, index: number) => (
                      <tr key={index}>
                        <td>{text(peer.name)}</td>
                        <td>{text(peer.peTtm)} / {text(peer.peForward)}</td>
                        <td>{text(peer.ps)}</td>
                        <td><SourceLink source={peer.source} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {peerVerdict ? (
                <Fold label="同行对比结论">
                  <Prose value={peerVerdict.peForward} />
                  <Prose value={peerVerdict.ps} />
                </Fold>
              ) : null}
            </>
          ) : null}
          <Inquiry inquiry={dimValuation.inquiry} />
          <DataGaps gaps={dimValuation.dataGaps} />
        </Section>

        {/* ⑩ 尾注：可追溯性与免责声明 */}
        <section className="company-section" aria-labelledby="provenance">
          <p className="section-kicker">PROVENANCE</p>
          <h2 id="provenance">数据与免责声明</h2>
          <p className="company-note">
            本页由三份经完整性校验（阈值 {text(final.meta?.validation?.threshold)} 分）的结构化文件合并渲染：
            采集 {text(final.meta?.sources?.collection)}、分析 {text(final.meta?.sources?.analysis)}、总结 {text(final.meta?.sources?.summary)}。
            生成于 <time>{text(final.meta?.generatedAt)}</time>，数据截止 {text(final.meta?.dataCutoff)}。
          </p>
          <p className="company-note">{text(summary.disclaimer)}</p>
        </section>
      </main>
    </>
  );
}
