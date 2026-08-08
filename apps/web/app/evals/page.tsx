import {
  RATING_FIELDS,
  RATING_LABELS,
  TREND_MIN_RECORDS,
  VS_LAST_LABELS,
  averageRating,
  firstPassRate,
  integerText,
  listDefects,
  listRuns,
  type RunRecord,
} from "../../lib/evals";

/**
 * 研究评估页 — 研究流程第 7 步（docs/research/workflow/07-evaluation-and-feedback.md）。
 *
 * 呈现的是研究方法本身的可靠程度，不是某家公司的结论。数据在构建时从
 * research/evals/ 读入，因此第 5 步与第 7 步的每次发布都会刷新它。
 *
 * 三条硬约束：
 *   1. 纯静态。copy-output.mjs 会剥掉除 assets/research.js 外的所有 <script>，
 *      所以图形必须在构建时渲染成内联 SVG。
 *   2. 无数据时正常构建并给出说明——全新克隆与测试夹具都会走到这条路径。
 *   3. 记录数少于 TREND_MIN_RECORDS 时不画趋势线。三个点连成的折线传达的
 *      信息量为零而误导性很强，这里宁可只给台账。
 */

export const metadata = { title: "研究评估 — 上市公司研究" };

function ratingText(value: unknown): string {
  return typeof value === "number" ? String(value) : "—";
}

/** 均分走势的极简折线；仅在样本量够时才被调用。 */
function TrendLine({ runs }: { runs: RunRecord[] }) {
  const points = runs
    .slice()
    .reverse()
    .map((run) => averageRating(run))
    .filter((value): value is number => value !== null);
  if (points.length < TREND_MIN_RECORDS) return null;

  const width = 720;
  const height = 120;
  const padding = 8;
  const step = (width - padding * 2) / (points.length - 1);
  // 纵轴固定在评分的定义域 1–5，不按数据自适应：自适应会把 0.2 分的波动
  // 画成陡坡，读者看到的斜率就不再对应真实变化。
  const y = (value: number) =>
    height - padding - ((value - 1) / 4) * (height - padding * 2);
  const path = points
    .map((value, index) => `${index === 0 ? "M" : "L"}${padding + index * step},${y(value)}`)
    .join(" ");

  return (
    <figure className="evals-trend">
      <svg viewBox={`0 0 ${width} ${height}`} role="img"
           aria-label="阅读评分均分走势，纵轴固定为 1 到 5 分">
        <line x1={padding} y1={y(3)} x2={width - padding} y2={y(3)}
              stroke="var(--line)" strokeWidth="1" strokeDasharray="3 3" />
        <path d={path} fill="none" stroke="var(--ink)" strokeWidth="1.5" />
        {points.map((value, index) => (
          <circle key={index} cx={padding + index * step} cy={y(value)} r="2.5" fill="var(--signal)" />
        ))}
      </svg>
      <figcaption>阅读评分均分，自左向右由旧到新；虚线为 3 分。纵轴固定 1–5 分。</figcaption>
    </figure>
  );
}

