# InterVariable.woff2

站点唯一的自托管字体，来源是 devDependency `@fontsource-variable/inter`（见根 `package.json`）。

`InterVariable.woff2` **不是上游原件，是子集化后的产物**：48.3 KB → 25.8 KB，可变字重轴 `wght 100–900` 保留。
Inter 不含 CJK 字形，站点的中文本来就走 `PingFang SC` / `Microsoft YaHei`，因此上游字体里近半数字形对本站是无效载荷。
砍掉它们是为了让大陆弱网下这个子资源尽量小——它是页面上唯一还需要单独发请求的资源（CSS 已在发布时内联进 HTML）。

保留的范围覆盖基本拉丁、Latin-1 补充（`Nestlé`、`Ørsted` 这类公司名不会中途掉字体）、常用标点与数学符号。

## 重新生成

需要 `fonttools` 与 `brotli`（不进本仓库依赖，临时装即可）：

```sh
python3 -m venv /tmp/fontenv && /tmp/fontenv/bin/pip install fonttools brotli

/tmp/fontenv/bin/pyftsubset \
  node_modules/@fontsource-variable/inter/files/InterVariable.woff2 \
  --output-file=apps/web/public/assets/fonts/InterVariable.woff2 \
  --flavor=woff2 \
  --layout-features='' \
  --unicodes='U+0020-007E,U+00A0-00FF,U+2010-2027,U+2030,U+2032-2033,U+20AC,U+2190-2193,U+2212,U+2260,U+2264-2265' \
  --no-hinting --desubroutinize
```

改完跑 `npm run publish`，然后确认没有站点在用、但子集里缺失的字符。

`LICENSE.txt` 是 Inter 的 SIL Open Font License，子集化产物同样受其约束，不要删。
