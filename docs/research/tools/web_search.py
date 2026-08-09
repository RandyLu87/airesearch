#!/usr/bin/env python3
"""研究检索工具 — Tavily Search API，零外部依赖（仅 stdlib）。

为研究流程第 1 步「定性维度采集」与第 2 步「Evidence Agent 取证」提供检索能力。
设计原则：与 cnstock_data.py / twstock_data.py 同风格，把检索纪律固化在代码里，
不依赖调用方每次记得手工加参数。

数据源：Tavily Search API (api.tavily.com)。key 只存本机，严禁提交到 git，
按以下优先级读取：
    1. 环境变量 TAVILY_API_KEY
    2. 本地文件 ~/.config/tavily/token
    3. 仓库根目录 .env 里的 TAVILY_API_KEY=（.env 已在 .gitignore）

用法：
    python3 docs/research/tools/web_search.py "快手 2025Q3 收入 同比"
    python3 docs/research/tools/web_search.py "AMD FY2025 data center revenue" --official us
    python3 docs/research/tools/web_search.py "理想汽车 毛利率" --official hk --cutoff 2026-08-07
    python3 docs/research/tools/web_search.py "…" --domains ir.kuaishou.com,hkexnews.hk
    python3 docs/research/tools/web_search.py "…" --full   # 附正文 markdown，供数字回原文核对

## 为什么不用 Tavily 的 include_answer

2026-08-09 A/B 探针实测：14 条查询里 **3 条（21%）的 LLM 摘要含编造或错误数字，
而同一次返回的 results 原文是正确的**——

    - 中国平安归母净利润：摘要写 "about 1.44 billion yuan"（混淆了扣非净利润
      1437.73 亿，且「亿」被错译成 billion），首条来源原文写的是「归母净利润1,348亿元」；
    - 中国保险业 CAGR：摘要凭空给出「2026-2030 CAGR 7.3%、7.5万亿→11万亿」，
      8 条来源里没有任何一条含这些数字；
    - 中国稀土集团：摘要凭空添加「约占整体产值 30% 市场份额」，来源无支撑。

带出处外观的假数字比诚实的 unavailable 有害得多，且直接违反 AGENTS.md
「无出处的数字不接受」「禁止 LLM 心算」。因此本工具**硬编码 include_answer=False**，
只返回检索结果原文片段与 URL，数字判断一律由调用方读原文后自行做出。
这一条不提供开关——能被参数打开的禁令等于没有禁令。

## --cutoff 的真实作用范围（实测，勿当成闸门）

2026-08-09 实测：Tavily 的 end_date **只在 topic=news 下真正生效**。
默认的 topic=general 返回的结果不带 published_date，end_date 形同虚设——
以 --cutoff 2026-08-09 检索「快手 2026年第二季度中期业绩」，general 下仍返回
8-19 才发布的业绩预告页，加 --news 后结果全部收敛到 8-06 及以前。

因此 --cutoff **不是数据截止日的保证**，只是 --news 模式下的一道过滤。
截止日纪律仍须由调用方读原文时点自行把关。工具在不生效的组合下会显式提示，
不假装自己挡住了——一个看起来有保证、实际没有的过滤器比没有过滤器更危险。

## 配额

advanced 检索 2 credits/次，免费额度 1000 credits/月（约合 8 家公司的研究量）。
key 缺失或 API 失败时以退出码 3 返回，调用方应降级到原生 WebSearch 继续，
不因检索后端不可用而中断研究。

需要 Python >= 3.8，零外部依赖。
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

_API = "https://api.tavily.com/search"
_TIMEOUT = 90
_TOKEN_FILE = os.path.expanduser("~/.config/tavily/token")
_TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(_TOOLS_DIR)))

# 各市场的 Official（一手披露）域名。与 docs/model/financial-data.md 的
# 来源优先级表对应：--official 把检索限定在这些域名内，用于 Level 1 数据点
# 需最终核实、或交叉验证出现 >5% 重大差异时直接回原文。
OFFICIAL_DOMAINS = {
    "hk": ["hkexnews.hk", "hkex.com.hk"],
    "cn": ["cninfo.com.cn", "sse.com.cn", "szse.cn"],
    "us": ["sec.gov", "sec.report"],
    "tw": ["mops.twse.com.tw", "twse.com.tw"],
}

# 内容农场与聚合站：数字常被二次转述且不标时点，作为来源不满足
# 「名称 + URL + 时点」的硬要求。默认排除，避免占满 8 条结果位。
_NOISE_DOMAINS = [
    "baike.baidu.com",
    "zhidao.baidu.com",
    "wenku.baidu.com",
    "163.com",
    "sohu.com",
]


def _key():
    """读取 Tavily key：环境变量 → 本地 token 文件 → 仓库 .env。"""
    k = os.environ.get("TAVILY_API_KEY", "").strip()
    if k:
        return k
    try:
        with open(_TOKEN_FILE, encoding="utf-8") as f:
            k = f.read().strip()
            if k:
                return k
    except OSError:
        pass
    try:
        with open(os.path.join(_REPO_ROOT, ".env"), encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("TAVILY_API_KEY="):
                    return line.split("=", 1)[1].strip().strip("'\"")
    except OSError:
        pass
    return ""


def search(query, *, max_results=8, official=None, domains=None,
           exclude=None, cutoff=None, since=None, topic="general",
           full_text=False, depth="advanced"):
    """执行一次检索，返回 Tavily 原始响应（已剥离 answer 字段）。

    official  市场代码（hk/cn/us/tw），把结果限定在该市场的一手披露域名内
    domains   显式域名白名单，与 official 合并
    cutoff    数据截止日期（YYYY-MM-DD），映射为 end_date。**只在 topic="news"
              下真正生效**（见模块 docstring 的实测记录），general 下不构成保证
    full_text 附正文 markdown，供数字回原文核对（不额外计费）
    """
    key = _key()
    if not key:
        raise RuntimeError(
            "未找到 TAVILY_API_KEY。请设置环境变量，或写入 ~/.config/tavily/token，"
            "或在仓库根目录 .env 中写 TAVILY_API_KEY=…（.env 已在 .gitignore）。"
        )

    include = list(domains or [])
    if official:
        if official not in OFFICIAL_DOMAINS:
            raise ValueError(
                "--official 只接受 %s" % "/".join(sorted(OFFICIAL_DOMAINS))
            )
        include += OFFICIAL_DOMAINS[official]

    payload = {
        "query": query,
        "search_depth": depth,
        "max_results": max_results,
        "chunks_per_source": 3,
        "topic": topic,
        "include_usage": True,
        # 硬禁令，见模块 docstring：只取原文，不取 LLM 摘要。
        "include_answer": False,
    }
    if include:
        payload["include_domains"] = include
    payload["exclude_domains"] = list(exclude or []) + _NOISE_DOMAINS
    if cutoff:
        payload["end_date"] = cutoff
    if since:
        payload["start_date"] = since
    if full_text:
        payload["include_raw_content"] = "markdown"

    req = urllib.request.Request(
        _API,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer %s" % key,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise RuntimeError("Tavily HTTP %s：%s" % (e.code, detail))
    except (urllib.error.URLError, TimeoutError) as e:
        raise RuntimeError("Tavily 请求失败：%s" % e)

    # 即便未来 API 默认行为变化，也不让摘要漏到调用方手上。
    data.pop("answer", None)
    return data


def _render(data, query, full_text=False, cutoff=None, topic="general"):
    """人读格式。每条结果给出「名称 + URL + 片段」，满足出处三要素中的前两项；
    时点必须由调用方从片段或原文中读出，工具不代为推断。"""
    results = data.get("results") or []
    usage = (data.get("usage") or {}).get("credits")
    lines = [
        "检索：%s" % query,
        "结果 %d 条%s" % (len(results),
                          "（本次消耗 %s credits）" % usage if usage else ""),
        "",
        "⚠️  以下均为来源原文片段，不是结论。数字须回原文核对时点与口径后方可采用；",
        "    本工具不提供 LLM 摘要（理由见脚本 docstring 的实测记录）。",
    ]
    if cutoff and topic != "news":
        lines.append(
            "⚠️  --cutoff %s 在本次（topic=general）**未生效**：结果不带发布日期，"
            "无法按日过滤。\n    要真正按截止日过滤请加 --news；否则请自行核对每条来源的时点。"
            % cutoff
        )
    lines.append("")
    for i, r in enumerate(results, 1):
        lines.append("[%d] %s" % (i, r.get("title") or "(无标题)"))
        lines.append("    URL   : %s" % r.get("url"))
        lines.append("    相关度: %.3f" % (r.get("score") or 0))
        if r.get("published_date"):
            lines.append("    发布  : %s" % r["published_date"])
        content = (r.get("content") or "").replace("\n", " ").strip()
        lines.append("    片段  : %s" % content[:600])
        if full_text and r.get("raw_content"):
            lines.append("    正文  : %s" % r["raw_content"][:2000].replace("\n", " "))
        lines.append("")
    if not results:
        lines.append("（无结果。请换关键词重试一次；仍无结果按 unavailable + reason 收敛，"
                     "写明已查范围，不要恋战——见 02-multi-dimension-analysis.md 检索纪律。）")
    return "\n".join(lines)


def main():
    p = argparse.ArgumentParser(
        description="研究检索（Tavily）。只返回来源原文片段，不返回 LLM 摘要。",
    )
    p.add_argument("query", help="检索词")
    p.add_argument("-n", "--max-results", type=int, default=8,
                   help="结果条数，默认 8（上限 20）")
    p.add_argument("--official", choices=sorted(OFFICIAL_DOMAINS),
                   help="限定在该市场的一手披露域名（hk=披露易 / cn=巨潮+交易所 / us=SEC / tw=MOPS）")
    p.add_argument("--domains", help="额外域名白名单，逗号分隔")
    p.add_argument("--exclude", help="额外域名黑名单，逗号分隔")
    p.add_argument("--cutoff",
                   help="数据截止日 YYYY-MM-DD。仅在配合 --news 时真正生效（实测），"
                        "普通检索下不构成截止日保证")
    p.add_argument("--since", help="起始日 YYYY-MM-DD")
    p.add_argument("--news", action="store_true", help="按新闻检索（时效性话题）")
    p.add_argument("--full", action="store_true", help="附正文 markdown，供回原文核对")
    p.add_argument("--json", action="store_true", help="输出原始 JSON")
    args = p.parse_args()

    split = lambda s: [x.strip() for x in s.split(",") if x.strip()] if s else None
    try:
        data = search(
            args.query,
            max_results=min(args.max_results, 20),
            official=args.official,
            domains=split(args.domains),
            exclude=split(args.exclude),
            cutoff=args.cutoff,
            since=args.since,
            topic="news" if args.news else "general",
            full_text=args.full,
        )
    except (RuntimeError, ValueError) as e:
        sys.stderr.write("错误：%s\n" % e)
        sys.stderr.write("→ 降级：改用原生 WebSearch 继续，不要因检索后端不可用中断研究。\n")
        sys.exit(3)

    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(_render(data, args.query, full_text=args.full,
                      cutoff=args.cutoff,
                      topic="news" if args.news else "general"))


if __name__ == "__main__":
    main()
