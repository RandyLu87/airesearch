import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const researchRoot = path.join(repoRoot, "research", "companies");
const siteRoot = path.join(repoRoot, "research", "site");
const pilotCompany = "hk-9899-netease-cloud-music";

function listCompanySnapshots(companyId) {
  const directory = path.join(researchRoot, companyId, "snapshots");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const source = readFileSync(path.join(directory, name));
      return {
        stem: name.slice(0, -5),
        source,
        data: JSON.parse(source.toString("utf8")),
      };
    })
    .sort((left, right) =>
      left.data.snapshot.createdAt.localeCompare(right.data.snapshot.createdAt),
    );
}

function listSnapshotCompanies() {
  return readdirSync(researchRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((companyId) => listCompanySnapshots(companyId).length > 0)
    .sort();
}

/**
 * Publishing is the expensive part of these tests and every assertion reads the
 * same output, so the build runs once per file rather than once per test.
 */
let publication;
function publishSite() {
  publication ??= spawnSync("npm", ["run", "publish"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(
    publication.status,
    0,
    `publication failed\nstdout:\n${publication.stdout}\nstderr:\n${publication.stderr}`,
  );
  return publication;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The rendered text with markup removed.
 *
 * Long research prose is split into paragraphs and enumerations at render time,
 * so a field's value no longer appears as one contiguous run in the HTML.
 * Assertions about "is this text on the page" have to read text, not source.
 */
function pageText(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ");
}

/** Whether every sentence of `text` survived into the page. */
function containsProse(html, text) {
  const body = pageText(html);
  return text
    .split("。")
    .map((part) => part.trim())
    .filter((part) => part.length > 6)
    .every((part) => body.includes(part.replace(/\s+/g, " ")));
}

/**
 * Mirrors formatPrice in @airesearch/research-ui. These tests are plain .mjs and
 * the package is .tsx, so it cannot be imported here; the existing assertions
 * spell the same rule out inline. Keep the two in step.
 */
function formatPrice(value, currency) {
  return `${currency === "HKD" ? "HK$" : `${currency} `}${value}`;
}

/** Mirrors formatMarketCap in @airesearch/research-ui, for the same reason. */
function formatMarketCap(cap) {
  const suffix = cap.scale === "hundred-million" ? "亿" : cap.scale === "million" ? "百万" : "";
  return `${cap.currency} ${cap.value}${suffix}`;
}

function assertLocalReferencesResolve(html, pagePath, label) {
  const references = [...html.matchAll(/(?:href|src)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    // A fragment addresses a position inside the target, not a different file.
    .map((reference) => reference.split("#")[0])
    .filter(
      (reference) => reference !== "",
    )
    .filter(
      (reference) =>
        !reference.startsWith("#") &&
        !reference.startsWith("http://") &&
        !reference.startsWith("https://") &&
        !reference.startsWith("data:"),
    );
  for (const reference of references) {
    assert.equal(
      existsSync(path.resolve(path.dirname(pagePath), reference)),
      true,
      `broken local reference in ${label}: ${reference}`,
    );
  }
}

/** Splits a shorthand on the spaces between values, not the ones inside clamp(). */
function splitShorthand(value) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const character of value.trim()) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (/\s/.test(character) && depth === 0) {
      if (current) parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) parts.push(current);
  return parts;
}

/** The bottom of a `padding` shorthand, whichever of the 1–4 value forms is used. */
function paddingBottom(shorthand) {
  const values = splitShorthand(shorthand);
  return values.length >= 3 ? values[2] : values[0];
}

/** A length in px, or NaN for any other unit so callers can reject it. */
function pixels(value) {
  const match = /^(\d+(?:\.\d+)?)px$/.exec(value.trim());
  return match ? Number.parseFloat(match[1]) : Number.NaN;
}

/**
 * The largest this length can ever compute to, in px: a clamp() can never
 * exceed its ceiling, and a bare length is its own maximum. NaN for anything
 * unbounded — `16vh` has no ceiling, which is how the fold got eaten once.
 */
function maxLength(value) {
  const clamp = /^clamp\((.+)\)$/.exec(value.trim());
  if (!clamp) return pixels(value);
  let depth = 0;
  const args = [""];
  for (const character of clamp[1]) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      args.push("");
      continue;
    }
    args[args.length - 1] += character;
  }
  return pixels(args.at(-1));
}

/**
 * The first company card has to be fully visible without scrolling. Measured
 * budget for everything above it: ≤350px at 375×667 (iPhone SE, the tightest
 * real viewport) so the 269px card plus a ≥45px peek of the next one fit, and
 * ≤449px at 1512×763 so both cards of the desktop row fit.
 *
 * These assertions pin the four values that blew the budget once. They cannot
 * prove the budget holds — a newly added element would pass them and still push
 * the card under the fold. Re-measure with a real browser after touching the
 * header: publish, then load research/site/index.html in headless Chrome with a
 * script appended that writes the numbers into the DOM, and read them back with
 * --dump-dom (--dump-dom prints the DOM, so the geometry has to be put there):
 *
 *   document.body.innerHTML = [...document.querySelectorAll('.report-link')]
 *     .map((card) => JSON.stringify(card.getBoundingClientRect())).join('|')
 *     + ' viewport ' + innerHeight
 *
 * Mind that --window-size includes the browser chrome: pass 375,754 to get a
 * 667px-tall viewport. Widths under 500px need an iframe of the target width,
 * because Chrome clamps its own window narrower than that.
 */
test("the site index header stays inside its above-the-fold budget", () => {
  const css = readFileSync(
    path.join(repoRoot, "apps", "web", "public", "assets", "research.css"),
    "utf8",
  );

  const headingMargin = css.match(/\.company-header h1\s*\{[^}]*margin:\s*([^;}]+)/);
  assert.ok(headingMargin, "missing the .company-header h1 rule");
  // The air above a 150px title has to grow with the screen without ever
  // reaching 16vh's 122px. Two clauses: bounded, and anything beyond a flat
  // 40px has to be viewport-relative so short laptops get the smaller gap.
  const headingTop = splitShorthand(headingMargin[1])[0];
  assert.ok(
    maxLength(headingTop) <= 80,
    `.company-header h1 top margin must be bounded and ≤80px, found ${headingTop}`,
  );
  assert.ok(
    maxLength(headingTop) <= 40 || headingTop.includes("vh"),
    `a top margin above 40px must scale with viewport height, found ${headingTop}`,
  );

  const headerPadding = css.match(/\.company-header\s*\{[^}]*padding:\s*([^;}]+)/);
  assert.ok(headerPadding, "missing the .company-header rule");
  const headerBottom = pixels(paddingBottom(headerPadding[1]));
  assert.ok(
    headerBottom <= 32,
    `.company-header bottom padding must stay ≤32px, found ${headerPadding[1]}`,
  );

  const coverageSection = css.match(/\.coverage-section\s*\{[^}]*padding-top:\s*([^;}]+)/);
  assert.ok(coverageSection, "the coverage list must tighten its top padding");
  assert.ok(
    pixels(coverageSection[1]) <= 32,
    `.coverage-section top padding must stay ≤32px, found ${coverageSection[1]}`,
  );

  // The lead sentence: 40px wrapped to two lines and cost 137px of the fold.
  const lead = css.match(/\.company-current\s*\{[^}]*font-size:\s*clamp\(([^)]+)\)/);
  assert.ok(lead, "missing the .company-current font-size clamp");
  const leadCeiling = pixels(lead[1].split(",").at(-1));
  assert.ok(
    leadCeiling <= 28,
    `.company-current must stay ≤28px at its ceiling, found ${lead[1]}`,
  );

  // Narrow screens override the page title so 上市公司研究 stays on one line.
  const narrowTitle = css.match(
    /@media \(max-width: 800px\)[\s\S]*?\.company-header h1\s*\{[^}]*font-size:\s*clamp\(([^)]+)\)/,
  );
  assert.ok(narrowTitle, "missing the narrow-screen .company-header h1 override");
  assert.ok(
    pixels(narrowTitle[1].split(",").at(-1)) <= 48,
    `narrow .company-header h1 must stay ≤48px, found ${narrowTitle[1]}`,
  );

  // The published copy is what GitHub Pages serves — the workflow uploads
  // research/site as-is, without building.
  assert.equal(
    css,
    readFileSync(path.join(siteRoot, "assets", "research.css"), "utf8"),
    "published CSS drifted from the source; run npm run publish",
  );
});

