#!/usr/bin/env python3
"""A股数据工具 — Tushare Pro API，零外部依赖（仅 stdlib）。

为研究流程第 1 步提供 A 股报表、财务指标、分部收入、行情估值、股东与高管数据。
设计原则：独立模块，与 twstock_data.py 同风格；把 Tushare 的数据陷阱固化在代码里，
不依赖调用方每次记得手工处理（规范正文见 docs/model/financial-data.md）。

数据源：Tushare Pro (api.tushare.pro)。token 只存本机，严禁提交到 git，
按以下优先级读取：
    1. 环境变量 TUSHARE_TOKEN
    2. 本地文件 ~/.config/tushare/token

用法：
    python3 docs/research/tools/cnstock_data.py quote 600519       # 行情 + 估值 + 市值验算
    python3 docs/research/tools/cnstock_data.py valuation 600519   # PE/PB/PS/股息率 + 一年区间
    python3 docs/research/tools/cnstock_data.py financials 600519  # 近5年核心财务（已去重）
    python3 docs/research/tools/cnstock_data.py segments 600519    # 分部收入（已剔除合计行）
    python3 docs/research/tools/cnstock_data.py holders 600519     # 十大股东 + 高管薪酬持股
    python3 docs/research/tools/cnstock_data.py price 600519 --adjust qfq --years 5
    python3 docs/research/tools/cnstock_data.py search 茅台         # 搜索股票代码

内置的三个 Tushare 陷阱处理（详见 docs/model/financial-data.md「数据陷阱」）：
    1. 同一 end_date 重复行 —— 按 update_flag 去重（优先取调整后 '1'）
    2. report_type 混杂多口径 —— 报表一律显式 report_type=1（合并报表）
    3. fina_mainbz 混入合计行 —— 剔除合计/调整行后再算占比，并与总收入对账

注意：
    - 金额单位：Tushare 报表接口为「元」；daily_basic 的 total_mv/circ_mv 为「万元」，
      total_share/float_share 为「万股」——本工具输出前已统一换算为「亿元 / 亿股」
    - n_income_attr_p = 归母净利润；n_income = 含少数股东损益。默认用归母，与东方财富口径一致
    - 需要 Python >= 3.8，零外部依赖
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date, timedelta

_API = "http://api.tushare.pro"
_TIMEOUT = 30
_TOKEN_FILE = os.path.expanduser("~/.config/tushare/token")

# fina_mainbz 的合计行标签：与 type 同名的行是「全部合计」，另有对账调整行
_AGG_LABELS = {"产品", "地区", "行业", "合计特别调整"}


def _token():
    """读取 Tushare token：环境变量优先，其次本地文件。"""
    t = os.environ.get("TUSHARE_TOKEN", "").strip()
    if t:
        return t
    try:
        with open(_TOKEN_FILE, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def _call(api, params, fields=""):
    """请求 Tushare API，返回 dict 列表。"""
    token = _token()
    if not token:
        raise ConnectionError(
            "未找到 TUSHARE_TOKEN。请 export TUSHARE_TOKEN=\"$(cat ~/.config/tushare/token)\""
        )
    body = json.dumps(
        {"api_name": api, "token": token, "params": params, "fields": fields}
    ).encode()
    req = urllib.request.Request(
        _API, data=body, headers={"Content-Type": "application/json"}
    )
    try:
        raw = urllib.request.urlopen(req, timeout=_TIMEOUT).read()
    except (urllib.error.URLError, OSError) as e:
        raise ConnectionError(f"Tushare 请求失败（{api}）：{e}")
    r = json.loads(raw)
    if r.get("code") != 0:
        msg = r.get("msg") or ""
        # 40203 同时用于「无权限」与「频率超限」，按 msg 区分，避免误判成来源不可用
        hint = "（频率超限，稍后重试或用缓存）" if "频率" in msg else "（无权限，改走其他来源）"
        raise ConnectionError(f"Tushare {api}: {msg} {hint}")
    d = r.get("data") or {}
    flds, items = d.get("fields") or [], d.get("items") or []
    return [dict(zip(flds, row)) for row in items]


def _ts_code(code):
    """把 6 位代码补全为带交易所后缀的 ts_code。已带后缀则原样返回。"""
    code = str(code).strip().upper()
    if "." in code:
        return code
    if not code.isdigit() or len(code) != 6:
        raise ValueError(f"无法识别的股票代码：{code}")
    if code[:3] in ("600", "601", "603", "605", "688", "689") or code[0] == "9":
        return f"{code}.SH"
    if code[:2] in ("43", "83", "87", "88", "82", "92"):
        return f"{code}.BJ"
    return f"{code}.SZ"


def _yi(value, unit="元"):
    """金额格式化为亿。unit='万元' 时先换算。"""
    if value in (None, ""):
        return "-"
    try:
        v = float(value)
    except (ValueError, TypeError):
        return str(value)
    if unit == "万元":
        v *= 1e4
    return f"{v / 1e8:,.1f}亿"


def _num(value, digits=2, suffix=""):
    if value in (None, ""):
        return "-"
    try:
        return f"{float(value):,.{digits}f}{suffix}"
    except (ValueError, TypeError):
        return str(value)


def _pct(a, b):
    """a/b 百分比，b 为 0 或缺失返回 None。"""
    try:
        a, b = float(a), float(b)
    except (ValueError, TypeError):
        return None
    return a / b * 100 if b else None


def _days_ago(n):
    return (date.today() - timedelta(days=n)).strftime("%Y%m%d")


def _today():
    return date.today().strftime("%Y%m%d")


def _dedupe_by_period(rows, key="end_date"):
    """陷阱 1：同一报告期可能返回多行（update_flag 0=原始 / 1=调整后）。

    按 end_date 分组，优先保留 update_flag='1'；同组数值不一致时标记为追溯调整。
    返回 (去重后按期倒序的列表, 发生追溯调整的报告期列表)。
    """
    groups = {}
    for r in rows:
        groups.setdefault(r.get(key), []).append(r)

    kept, restated = [], []
    for period, grp in groups.items():
        if len(grp) > 1:
            flags = {str(g.get("update_flag")) for g in grp}
            # 数值是否真的不同（只比较数值型字段）
            sigs = set()
            for g in grp:
                sigs.add(
                    tuple(
                        str(g.get(k))
                        for k in sorted(g)
                        if k not in ("update_flag", "ann_date", "f_ann_date")
                    )
                )
            if len(sigs) > 1 and "1" in flags:
                restated.append(period)
        chosen = next((g for g in grp if str(g.get("update_flag")) == "1"), grp[0])
        kept.append(chosen)

    kept.sort(key=lambda r: str(r.get(key) or ""), reverse=True)
    return kept, restated


def _statement(api, ts, start, end, fields):
    """取一张报表（按公告日期区间）：陷阱 2 —— 一律显式 report_type=1；再按陷阱 1 去重。

    陷阱 4：报表接口的 start_date / end_date 过滤的是**公告日期**，不是报告期。
    实测 600519：ann_date 区间 20200101~20260808 → 返回 end_date 20191231~20260331。
    所以要覆盖近 N 个财年，公告起点须再往前推 1 年（调用方已处理）。
    按报告期精确取单期请改用 _statement_period()。
    """
    rows = _call(
        api,
        {"ts_code": ts, "start_date": start, "end_date": end, "report_type": "1"},
        fields,
    )
    return _dedupe_by_period(rows)


def _statement_period(api, ts, period, fields):
    """按报告期精确取一期报表（用 period 参数，不用 start_date/end_date——见陷阱 4）。"""
    rows = _call(api, {"ts_code": ts, "period": period, "report_type": "1"}, fields)
    kept, _ = _dedupe_by_period(rows)
    return kept


def _annual_only(rows):
    return [r for r in rows if str(r.get("end_date", "")).endswith("1231")]


def _name(ts):
    rows = _call("stock_basic", {"ts_code": ts}, "ts_code,name,industry,market,list_date")
    return rows[0] if rows else {}


# ---------------------------------------------------------------------------
# 命令实现
# ---------------------------------------------------------------------------

def cmd_quote(code):
    """最新行情快照 + 市值验算。"""
    ts = _ts_code(code)
    info = _name(ts)
    basic = _call(
        "daily_basic",
        {"ts_code": ts, "start_date": _days_ago(20), "end_date": _today()},
        "ts_code,trade_date,close,pe,pe_ttm,pb,ps_ttm,dv_ttm,total_share,float_share,total_mv,circ_mv",
    )
    if not basic:
        print(f"❌ 未取到 {ts} 的行情数据（可能停牌或代码有误）")
        return
    b = sorted(basic, key=lambda r: r["trade_date"])[-1]

    print("=" * 60)
    print(f"{info.get('name', ts)}（{ts}） 行情快照")
    print("=" * 60)
    print(f"  交易日:      {b['trade_date']}")
    print(f"  收盘价:      {_num(b.get('close'))} 元")
    print(f"  总股本:      {_num(float(b['total_share']) / 1e4, 2)} 亿股" if b.get("total_share") else "  总股本:      -")
    print(f"  总市值:      {_yi(b.get('total_mv'), '万元')}")
    print(f"  流通市值:    {_yi(b.get('circ_mv'), '万元')}")
    print()
    print(f"  PE(静):      {_num(b.get('pe'))}    PE(TTM): {_num(b.get('pe_ttm'))}")
    print(f"  PB:          {_num(b.get('pb'))}    PS(TTM): {_num(b.get('ps_ttm'))}")
    print(f"  股息率(TTM): {_num(b.get('dv_ttm'))}%")

    # 市值验算：股价 × 总股本 vs 报告市值
    if b.get("close") and b.get("total_share") and b.get("total_mv"):
        calc = float(b["close"]) * float(b["total_share"]) * 1e4
        reported = float(b["total_mv"]) * 1e4
        dev = abs(calc - reported) / reported * 100 if reported else 0
        mark = "✅" if dev <= 1 else ("⚠️" if dev <= 5 else "❌")
        print()
        print(f"  市值验算:    {mark} 股价×总股本 = {_yi(calc)}，报告市值 = {_yi(reported)}，偏差 {dev:.2f}%")
    if b.get("pe_ttm") in (None, ""):
        print("  注: pe_ttm 为空通常表示亏损，不要当作 0 参与计算")


def cmd_valuation(code):
    """估值指标 + 近一年区间分位。"""
    ts = _ts_code(code)
    info = _name(ts)
    rows = _call(
        "daily_basic",
        {"ts_code": ts, "start_date": _days_ago(400), "end_date": _today()},
        "trade_date,close,pe_ttm,pb,ps_ttm,dv_ttm",
    )
    if not rows:
        print(f"❌ 未取到 {ts} 的估值数据")
        return
    rows.sort(key=lambda r: r["trade_date"])
    cur = rows[-1]

    print("=" * 60)
    print(f"{info.get('name', ts)}（{ts}） 估值指标")
    print("=" * 60)
    print(f"  数据区间:  {rows[0]['trade_date']} ~ {cur['trade_date']}（{len(rows)} 个交易日）")
    print()

    for label, key in [("PE(TTM)", "pe_ttm"), ("PB", "pb"), ("PS(TTM)", "ps_ttm"), ("股息率%", "dv_ttm")]:
        vals = [float(r[key]) for r in rows if r.get(key) not in (None, "")]
        if not vals:
            print(f"  {label:10s} -（无有效数据，亏损公司 PE 为空属正常）")
            continue
        cv = cur.get(key)
        cv = float(cv) if cv not in (None, "") else None
        lo, hi = min(vals), max(vals)
        pos = (cv - lo) / (hi - lo) * 100 if cv is not None and hi > lo else None
        pos_s = f"，一年分位 {pos:.0f}%" if pos is not None else ""
        print(f"  {label:10s} 当前 {_num(cv)}    区间 [{lo:,.2f}, {hi:,.2f}]{pos_s}")


def cmd_financials(code, years=5):
    """近 N 年核心财务：已按 report_type=1 过滤并按 update_flag 去重。"""
    ts = _ts_code(code)
    info = _name(ts)
    start = f"{date.today().year - years - 1}0101"
    end = _today()

    inc, inc_restated = _statement(
        "income", ts, start, end,
        "ts_code,end_date,update_flag,total_revenue,revenue,oper_cost,operate_profit,n_income,n_income_attr_p",
    )
    cfs, cfs_restated = _statement(
        "cashflow", ts, start, end,
        "ts_code,end_date,update_flag,n_cashflow_act,c_pay_acq_const_fiolta",
    )
    bal, bal_restated = _statement(
        "balancesheet", ts, start, end,
        "ts_code,end_date,update_flag,money_cap,total_liab,total_assets,total_hldr_eqy_exc_min_int",
    )
    ind_rows = _call(
        "fina_indicator",
        {"ts_code": ts, "start_date": start, "end_date": end},
        "ts_code,end_date,update_flag,grossprofit_margin,netprofit_margin,roe,roe_dt,debt_to_assets",
    )
    ind, _ = _dedupe_by_period(ind_rows)

    inc_a, cfs_a, bal_a, ind_a = map(_annual_only, (inc, cfs, bal, ind))
    cfs_map = {r["end_date"]: r for r in cfs_a}
    bal_map = {r["end_date"]: r for r in bal_a}
    ind_map = {r["end_date"]: r for r in ind_a}

    print("=" * 60)
    print(f"{info.get('name', ts)}（{ts}） 近 {years} 年核心财务")
    print("=" * 60)
    print("  口径: 合并报表(report_type=1)；净利润为归母(n_income_attr_p)；金额单位亿元")
    restated = sorted(set(inc_restated) | set(cfs_restated) | set(bal_restated))
    if restated:
        print(f"  ⚠️  以下报告期存在追溯调整，已取调整后数值: {', '.join(restated)}")
    print()
    header = f"  {'报告期':<10}{'营业总收入':>12}{'归母净利':>12}{'毛利率':>9}{'净利率':>9}{'ROE':>8}{'自由现金流':>13}{'货币资金':>12}"
    print(header)
    print("  " + "-" * (len(header) - 2))

    for r in inc_a[:years]:
        p = r["end_date"]
        c, bl, iv = cfs_map.get(p, {}), bal_map.get(p, {}), ind_map.get(p, {})
        # FCF = 经营活动现金流净额 - 购建固定资产等支付的现金
        fcf = None
        if c.get("n_cashflow_act") not in (None, "") and c.get("c_pay_acq_const_fiolta") not in (None, ""):
            fcf = float(c["n_cashflow_act"]) - float(c["c_pay_acq_const_fiolta"])
        # 毛利率优先用 fina_indicator，缺失时用 (收入-成本)/收入 回算
        gm = iv.get("grossprofit_margin")
        if gm in (None, "") and r.get("revenue") and r.get("oper_cost") not in (None, ""):
            gm = _pct(float(r["revenue"]) - float(r["oper_cost"]), r["revenue"])
        print(
            f"  {p:<10}{_yi(r.get('total_revenue')):>12}{_yi(r.get('n_income_attr_p')):>12}"
            f"{_num(gm, 1, '%'):>9}{_num(iv.get('netprofit_margin'), 1, '%'):>9}"
            f"{_num(iv.get('roe'), 1, '%'):>8}{_yi(fcf):>13}{_yi(bl.get('money_cap')):>12}"
        )

    print()
    print("  提示: 与东方财富交叉验证时，请确认对方展示的是「归母净利润」与「营业总收入」，口径不一致不要直接算误差率")


def cmd_segments(code, period=None):
    """分部收入：剔除合计/调整行后计算占比，并与利润表总收入对账。"""
    ts = _ts_code(code)
    info = _name(ts)

    if not period:
        # 公告日期区间往前推 2 年，确保覆盖到最近一个已披露年报
        inc, _ = _statement("income", ts, f"{date.today().year - 2}0101", _today(),
                            "ts_code,end_date,update_flag,total_revenue")
        ann = _annual_only(inc)
        if not ann:
            print("❌ 未取到年度利润表，无法确定最近财年")
            return
        period = ann[0]["end_date"]
        total_rev = ann[0].get("total_revenue")
    else:
        inc = _statement_period("income", ts, period,
                                "ts_code,end_date,update_flag,total_revenue")
        total_rev = inc[0].get("total_revenue") if inc else None

    print("=" * 60)
    print(f"{info.get('name', ts)}（{ts}） 分部收入 · {period}")
    print("=" * 60)

    for typ, label in (("P", "按产品"), ("D", "按地区")):
        rows = _call("fina_mainbz", {"ts_code": ts, "period": period, "type": typ})
        if not rows:
            print(f"\n  {label}: 无数据")
            continue
        # 陷阱 3：剔除合计行与对账调整行
        segs = [r for r in rows if str(r.get("bz_item", "")).strip() not in _AGG_LABELS]
        aggs = [r for r in rows if str(r.get("bz_item", "")).strip() in _AGG_LABELS]

        seg_sum = sum(float(r["bz_sales"]) for r in segs if r.get("bz_sales") not in (None, ""))
        base = seg_sum if seg_sum else None

        print(f"\n  {label}（已剔除 {len(aggs)} 行合计/调整行）")
        print(f"  {'分部':<16}{'收入':>12}{'占比':>9}{'毛利率':>9}")
        print("  " + "-" * 46)
        for r in sorted(segs, key=lambda x: -float(x.get("bz_sales") or 0)):
            sales = r.get("bz_sales")
            share = _pct(sales, base) if base else None
            # bz_profit 在多数标的上是「毛利」口径，用 (profit/sales) 作分部毛利率
            gm = _pct(r.get("bz_profit"), sales) if r.get("bz_profit") not in (None, "") else None
            print(f"  {str(r.get('bz_item'))[:15]:<16}{_yi(sales):>12}{_num(share, 1, '%'):>9}{_num(gm, 1, '%'):>9}")
        print("  " + "-" * 46)
        print(f"  {'分部合计':<16}{_yi(seg_sum):>12}")

        # 与利润表总收入对账
        if total_rev not in (None, "") and seg_sum:
            dev = abs(seg_sum - float(total_rev)) / float(total_rev) * 100
            mark = "✅" if dev <= 1 else ("⚠️" if dev <= 5 else "❌")
            print(f"  对账: {mark} 利润表营业总收入 {_yi(total_rev)}，差异 {dev:.2f}%")
            if dev > 1:
                extra = ", ".join(
                    f"{r.get('bz_item')}={_yi(r.get('bz_sales'))}" for r in aggs
                )
                print(f"        差异多来自被剔除的调整行（{extra}）或分部披露不完整——不要强行凑成 100%")


def cmd_holders(code):
    """十大股东 + 高管薪酬持股 + 股东户数。"""
    ts = _ts_code(code)
    info = _name(ts)
    print("=" * 60)
    print(f"{info.get('name', ts)}（{ts}） 股东与管理层")
    print("=" * 60)

    holders = _call(
        "top10_holders",
        {"ts_code": ts, "start_date": _days_ago(400), "end_date": _today()},
        "ts_code,end_date,holder_name,hold_amount,hold_ratio",
    )
    if holders:
        latest = max(h["end_date"] for h in holders)
        top = [h for h in holders if h["end_date"] == latest]
        print(f"\n  十大股东（{latest}）")
        print(f"  {'股东名称':<34}{'持股比例':>10}")
        print("  " + "-" * 46)
        for h in sorted(top, key=lambda x: -float(x.get("hold_ratio") or 0))[:10]:
            print(f"  {str(h.get('holder_name'))[:33]:<34}{_num(h.get('hold_ratio'), 2, '%'):>10}")
        total = sum(float(h.get("hold_ratio") or 0) for h in top)
        print(f"  {'合计':<34}{_num(total, 2, '%'):>10}")
    else:
        print("\n  十大股东: 无数据")

    nums = _call(
        "stk_holdernumber",
        {"ts_code": ts, "start_date": _days_ago(800), "end_date": _today()},
        "end_date,holder_num",
    )
    if nums:
        nums.sort(key=lambda r: r["end_date"], reverse=True)
        trend = "  ".join(f"{r['end_date']}:{int(r['holder_num']):,}" for r in nums[:5])
        print(f"\n  股东户数（近5期）: {trend}")

    rewards = _call("stk_rewards", {"ts_code": ts}, "ts_code,end_date,name,title,reward,hold_vol")
    if rewards:
        latest = max(r["end_date"] for r in rewards if r.get("end_date"))
        cur = [r for r in rewards if r["end_date"] == latest]
        print(f"\n  高管薪酬与持股（{latest}，取薪酬前 8 位）")
        print(f"  {'姓名':<12}{'职务':<20}{'薪酬(万元)':>12}{'持股(股)':>14}")
        print("  " + "-" * 58)
        for r in sorted(cur, key=lambda x: -float(x.get("reward") or 0))[:8]:
            # stk_rewards.reward 单位为「元」，换算成万元展示
            rw = r.get("reward")
            rw = float(rw) / 1e4 if rw not in (None, "") else None
            print(
                f"  {str(r.get('name'))[:11]:<12}{str(r.get('title'))[:19]:<20}"
                f"{_num(rw, 1):>12}{_num(r.get('hold_vol'), 0):>14}"
            )
    else:
        print("\n  高管薪酬: 无数据")


def cmd_price(code, adjust="qfq", years=5):
    """历史价格序列；adjust=qfq 时按 adj_factor 换算前复权。"""
    ts = _ts_code(code)
    info = _name(ts)
    start = (date.today() - timedelta(days=365 * years + 10)).strftime("%Y%m%d")
    end = _today()

    daily = _call("daily", {"ts_code": ts, "start_date": start, "end_date": end},
                  "trade_date,close")
    if not daily:
        print(f"❌ 未取到 {ts} 的行情序列")
        return
    daily.sort(key=lambda r: r["trade_date"])

    label = "不复权"
    if adjust == "qfq":
        factors = _call("adj_factor", {"ts_code": ts, "start_date": start, "end_date": end},
                        "trade_date,adj_factor")
        fmap = {r["trade_date"]: float(r["adj_factor"]) for r in factors}
        latest_f = fmap.get(daily[-1]["trade_date"])
        if latest_f:
            for r in daily:
                f = fmap.get(r["trade_date"])
                if f is not None and r.get("close") not in (None, ""):
                    # 前复权价 = 不复权收盘 × 该日 adj_factor ÷ 最新交易日 adj_factor
                    r["close"] = float(r["close"]) * f / latest_f
            label = "前复权"
        else:
            print("  ⚠️  未取到最新复权因子，回退为不复权序列")

    closes = [float(r["close"]) for r in daily if r.get("close") not in (None, "")]
    first, last = closes[0], closes[-1]
    lo, hi = min(closes), max(closes)

    print("=" * 60)
    print(f"{info.get('name', ts)}（{ts}） 近 {years} 年价格序列（{label}）")
    print("=" * 60)
    print(f"  区间:       {daily[0]['trade_date']} ~ {daily[-1]['trade_date']}（{len(closes)} 个交易日）")
    print(f"  期初 / 期末: {first:,.2f} / {last:,.2f} 元")
    print(f"  区间涨幅:   {(last / first - 1) * 100:+.1f}%（未计分红，总回报需用后复权）")
    print(f"  最低 / 最高: {lo:,.2f} / {hi:,.2f} 元")
    print(f"  当前分位:   {(last - lo) / (hi - lo) * 100:.0f}%" if hi > lo else "")
    print()
    print("  年度收盘（每年最后一个交易日）:")
    by_year = {}
    for r in daily:
        if r.get("close") not in (None, ""):
            by_year[str(r["trade_date"])[:4]] = float(r["close"])
    for y in sorted(by_year)[-years - 1:]:
        print(f"    {y}: {by_year[y]:,.2f}")
    if label == "不复权":
        print("\n  ⚠️  历史对比/PE band 必须用前复权序列，不要混用")


def cmd_search(keyword):
    """按名称或代码搜索标的。"""
    rows = _call("stock_basic", {"list_status": "L"}, "ts_code,name,industry,market,list_date")
    kw = str(keyword).strip()
    hits = [r for r in rows if kw in str(r.get("name", "")) or kw in str(r.get("ts_code", ""))]
    if not hits:
        print(f"❌ 未找到匹配 “{kw}” 的标的")
        return
    print(f"匹配 “{kw}” 的标的（{len(hits)} 个）：")
    print(f"  {'ts_code':<12}{'名称':<12}{'行业':<14}{'板块':<8}{'上市日期'}")
    print("  " + "-" * 56)
    for r in hits[:20]:
        print(
            f"  {r.get('ts_code',''):<12}{str(r.get('name',''))[:11]:<12}"
            f"{str(r.get('industry') or '-')[:13]:<14}{str(r.get('market') or '-'):<8}{r.get('list_date','')}"
        )


# ---------------------------------------------------------------------------
# CLI 入口
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="A股数据工具 — Tushare Pro（内置报表去重、口径过滤、分部合计行剔除）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command")

    for cmd, help_text in [
        ("quote", "最新行情 + 估值 + 市值验算"),
        ("valuation", "估值指标（PE/PB/PS/股息率 + 一年区间）"),
        ("holders", "十大股东 + 股东户数 + 高管薪酬持股"),
    ]:
        p = sub.add_parser(cmd, help=help_text)
        p.add_argument("code", help="股票代码，如 600519 或 600519.SH")

    p_fin = sub.add_parser("financials", help="近N年核心财务（已去重、合并报表口径）")
    p_fin.add_argument("code")
    p_fin.add_argument("--years", type=int, default=5)

    p_seg = sub.add_parser("segments", help="分部收入（已剔除合计行并与总收入对账）")
    p_seg.add_argument("code")
    p_seg.add_argument("--period", default=None, help="报告期，如 20241231；默认最近财年")

    p_price = sub.add_parser("price", help="历史价格序列（默认前复权）")
    p_price.add_argument("code")
    p_price.add_argument("--adjust", choices=["qfq", "none"], default="qfq")
    p_price.add_argument("--years", type=int, default=5)

    p_search = sub.add_parser("search", help="搜索股票代码")
    p_search.add_argument("keyword", help="公司名或代码")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    try:
        if args.command == "search":
            cmd_search(args.keyword)
        elif args.command == "financials":
            cmd_financials(args.code, args.years)
        elif args.command == "segments":
            cmd_segments(args.code, args.period)
        elif args.command == "price":
            cmd_price(args.code, args.adjust, args.years)
        else:
            {"quote": cmd_quote, "valuation": cmd_valuation, "holders": cmd_holders}[
                args.command
            ](args.code)
    except BrokenPipeError:
        # 输出被管道截断（如 | head），静默退出。
        # BrokenPipeError 是 ConnectionError 的子类，必须放在前面
        sys.stderr.close()
        sys.exit(0)
    except ValueError as e:
        print(f"❌ {e}")
        sys.exit(2)
    except ConnectionError as e:
        print(f"❌ {e}")
        sys.exit(2)


if __name__ == "__main__":
    main()
