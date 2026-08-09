import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "../..");
const source = path.join(appRoot, "out");
const target = path.join(repoRoot, "research", "site");

await rm(target, { recursive: true, force: true });
await mkdir(path.dirname(target), { recursive: true });
await cp(source, target, { recursive: true });

// 样式在发布时内联进每个 HTML，而不是留一个 <link> 去单独请求 research.css。
// 站点部署在 GitHub Pages，大陆访问经常出现「HTML 到了、CSS 被重置」——首页 gzip 后
// 不到 2 KB 一个往返就完事，CSS 要 14 KB 多个往返，于是页面裸奔。内联后只要 HTML 到了
// 样式就一定在，代价是每页多十几 KB，且 4 个公司页之间无法共享 CSS 缓存——这个站规模
// 小，这笔交易划算。开发态（next dev）仍然走 <link>，页面组件里的标签不动。
const inlineCss = await readFile(path.join(target, "assets", "research.css"), "utf8");

async function cleanDirectory(directory) {
  const entries = await readdir(directory);
  for (const entry of entries) {
    const filePath = path.join(directory, entry);
    const info = await stat(filePath);
    if (info.isDirectory()) {
      if (entry === "_next" || entry.startsWith("__next")) {
        await rm(filePath, { recursive: true, force: true });
        continue;
      }
      await cleanDirectory(filePath);
      if ((await readdir(filePath)).length === 0) {
        await rm(filePath, { recursive: true, force: true });
      }
      continue;
    }
    if (
      filePath.endsWith(".txt") &&
      !filePath.includes(`${path.sep}assets${path.sep}`)
    ) {
      await rm(filePath, { force: true });
      continue;
    }
    // 资源目录里的 .md 是给维护者看的（例如字体子集化说明），不属于站点内容。
    if (filePath.endsWith(".md")) {
      await rm(filePath, { force: true });
      continue;
    }
    if (!filePath.endsWith(".html")) continue;

    // CSS 里的相对 URL 原本相对 assets/research.css 解析，内联进 HTML 后改为相对文档解析，
    // 必须按该页所在层级重写，否则 companies/*.html 会去找 companies/fonts/ 而拿不到字体。
    const depth = path
      .relative(target, path.dirname(filePath))
      .split(path.sep)
      .filter(Boolean).length;
    const toAssets = `${depth === 0 ? "./" : "../".repeat(depth)}assets/`;
    const scopedCss = inlineCss.replace(/url\((["']?)\.\//g, `url($1${toAssets}`);

    const html = await readFile(filePath, "utf8");
    const staticHtml = html
      .replace(/<link\b[^>]+href=["']\/_next\/[^>]*>/g, "")
      // 干掉 research.css 的 preload 与 stylesheet 两个标签，改为在 </head> 前内联。
      // 放进 head 顺带修掉了原先 <link> 落在 <body> 里带来的 FOUC。
      .replace(/<link\b[^>]*href=["'][^"']*assets\/research\.css["'][^>]*>/g, "")
      .replace("</head>", `<style>${scopedCss}</style></head>`)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, (script) =>
        /^<script\b[^>]+src=["'][^"']*assets\/research\.js["']/.test(script)
          ? script
          : "",
      )
      .replace(/<div hidden="">[\s\S]*?<\/div>/g, "")
      .replace(/<!--\s*-->|<!--\$-->|<!--\/\$-->|<!--\$\?-->|<!--\$!-->/g, "")
      .replace(/<link\b[^>]+rel=["']preload["'][^>]+as=["']script["'][^>]*>/g, "");
    await writeFile(filePath, staticHtml);
  }
}

await cleanDirectory(target);
await rm(path.join(target, "404.html"), { force: true });
await rm(path.join(target, "_not-found.html"), { force: true });
// 公司分析路由在没有任何 financials-final.json 时用哨兵参数占位（output: export
// 不接受空静态参数表），哨兵页不属于站点内容，拷贝后删除。
await rm(path.join(target, "companies", "__no-analysis__.html"), { force: true });
await rm(path.join(target, "companies", "__no-analysis__"), { recursive: true, force: true });