test("the business model section renders a flow and a closing waterfall", () => {
  let waterfallsSeen = 0;

  for (const companyId of listSnapshotCompanies()) {
    const latest = listCompanySnapshots(companyId).at(-1).data;
    // The legacy contract has no businessModel at all, so the section is skipped
    // for it entirely rather than rendered empty.
    if (latest.schemaVersion !== "1.1.0") continue;
    const html = readFileSync(
      path.join(siteRoot, "companies", `${companyId}.html`),
      "utf8",
    );

    const links = latest.businessModel.causalChain
      .split("→")
      .map((link) => link.trim().replace(/[。；;]+$/, "").trim())
      .filter((link) => link.length > 0);
    assert.ok(links.length >= 2, `${companyId} 的因果链应至少解析出两个环节`);
    assert.equal(
      (html.match(/class="causal-step"/g) ?? []).length,
      links.length,
      `${companyId} 阶梯流节点数与因果链环节数不符`,
    );
    // Ordinals only. A stage label mapped by position would mislabel any chain
    // whose length differs from the seven-link template.
    assert.doesNotMatch(html, /class="causal-step"[^>]*>\s*(供给|分发|变现)</);

    // The flywheel ring is the desktop register of the same chain. Its cards
    // carry the full text — the whole point of choosing cards over a labelled
    // ring was that no mechanical 10-character summary preserved the meaning.
    if (links.length >= 5) {
      const ring = html.match(/<div class="flywheel"[\s\S]*?<\/ol><\/div>/);
      assert.ok(ring, `${companyId} 应渲染飞轮环`);
      assert.equal(
        (ring[0].match(/class="flywheel-badge"/g) ?? []).length,
        links.length,
        `${companyId} 环上卡片数与因果链环节数不符`,
      );
      for (const link of links) {
        // Tokens like 2026-03-28 get a nowrap wrapper, so compare on text only.
        const plain = ring[0].replace(/<[^>]+>/g, "");
        assert.ok(
          plain.includes(link.replace(/\s+/g, " ")) ||
            link.split(/[（(]/)[0].length > 0 && plain.includes(link.split(/[（(]/)[0]),
          `${companyId} 环上卡片缺少第 ${links.indexOf(link) + 1} 环全文`,
        );
      }
    } else {
      assert.doesNotMatch(html, /class="flywheel"/, `${companyId} 环节过少时不该渲染环`);
    }

    const period = latest.financialHistory.at(-1);
    const priced = (period.segments ?? []).filter((item) => item.operatingProfit);
    if (priced.length === 0 || !period.operatingMargin) {
      assert.doesNotMatch(html, /cash-waterfall/, `${companyId} 缺分部经营利润时不该出现瀑布图`);
      continue;
    }

    waterfallsSeen += 1;
    const digits = priced[0].operatingProfit.precision;
    const segmentSum = priced.reduce((sum, item) => sum + Number(item.operatingProfit.value), 0);
    const operatingProfit =
      (Number(period.revenue.value) * Number(period.operatingMargin.value)) / 100;
    const waterfall = html.match(
      /<figure class="decision-chart cash-waterfall">[\s\S]*?<\/figure>/,
    );
    assert.ok(waterfall, `${companyId} 应渲染现金引擎瀑布图`);
    // The bridge has to close: segment profits less the unallocated block equal
    // the operating profit the income statement reports.
    const texts = [...waterfall[0].matchAll(/>([^<>]+)<\/text>/g)].map((match) => match[1]);
    assert.ok(texts.includes(segmentSum.toFixed(digits)), `${companyId} 缺分部合计`);
    assert.ok(texts.includes(operatingProfit.toFixed(digits)), `${companyId} 缺经营利润`);
    const unallocated = segmentSum - operatingProfit;
    assert.ok(
      texts.some((value) => value.replace("−", "-") === `-${Math.abs(unallocated).toFixed(digits)}`),
      `${companyId} 缺未分摊成本`,
    );
    // ADR-0004: charts ship as inline SVG, so they print and open offline.
    assert.match(waterfall[0], /<svg/);
    assert.doesNotMatch(waterfall[0], /<(canvas|img|script)/);
    // The unallocated composition stays in the author's prose, never scraped
    // into a number the reader cannot trace to a filing.
    assert.ok(containsProse(html, latest.businessModel.cashEngine), `${companyId} 缺少现金引擎正文`);
  }

  assert.ok(
    waterfallsSeen > 0,
    "至少要有一家公司的账本记录了分部经营利润，否则瀑布图代码路径从未被执行",
  );

  // The ring and the stepped flow are two registers of one chain, so exactly one
  // may be displayed at a time. Without these rules the reader — and any
  // screen reader — would meet the same eight links twice in a row.
  const css = readFileSync(path.join(siteRoot, "assets", "research.css"), "utf8");
  assert.match(css, /@media \(min-width: 1080px\)[^}]*\{\s*\.flywheel ~ \.causal-flow \{ display: none; \}/);
  assert.match(css, /@media \(max-width: 1079px\)[^}]*\{\s*\.flywheel \{ display: none; \}/);
  // Paper is 673px of content at A4; the ring needs about 970px.
  assert.match(css, /\.flywheel \{ display: none !important; \}/);
  assert.match(css, /\.flywheel ~ \.causal-flow \{ display: block !important; \}/);
});

test("valuation scenario detail pairs stay on the definition-list grid", () => {
  const css = readFileSync(
    path.join(repoRoot, "apps", "web", "public", "assets", "research.css"),
    "utf8",
  );

  // Current snapshots wrap each dt/dd pair so React can key the component.
  // The wrapper must not become a grid item itself: that would place the whole
  // first component in the fixed 52px label column and wrap CJK text vertically.
  assert.match(
    css,
    /\.scenario-grid dl > div\s*\{\s*display:\s*contents;?\s*\}/,
  );
});

test("the site index covers exactly the companies that have a research snapshot", () => {
  publishSite();

  const companies = listSnapshotCompanies();
  const indexPath = path.join(siteRoot, "index.html");
  const indexHtml = readFileSync(indexPath, "utf8");

  const linked = [...indexHtml.matchAll(/href=["']\.\/companies\/([^"'/]+)\.html["']/g)]
    .map((match) => match[1]);
  // Both directions: no researched company missing from the index, and no card
  // pointing at a company that no longer has a snapshot.
  assert.deepEqual(
    [...linked].sort(),
    companies,
    "index company cards drifted from the companies that have snapshots",
  );
  assert.equal(new Set(linked).size, linked.length, "a company is carded twice");
  assertLocalReferencesResolve(indexHtml, indexPath, "site index");

  // Ordering is asserted as an invariant over the dates the cards actually
  // print, not by re-running the page's comparator: newest first, and companies
  // sharing a date always in the same order so the build stays reproducible.
  const cards = [...indexHtml.matchAll(
    /href=["']\.\/companies\/([^"'/]+)\.html["'][\s\S]*?<time>(\d{4}-\d{2}-\d{2})<\/time>/g,
  )].map(([, companyId, shownDate]) => ({ companyId, shownDate }));
  assert.equal(cards.length, companies.length, "a card is missing its research date");
  for (const { companyId, shownDate } of cards) {
    assert.equal(
      shownDate,
      listCompanySnapshots(companyId).at(-1).data.snapshot.dataCutoff.slice(0, 10),
      `${companyId} card shows a date other than its latest data cutoff`,
    );
  }
  for (let index = 1; index < cards.length; index += 1) {
    const previous = cards[index - 1];
    const current = cards[index];
    assert.ok(
      previous.shownDate > current.shownDate ||
        (previous.shownDate === current.shownDate &&
          previous.companyId < current.companyId),
      `index cards are out of order at ${previous.companyId} → ${current.companyId}`,
    );
  }

  for (const companyId of companies) {
    const latest = listCompanySnapshots(companyId).at(-1).data;
    const { company, summary, snapshot } = latest;
    // What a card can say depends on the contract its latest snapshot was written
    // under. A 1.2.0 card leads with what the company costs; the frozen ones keep
    // the stance and fair value they published with.
    const contractFragments = latest.schemaVersion === "1.2.0"
      ? [summary.businessModel, formatMarketCap(summary.marketCap)]
      : [summary.stance, formatPrice(summary.fairValue.low, summary.fairValue.currency), summary.fairValue.high];
    for (const fragment of [
      company.name,
      company.ticker,
      // The research cutoff and the price timestamp are different facts; the
      // card must not let the reader read the older price as same-day.
      snapshot.dataCutoff.slice(0, 10),
      summary.referencePrice.asOf.slice(0, 10),
      formatPrice(summary.referencePrice.value, summary.referencePrice.currency),
      ...contractFragments,
    ]) {
      assert.match(
        indexHtml,
        new RegExp(escapeRegExp(fragment)),
        `index card for ${companyId} is missing ${fragment}`,
      );
    }
  }

  // The single-company pilot framing is no longer true. Scoped to the retired
  // copy: a company's stance may legitimately mention a 试点 of its own.
  assert.doesNotMatch(indexHtml, /网易云音乐研究试点/);
  assert.doesNotMatch(indexHtml, /跨公司汇总与筛选将在后续阶段单独设计/);

  // Nothing but the COVERAGE label sits between the page header and the cards:
  // a section heading here costs 132px of the fold on a laptop.
  assert.match(indexHtml, /section-kicker[^>]*>COVERAGE</);
  assert.doesNotMatch(indexHtml, /<h2[^>]*>研究覆盖<\/h2>/);
  // The currency caveat still ships, below the cards — outside the grid, not
  // tucked into a card — where it doubles as the peek that invites scrolling.
  assert.match(
    indexHtml,
    /<\/a><\/div><p class="coverage-note">[^<]*不做汇率换算/,
    "the currency caveat must directly follow the closed card grid",
  );
});

/**
 * The structural labels 1.2.0 removed. Each was emitted by the renderer, not
 * written by an author, so their absence is a property of the code rather than of
 * one snapshot's prose — and their reappearance would mean a render path came back.
 *
 * Author prose is deliberately out of scope: a snapshot may legitimately quote a
 * sell-side note that uses the words "合理价值", and a checker that banned the
 * phrase outright would be policing quotations rather than the contract.
 */
const REMOVED_LABELS = [
  "当前判断",
  "安全边际",
  "最强证据",
  "最大风险",
  "我的假设",
  "深度价值区",
  "基础仓位区",
  "小仓观察区",
  "兑现要求区",
];

/**
 * Arms itself on the first real 1.2.0 page.
 *
 * There is no 1.2.0 snapshot committed yet — the four covered companies each need
 * a fresh research run against the new contract — so today this asserts on the
 * frozen generations only. That is stated rather than hidden: the moment a 1.2.0
 * snapshot lands, this test starts checking that its page carries none of the
 * labels ADR-0021 removed, without anyone remembering to switch it on.
 */
test("a 1.2.0 page carries none of the labels the contract removed", () => {
  publishSite();

  const pages = listSnapshotCompanies().flatMap((companyId) =>
    listCompanySnapshots(companyId)
      .filter((snapshot) => snapshot.data.schemaVersion === "1.2.0")
      .map((snapshot) => ({
        companyId,
        stem: snapshot.stem,
        html: readFileSync(
          path.join(siteRoot, "companies", companyId, "reports", `${snapshot.stem}.html`),
          "utf8",
        ),
      })),
  );

  for (const page of pages) {
    for (const label of REMOVED_LABELS) {
      assert.ok(
        !page.html.includes(label),
        `${page.companyId}/${page.stem} still renders the removed label 「${label}」`,
      );
    }
    // And it must carry what replaced them.
    assert.match(page.html, /市值/, `${page.companyId}/${page.stem} must open with market cap`);
    assert.match(page.html, /没有哪一组被标为基准/, `${page.companyId}/${page.stem} must say no seat is primary`);
  }

  // Frozen pages keep every label they published with; that is the whole point of
  // freezing them, so assert it rather than leaving it to chance.
  const frozenReport = readFileSync(
    path.join(siteRoot, "companies", pilotCompany, "reports", "2026-08-03-2230-analysis.html"),
    "utf8",
  );
  assert.match(frozenReport, /当前判断/);
  assert.match(frozenReport, /基础仓位区/);
});

test("publishes every structured company snapshot as auditable static HTML", () => {
  publishSite();

  const companies = listSnapshotCompanies();
  assert.ok(companies.includes(pilotCompany), "missing the Cloud Music pilot");

  for (const companyId of companies) {
    const snapshots = listCompanySnapshots(companyId);
    const companyPath = path.join(siteRoot, "companies", `${companyId}.html`);
    assert.equal(existsSync(companyPath), true, `missing company page: ${companyId}`);
    const companyHtml = readFileSync(companyPath, "utf8");
    const latest = snapshots.at(-1);
    const latestHash = createHash("sha256").update(latest.source).digest("hex");
    assert.match(companyHtml, new RegExp(`name=["']research-snapshot-sha256["'][^>]+content=["']${latestHash}["']`));
    assert.match(companyHtml, /name=["']research-publication-version["'][^>]+content=["']0\.1\.0["']/);
    assertLocalReferencesResolve(companyHtml, companyPath, `${companyId} company page`);

    for (const snapshot of snapshots) {
      assert.ok(["1.0.0", "1.1.0", "1.2.0"].includes(snapshot.data.schemaVersion));
      assert.ok(snapshot.data.driverMetrics.every((driver) =>
        driver.definitionVersion && driver.periodType && driver.accountingBasis,
      ));
      assert.ok(snapshot.data.financialHistory.every((period) =>
        period.periodType &&
        period.accountingBasis &&
        period.revenue?.value !== undefined &&
        period.revenue?.unit &&
        period.revenue?.scale &&
        Number.isInteger(period.revenue?.precision),
      ));

      const reportPath = path.join(
        siteRoot,
        "companies",
        companyId,
        "reports",
        `${snapshot.stem}.html`,
      );
      assert.equal(existsSync(reportPath), true, `missing report: ${companyId}/${snapshot.stem}`);
      const reportHtml = readFileSync(reportPath, "utf8");
      const expectedHash = createHash("sha256").update(snapshot.source).digest("hex");
      assert.match(reportHtml, new RegExp(`<meta[^>]+name=["']research-snapshot-sha256["'][^>]+content=["']${expectedHash}["']`));
      assert.match(reportHtml, /<meta[^>]+name=["']research-publication-version["'][^>]+content=["']0\.1\.0["']/);
      // The heading changed with the contract: 1.2.0 asks what moves the
      // business, not what moves a judgment it no longer publishes.
      if (snapshot.data.schemaVersion === "1.2.0") {
        assert.match(reportHtml, /什么会让基本面向上/);
        assert.match(reportHtml, /什么会让基本面向下/);
      } else {
        assert.match(reportHtml, /什么会提高当前判断/);
        assert.match(reportHtml, /什么会降低当前判断/);
      }
      assert.match(reportHtml, /核心经营驱动实际值/);
      assertLocalReferencesResolve(reportHtml, reportPath, `${companyId}/${snapshot.stem}`);
    }

    const publishedReports = readdirSync(
      path.join(siteRoot, "companies", companyId, "reports"),
    ).filter((name) => name.endsWith(".html")).sort();
    assert.deepEqual(
      publishedReports,
      snapshots.map(({ stem }) => `${stem}.html`).sort(),
      `published report set drifted for ${companyId}`,
    );
  }

  const publishedCompanyPages = readdirSync(path.join(siteRoot, "companies"))
    .filter((name) => name.endsWith(".html"))
    .sort();
  assert.deepEqual(
    publishedCompanyPages,
    companies.map((companyId) => `${companyId}.html`),
    "published company pages drifted from snapshot companies",
  );

  for (const asset of [
    "assets/research.css",
    "assets/research.js",
    "assets/fonts/InterVariable.woff2",
    "assets/fonts/LICENSE.txt",
  ]) {
    assert.equal(existsSync(path.join(siteRoot, asset)), true, `missing ${asset}`);
  }

  const pilotSnapshots = listCompanySnapshots(pilotCompany);
  const companyHtml = readFileSync(
    path.join(siteRoot, "companies", `${pilotCompany}.html`),
    "utf8",
  );
  // The company page leads with how the money is made and where the company
  // stands, then the same-basis financials — see ADR-0016.
  assert.match(companyHtml, /当前研究/);
  assert.match(companyHtml, /商业模式/);
  assert.match(companyHtml, /行业地位/);
  assert.match(companyHtml, /最新财报对比/);
  assert.match(companyHtml, /核心驱动与最紧约束/);
  assert.match(companyHtml, /相对上次研究/);
  assert.match(companyHtml, /商业模式变化/);
  assert.match(companyHtml, /新增证据/);
  assert.match(companyHtml, /被替换的旧假设/);

  const latestData = pilotSnapshots.at(-1).data;
  if (latestData.schemaVersion === "1.1.0") {
    // Both share denominators are mandatory, and the divergence between them is
    // the finding the block exists to surface.
    for (const measure of latestData.marketPosition.measures) {
      assert.match(companyHtml, new RegExp(escapeRegExp(measure.label)));
      assert.match(companyHtml, new RegExp(escapeRegExp(measure.marketDefinition)));
    }
    for (const segment of latestData.businessModel.segments) {
      assert.match(companyHtml, new RegExp(escapeRegExp(segment.name)));
      assert.match(companyHtml, new RegExp(escapeRegExp(segment.payer)));
    }
    // The causal chain renders as a stepped flow, one node per mandated link,
    // and no link is dropped or truncated on the way into the markup.
    const links = latestData.businessModel.causalChain
      .split("→")
      .map((link) => link.trim().replace(/[。；;]+$/, "").trim())
      .filter((link) => link.length > 0);
    if (links.length >= 2) {
      assert.match(companyHtml, /class="causal-flow"/);
      for (const link of links) {
        assert.match(companyHtml, new RegExp(escapeRegExp(link)));
      }
      assert.equal(
        (companyHtml.match(/class="causal-step"/g) ?? []).length,
        links.length,
        "阶梯流的节点数必须等于因果链解析出的环节数",
      );
    }
    // The cash-engine waterfall appears only when segment operating profit is
    // recorded, and when it does its arithmetic must close: segment sum less
    // unallocated cost equals the period's operating profit.
    const latestPeriod = latestData.financialHistory.at(-1);
    const priced = (latestPeriod.segments ?? []).filter((item) => item.operatingProfit);
    if (priced.length > 0 && latestPeriod.operatingMargin) {
      assert.match(companyHtml, /class="decision-chart cash-waterfall"/);
      const segmentSum = priced.reduce((sum, item) => sum + Number(item.operatingProfit.value), 0);
      const operatingProfit =
        (Number(latestPeriod.revenue.value) * Number(latestPeriod.operatingMargin.value)) / 100;
      const digits = priced[0].operatingProfit.precision;
      assert.match(companyHtml, new RegExp(escapeRegExp(segmentSum.toFixed(digits))));
      assert.match(companyHtml, new RegExp(escapeRegExp(operatingProfit.toFixed(digits))));
      // Charts stay inline SVG per ADR-0004: no runtime, no external fetch.
      assert.doesNotMatch(companyHtml, /<canvas/);
    } else {
      assert.doesNotMatch(companyHtml, /cash-waterfall/);
    }
    // The three-column model grid is gone; its prose now reads top-to-bottom.
    assert.doesNotMatch(companyHtml, /class="model-grid"/);
    assert.ok(containsProse(companyHtml, latestData.businessModel.cashEngine), "缺少现金引擎正文");
    assert.ok(containsProse(companyHtml, latestData.businessModel.deliveryDependency), "缺少交付依赖正文");
    // Metric definitions are reachable without any client runtime.
    assert.match(companyHtml, /popover=/);
    assert.doesNotMatch(companyHtml, /onclick=/);
    // The valuation the page shows must be the one the engine computed.
    const base = latestData.valuation.scenarios.find((item) => item.name === "基准");
    assert.equal(latestData.summary.fairValue.low, base.computed.low);
    assert.equal(latestData.summary.fairValue.high, base.computed.high);
    assert.match(companyHtml, new RegExp(escapeRegExp(base.computed.center)));
    // Action zones tile the price line without overlapping or leaving a gap.
    const zones = latestData.valuation.actionZones;
    for (let index = 1; index < zones.length; index += 1) {
      assert.equal(zones[index].rangeLow, zones[index - 1].rangeHigh);
    }
    assert.equal(zones.at(0).rangeLow, null);
    assert.equal(zones.at(-1).rangeHigh, null);
    // A blocked ideal method must tell the reader what would unblock it.
    if (latestData.valuation.methodSelection.blockedBy.length > 0) {
      assert.match(companyHtml, /可以把估值升级为/);
      for (const item of latestData.valuation.methodSelection.blockedBy) {
        assert.match(companyHtml, new RegExp(escapeRegExp(item.dataItem)));
      }
    }
  }

  // Derived from the data, not pinned to a particular pair of snapshots: the
  // company page always compares the two most recent ones, so publishing a new
  // snapshot legitimately changes which values appear here.
  const [priorSnapshot, currentSnapshot] = pilotSnapshots.slice(-2);
  for (const snapshot of [priorSnapshot, currentSnapshot]) {
    const { referencePrice, stance, businessModelChange } = snapshot.data.summary;
    assert.match(companyHtml, new RegExp(escapeRegExp(`HK$${referencePrice.value}`)));
    assert.match(companyHtml, new RegExp(escapeRegExp(stance)));
    assert.match(companyHtml, new RegExp(escapeRegExp(businessModelChange)));
    assert.match(companyHtml, new RegExp(escapeRegExp(snapshot.data.snapshot.dataCutoff.slice(0, 10))));
  }

  // A driver that exists in only one of the compared snapshots must be rendered
  // as not-comparable rather than silently omitted or shown as a delta.
  const priorDriverIds = new Set(priorSnapshot.data.driverMetrics.map((driver) => driver.id));
  const currentDriverIds = new Set(currentSnapshot.data.driverMetrics.map((driver) => driver.id));
  const onlyInOne = [...new Set([...priorDriverIds, ...currentDriverIds])].filter(
    (id) => !priorDriverIds.has(id) || !currentDriverIds.has(id),
  );
  if (onlyInOne.length > 0) {
    assert.match(companyHtml, /不可比较/);
  }
  for (const driver of currentSnapshot.data.driverMetrics) {
    assert.match(companyHtml, new RegExp(escapeRegExp(driver.label)));
  }

  for (const { stem } of pilotSnapshots) {
    assert.match(companyHtml, new RegExp(`reports/${stem}\\.html`));
  }

  const latestReportHtml = readFileSync(
    path.join(siteRoot, "companies", pilotCompany, "reports", `${pilotSnapshots.at(-1).stem}.html`),
    "utf8",
  );
  assert.match(latestReportHtml, /投资判断摘要/);
  assert.match(latestReportHtml, /商业模式与核心驱动/);
  assert.match(latestReportHtml, /已查阅资料/);
  assert.match(latestReportHtml, /<details>/);
  assert.match(latestReportHtml, /href=["']#source-/);
  assert.match(latestReportHtml, /target=["']_blank["'][^>]+rel=["']noreferrer["']/);
  assert.match(latestReportHtml, /calculation/);
  assert.match(latestReportHtml, /inference/);
  assert.match(latestReportHtml, /<svg[^>]+role=["']img["']/);
  assert.match(latestReportHtml, /财务趋势/);
  assert.match(latestReportHtml, /核心驱动趋势/);
  assert.match(latestReportHtml, /利润率与资本回报/);
  assert.match(latestReportHtml, /估值情景/);
  assert.match(latestReportHtml, /指标释义/);
  assert.match(
    latestReportHtml,
    new RegExp(escapeRegExp(pilotSnapshots.at(-1).data.summary.fairValue.low)),
  );
  assert.match(latestReportHtml, /\.\.\/\.\.\/\.\.\/assets\/research\.css/);
  assert.doesNotMatch(latestReportHtml, /(?:src|href)=["']\//);
  assert.doesNotMatch(latestReportHtml, /__next_f|\/_next\//);
});
