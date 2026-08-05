import type { Metadata } from "next";
import { existsSync } from "node:fs";
import { finalPath, listFinalCompanies, loadFinal } from "../../../lib/final-report";

/**
 * 公司分析页 — 研究流程第 5 步（docs/research/workflow/05-render-site.md）。
 *
 * 输入是 build_final.py 合并三份校验通过文件后生成的
 * research/companies/<company>/financials-final.json（financials—final-template.json 契约）。
 * 校验闸门在合并脚本里，本页只负责渲染：字段缺失或 unavailable 时如实显示原因，
 * 不用 0 或空字符串代替。样式完全复用 assets/research.css 的既有类，不新增样式。
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

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/** 是否是规范的「取不到」占位对象。 */
function isUnavailable(value: Json): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && value.status === "unavailable";
}

/** 把任意值渲染成文本：校验对象取 value，unavailable 如实给原因，不吞字段。 */
function text(value: Json): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (isUnavailable(value)) return `缺失：${value.reason ?? "未说明原因"}`;
  if (typeof value === "object" && !Array.isArray(value) && "value" in value) {
    const unit = value.currency ?? "";
    return `${value.value}${unit ? ` ${unit}` : ""}`;
  }
  return "—";
}

/** 双源校验对象的误差标记。 */
function flagMark(value: Json): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  if (value.flag === "ok") return " ✅";
  if (value.flag === "minor-diff") return " ⚠️";
  if (value.flag === "major-diff") return " ❌";
  return "";
}

function SourceLink({ source }: { source: Json }) {
  if (!source?.name) return null;
  const label = source.url ? (
    <a href={source.url} rel="noreferrer">{source.name}</a>
  ) : (
    source.name
  );
  return <span className="source-ids">来源：{label}{source.asOf ? `（${source.asOf}）` : null}</span>;
}

function EvidenceList({ items }: { items: Json }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <ul className="editorial-list">
      {items.map((item: Json, index: number) => (
        <li key={index}>
          {text(item.metric)}：{text(item.value)}
          {item.asOf ? `（${text(item.asOf)}）` : null}{" "}
          <SourceLink source={item.source} />
        </li>
      ))}
    </ul>
  );
}

function Inquiry({ inquiry }: { inquiry: Json }) {
  if (!inquiry?.question) return null;
  return (
    <>
      <h3 className="block-heading">追问</h3>
      <p className="company-note">
        <strong>{inquiry.question}</strong>
        <br />
        {text(inquiry.answer)}
      </p>
    </>
  );
}