export default function EvalsPage() {
  const runs = listRuns();
  const defects = listDefects();
  const rated = runs.map((run) => averageRating(run)).filter((v): v is number => v !== null);
  const overallAverage = rated.length > 0
    ? rated.reduce((sum, value) => sum + value, 0) / rated.length
    : null;
  const passRate = firstPassRate(runs);
  const changedPosition = runs.filter((run) => run.rating?.changedMyPosition === true).length;

  return (
    <>
      <link rel="stylesheet" href="./assets/research.css" />
      <main className="company-page">
        <header className="company-header">
          <div className="company-eyebrow"><span>AIRESEARCH</span><span>METHOD EVALUATION</span></div>
          <h1>研究评估</h1>
          <p className="company-current">
            这一页评估的是研究方法本身，不是任何一家公司的结论。每次研究做完时记录一条：
            机器指标由工具运行时自己写，阅读评分由人读完报告当场打。
          </p>
        </header>

        {runs.length === 0 ? (
          <section className="company-section">
            <p className="section-kicker">LEDGER</p>
            <p className="company-note">
              暂无评估记录。完成一次研究流程的第 7 步（评估与反馈）后，这里会自动出现一行。
            </p>
          </section>
        ) : (
          <>
            <section className="company-summary">
              <div>
                <span>已评估研究</span>
                <strong>{runs.length}</strong>
                <small>一次研究一条，追加式不改写</small>
              </div>
              <div>
                <span>阅读评分均分</span>
                <strong>{overallAverage === null ? "—" : overallAverage.toFixed(1)}</strong>
                <small>五项各 1–5 分的平均</small>
              </div>
              <div>
                <span>校验一次通过率</span>
                <strong>{passRate === null ? "—" : `${Math.round(passRate * 100)}%`}</strong>
                <small>第 4 步首轮即达标的比例</small>
              </div>
              <div>
                <span>改变了仓位</span>
                <strong>{changedPosition} / {runs.length}</strong>
                <small>比自评分更诚实的行为指标</small>
              </div>
            </section>

            <section className="company-section">
              <p className="section-kicker">LEDGER</p>
              <h2>研究台账</h2>
              {runs.length < TREND_MIN_RECORDS ? (
                <p className="company-note">
                  样本量为 {runs.length} 条，不足 {TREND_MIN_RECORDS} 条，因此只列台账、不画趋势线——
                  几个点连成的折线读不出趋势，只会造成看出了趋势的错觉。
                </p>
              ) : (
                <TrendLine runs={runs} />
              )}
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>公司</th>
                      <th>评分日</th>
                      {RATING_FIELDS.map((field) => <th key={field}>{RATING_LABELS[field]}</th>)}
                      <th>均分</th>
                      <th>比上次</th>
                      <th>校验</th>
                      <th>干预 / 纠错</th>
                      <th>输出 token</th>
                      <th>投入分钟</th>
                      <th>skill</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run, index) => {
                      const average = averageRating(run);
                      const machine = run.machine ?? {};
                      return (
                        <tr key={`${run.company}-${run.ratedAt}-${index}`}>
                          <td>{run.companyName || run.company || "—"}</td>
                          <td>{String(run.ratedAt ?? "").slice(0, 10) || "—"}</td>
                          {RATING_FIELDS.map((field) => (
                            <td key={field}>{ratingText(run.rating?.[field])}</td>
                          ))}
                          <td>{average === null ? "—" : average.toFixed(1)}</td>
                          <td>{VS_LAST_LABELS[run.rating?.vsLast] ?? "—"}</td>
                          <td>
                            {machine.firstPassValidation === true
                              ? "一次过"
                              : typeof machine.validationRounds === "number"
                                ? `${machine.validationRounds} 轮`
                                : "—"}
                          </td>
                          <td>
                            {typeof machine.userMessages === "number" ? machine.userMessages : "—"}
                            {" / "}
                            {typeof machine.correctionMessages === "number"
                              ? machine.correctionMessages : "—"}
                          </td>
                          <td>{integerText(machine.outputTokens)}</td>
                          <td>{integerText(machine.activeMinutes)}</td>
                          <td>{run.skillCommit || "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="coverage-note">
                成本指标取自会话日志，取不到时显示 —— 而不是 0；它依赖编辑器的内部日志格式，
                因此被有意设计成可缺失。校验轮数与得分取自工具自己写的运行事件，是一等事实。
              </p>
            </section>

            <section className="company-section">
              <p className="section-kicker">DEFECTS</p>
              <h2>最差的一处</h2>
              <p className="section-lead">
                每次评分必填一条。五个分数一定会随习惯向上漂移直至饱和，这一条不会——
                改研究方法时，改的应该是这里记下的失败，而不是印象里的问题。
              </p>
              {defects.length === 0 ? (
                <p className="company-note">暂无缺陷记录。</p>
              ) : (
                <ul className="evals-defects">
                  {defects.map((defect, index) => (
                    <li key={`${defect.company}-${defect.at}-${index}`}>
                      <div className="evals-defect-meta">
                        <span>{String(defect.at ?? "").slice(0, 10) || "—"}</span>
                        <span>{defect.company || "—"}</span>
                        <span>{defect.step || "unspecified"}</span>
                        <span>{defect.skillCommit || "—"}</span>
                      </div>
                      <p>{defect.symptom || "—"}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}

        <section className="company-section">
          <p className="section-kicker">METHOD</p>
          <h2>怎么读这一页</h2>
          <p className="section-lead">
            正确性、依从性、自主性、成本、稳定性都是代理指标，阅读评分才是目的本身。
            判定一次研究方法的改动是不是改进，标准是：固定模型与固定任务下，其中至少一项显著提升、
            其余不回归、成本不显著变差。任何一项回归都不算改进。
          </p>
          <p className="coverage-note">
            这套自我评价本身也可被怀疑：五项评分会漂移会饱和，真正承载信号的是「最差的一处」
            与「是否改变仓位」这两个不易自欺的字段。若台账上的分数长期贴在高位而缺陷仍在稳定产出，
            应当相信后者。原始记录在仓库的 research/evals/ 下，逐条可核对。
          </p>
        </section>

        <p className="coverage-note">
          <a className="pill-link" href="./index.html">← 回到公司研究</a>
        </p>
      </main>
    </>
  );
}