function DataGaps({ gaps }: { gaps: Json }) {
  if (!Array.isArray(gaps) || gaps.length === 0) return null;
  return (
    <>
      <h3 className="block-heading">缺口</h3>
      <ul className="editorial-list">
        {gaps.map((gap: Json, index: number) => (
          <li key={index}>{typeof gap === "string" ? gap : text(gap.item ?? gap.reason ?? gap)}</li>
        ))}
      </ul>
    </>
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
  const moat = dims.moat ?? {};
  const inversion = dims.inversion ?? {};
  const management = dims.management ?? {};
  const industry = dims.industryTrend ?? {};
  const dimValuation = dims.valuation ?? {};
  const strategies = summary.strategies ?? {};
  const scenario = dimValuation.analysis?.threeScenario ?? {};

  return (
    <>
      <link rel="stylesheet" href="../assets/research.css" />
      <script defer src="../assets/research.js" />
      <main className="company-page">
        {/* ① 页头 */}
        <header className="company-header">
          <div className="company-eyebrow">
            <span>COMPANY ANALYSIS</span>
            <span>{collection.meta?.ticker ?? route.company}</span>
          </div>
          <h1>{final.meta?.companyName || route.company}</h1>
          <p className="company-current">{text(essence.conclusion ?? collection.businessModelMoat?.oneLiner)}</p>
        </header>

        {/* ① 摘要条：全部是采集与校验得出的事实 */}
        <div className="company-summary">
          <div><span>市值</span><strong>{text(valuation.marketCap?.reported)}</strong></div>
          <div>
            <span>股价</span>
            <strong>{text(valuation.sharePrice)}</strong>
            {valuation.priceAsOf ? <small>截至 <time>{text(valuation.priceAsOf)}</time></small> : null}
          </div>
          <div><span>PE</span><strong>{text(valuation.pe)}</strong></div>
          <div>
            <span>数据完整性</span>
            <strong>{["collection", "analysis", "summary"].map((k) => scores[k] ?? "—").join(" / ")}</strong>
            <small>采集 / 分析 / 总结，满分 10</small>
          </div>
          <div><span>数据截止</span><strong>{text(final.meta?.dataCutoff)}</strong></div>
        </div>

        {/* ② 维度总结与信心度（第 3 步产出） */}
        <Section id="dimension-summary" kicker="CONCLUSIONS AND CONFIDENCE" title="维度总结与信心度">
          <div className="driver-grid">
            {(summary.dimensionSummary ?? []).map((dim: Json) => (
              <article className="driver-card" key={dim.dimensionId}>
                <div className="metric-meta"><span>{dim.dimensionId}</span></div>
                <h3>{dim.title}</h3>
                <strong>{text(dim.confidence)} / 10</strong>
                <p className="driver-delta">{text(dim.conclusion)}</p>
                <small>打分依据：{text(dim.scoreBasis)}</small>
              </article>
            ))}
          </div>
          <p className="company-note">信心度反映证据密度与数据质量，不是看多程度。</p>
        </Section>

        {/* ③ 策略建议（第 3 步产出） */}
        <Section id="strategies" kicker="WHAT TO DO ABOUT IT" title="策略建议">
          <div className="action-zones">
            {[strategies.noPosition, strategies.holding].filter(Boolean).map((strategy: Json) => (
              <div key={strategy.title}>
                <strong>{strategy.title}</strong>
                <span>建议</span>
                <p>{text(strategy.advice)}</p>
              </div>
            ))}
          </div>
          {[strategies.noPosition, strategies.holding].filter((s: Json) => Array.isArray(s?.triggers) && s.triggers.length > 0)
            .map((strategy: Json) => (
              <div key={`${strategy.title}-triggers`}>
                <h3 className="block-heading">{strategy.title}·触发条件</h3>
                <ul className="constraint-list">
                  {strategy.triggers.map((trigger: Json, index: number) => (
                    <li key={index}>
                      <strong>{text(trigger.condition)}</strong>
                      <p>{text(trigger.action)}<br /><small className="source-ids">依据：{text(trigger.basis)}</small></p>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          {[strategies.sellSignals, strategies.addSignals].filter((s: Json) => Array.isArray(s?.signals) && s.signals.length > 0)
            .map((group: Json) => (
              <div key={group.title}>
                <h3 className="block-heading">{group.title}</h3>
                <ul className="constraint-list">
                  {group.signals.map((signal: Json, index: number) => (
                    <li key={index}>
                      <strong>{text(signal.signal)}</strong>
                      <p>观察方式：{text(signal.observable)}<br /><small className="source-ids">依据：{text(signal.basis)}</small></p>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </Section>

        {/* ④ 生意本质 */}
        <Section id="business-essence" kicker="WHAT THE BUSINESS IS" title="生意本质">
          <p className="company-note">{text(essence.conclusion)}</p>
          <h3 className="block-heading">收入结构（{text(essence.analysis?.revenueBreakdown?.period)}）</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>分部</th><th>收入</th><th>占比</th><th>来源</th></tr></thead>
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
          <h3 className="block-heading">5 年盈利能力趋势</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>财年</th><th>毛利率</th><th>经营利润率</th><th>净利率</th><th>来源</th></tr></thead>
              <tbody>
                {(essence.analysis?.profitabilityTrend5y?.series ?? []).map((row: Json, index: number) => (
                  <tr key={index}>
                    <td>{text(row.fiscalYear)}</td>
                    <td>{text(row.grossMarginPct)}</td>
                    <td>{text(row.operatingMarginPct)}</td>
                    <td>{text(row.netMarginPct)}</td>
                    <td><SourceLink source={row.source} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="delta-line">
            <div><dt>商业模式</dt><dd>{text(essence.analysis?.businessModelCanvas?.salesModel)} · {text(essence.analysis?.businessModelCanvas?.productForm)}</dd></div>
            <div><dt>粘性/锁定</dt><dd>{text(essence.analysis?.stickiness?.level)}：{text(essence.analysis?.stickiness?.mechanism)}</dd></div>
            <div><dt>毛利率 vs 同行</dt><dd>{text(essence.analysis?.grossMarginVsPeers?.companyPct)}——{text(essence.analysis?.grossMarginVsPeers?.whyHigherOrLower)}</dd></div>
            <div><dt>经营杠杆</dt><dd>{text(essence.analysis?.operatingLeverage?.observation)}</dd></div>
          </dl>
          <Inquiry inquiry={essence.inquiry} />
          <DataGaps gaps={essence.dataGaps} />
        </Section>

        {/* ⑤ 护城河 */}
        <Section id="moat" kicker="WHAT PROTECTS IT" title="护城河评估">
          <p className="company-note">{text(moat.conclusion)}</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>类型</th><th>验证方法</th><th>判定</th><th>证据</th></tr></thead>
              <tbody>
                {(moat.analysis?.types ?? []).map((row: Json, index: number) => (
                  <tr key={index}>
                    <td>{text(row.type)}</td>
                    <td>{text(row.test)}</td>
                    <td>{text(row.verdict)}</td>
                    <td><EvidenceList items={row.evidence} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="delta-line">
            <div><dt>过去 5 年</dt><dd>{text(moat.analysis?.trendPast5y?.direction)}——{text(moat.analysis?.trendPast5y?.basis)}</dd></div>
            <div><dt>未来 5 年</dt><dd>{text(moat.analysis?.trendNext5y?.direction)}——{text(moat.analysis?.trendNext5y?.basis)}</dd></div>
          </dl>
          <Inquiry inquiry={moat.inquiry} />
          <DataGaps gaps={moat.dataGaps} />
        </Section>

        {/* ⑥ 逆向思考与风险清单 */}
        <Section id="inversion" kicker="HOW IT COULD FAIL" title="逆向思考与风险清单">
          <p className="company-note">{text(inversion.conclusion)}</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>失败路径</th><th>概率</th><th>影响</th><th>证据</th></tr></thead>
              <tbody>
                {(inversion.analysis?.failurePaths ?? []).map((row: Json, index: number) => (
                  <tr key={index}>
                    <td>{text(row.path)}</td>
                    <td>{text(row.probability)}</td>
                    <td>{text(row.impact)}</td>
                    <td><EvidenceList items={row.evidence} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="block-heading">历史类比</h3>
          <ul className="editorial-list">
            {(inversion.analysis?.historicalAnalogies ?? []).map((item: Json, index: number) => (
              <li key={index}>{text(item.company)}——{text(item.similarity)}；结局：{text(item.outcome)} <SourceLink source={item.source} /></li>
            ))}
          </ul>
          <h3 className="block-heading">空方论点</h3>
          <ul className="editorial-list">
            {(inversion.analysis?.bearCase ?? []).map((item: Json, index: number) => (
              <li key={index}>{text(item.point)}（{text(item.holder)}）<EvidenceList items={item.evidence} /></li>
            ))}
          </ul>
          <h3 className="block-heading">偏误自查</h3>
          <ul className="editorial-list">
            {(inversion.analysis?.biasSelfCheck ?? []).map((item: Json, index: number) => (
              <li key={index}><strong>{text(item.bias)}</strong>：{text(item.check)}</li>
            ))}
          </ul>
          <Inquiry inquiry={inversion.inquiry} />
          <DataGaps gaps={inversion.dataGaps} />
        </Section>

        {/* ⑦ 管理层 */}
        <Section id="management" kicker="WHO RUNS IT" title="管理层评估">
          <p className="company-note">{text(management.conclusion)}</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>时间</th><th>决策</th><th>结果</th><th>评分</th><th>来源</th></tr></thead>
              <tbody>
                {(management.analysis?.keyDecisions ?? []).map((row: Json, index: number) => (
                  <tr key={index}>
                    <td>{text(row.date)}</td>
                    <td>{text(row.decision)}</td>
                    <td>{text(row.outcome)}</td>
                    <td>{text(row.rating)}</td>
                    <td><SourceLink source={row.source} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="delta-line">
            <div><dt>资本配置</dt><dd>研发回报 {text(management.analysis?.capitalAllocation?.rdReturn)}；并购 {text(management.analysis?.capitalAllocation?.maTrackRecord)}；回购 {text(management.analysis?.capitalAllocation?.buybackTiming)}</dd></div>
            <div><dt>利益一致性</dt><dd>持股 {text(management.analysis?.alignment?.ownership)}；薪酬 {text(management.analysis?.alignment?.compensation)}；减持 {text(management.analysis?.alignment?.insiderSelling)}</dd></div>
            <div><dt>组织</dt><dd>{text(management.analysis?.organization?.teamStability)}；关键人风险 {text(management.analysis?.organization?.keyPersonRisk)}</dd></div>
            <div><dt>文化</dt><dd>{text(management.analysis?.culture)}</dd></div>
          </dl>
          <Inquiry inquiry={management.inquiry} />
          <DataGaps gaps={management.dataGaps} />
        </Section>

        {/* ⑧ 行业与长期趋势 */}
        <Section id="industry-trend" kicker="WHERE THE WORLD IS GOING" title="行业与长期趋势">
          <p className="company-note">{text(industry.conclusion)}</p>
          <dl className="delta-line">
            <div><dt>范式转移</dt><dd>{text(industry.analysis?.paradigmShift?.verdict)}——{text(industry.analysis?.paradigmShift?.reasoning)}</dd></div>
            <div><dt>历史类比</dt><dd>{text(industry.analysis?.historicalAnalogy)}</dd></div>
            <div><dt>TAM</dt><dd>{text(industry.analysis?.tam?.current)}；天花板 {text(industry.analysis?.tam?.ceiling)}；阶段 {text(industry.analysis?.tam?.growthCurve)}</dd></div>
            <div><dt>价值链位置</dt><dd>{text(industry.analysis?.valueChainPosition)}</dd></div>
            <div><dt>技术路线风险</dt><dd>{text(industry.analysis?.techRouteRisk)}</dd></div>
            <div><dt>集中度</dt><dd>客户 {text(industry.analysis?.concentration?.customers)}；供应商 {text(industry.analysis?.concentration?.suppliers)}</dd></div>
          </dl>
          <Inquiry inquiry={industry.inquiry} />
          <DataGaps gaps={industry.dataGaps} />
        </Section>

        {/* ⑨ 估值 */}
        <Section id="valuation" kicker="WHAT THE PRICE IMPLIES" title="估值分析">
          <p className="company-note">{text(dimValuation.conclusion)}</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>指标</th><th>数值</th><th>来源</th></tr></thead>
              <tbody>
                {["marketCap", "pe", "ps", "peg", "evToRevenue"].map((key) => {
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
          <h3 className="block-heading">三情景（{text(scenario.inputs?.years)} 年，工具精确计算）</h3>
          <div className="action-zones">
            {[["乐观", scenario.optimistic], ["中性", scenario.neutral], ["悲观", scenario.pessimistic]]
              .filter(([, value]) => Boolean(value))
              .map(([label, value]: Json) => (
                <div key={label}>
                  <strong>{text(value.targetPrice)}</strong>
                  <span>{label}</span>
                  <p>隐含回报 {text(value.impliedReturnPct)}</p>
                </div>
              ))}
          </div>
          <p className="company-note">假设依据：{text(scenario.assumptionBasis)}</p>
          <dl className="delta-line">
            <div><dt>反向 DCF</dt><dd>{text(dimValuation.analysis?.reverseDcf?.impliedGrowth)}（{text(dimValuation.analysis?.reverseDcf?.assumptions)}）</dd></div>
            <div><dt>vs 自身历史</dt><dd>{text(dimValuation.analysis?.vsOwnHistory?.metric)} 当前 {text(dimValuation.analysis?.vsOwnHistory?.currentValue)}，{text(dimValuation.analysis?.vsOwnHistory?.historicalRange)}</dd></div>
          </dl>
          {Array.isArray(dimValuation.analysis?.vsPeers) && dimValuation.analysis.vsPeers.length > 0 ? (
            <>
              <h3 className="block-heading">同行对比</h3>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>公司</th><th>PE</th><th>PS</th><th>来源</th></tr></thead>
                  <tbody>
                    {dimValuation.analysis.vsPeers.map((peer: Json, index: number) => (
                      <tr key={index}>
                        <td>{text(peer.name)}</td>
                        <td>{text(peer.pe)}</td>
                        <td>{text(peer.ps)}</td>
                        <td><SourceLink source={peer.source} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
