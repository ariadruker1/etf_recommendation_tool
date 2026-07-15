import pandas as pd
import yfinance as yf
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from typing import List, Optional
import re
import duckdb
import threading
import time
from datetime import datetime, timedelta
import numpy as np
import os

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

DB_PATH = "backend/cache.duckdb"
ETF_OVERVIEW_PATH = "data/ETF-overview.csv"

_metrics_cache = {}
_metrics_cache_lock = threading.Lock()
_precalc_status = {"running": False, "progress": 0, "total": 0, "last_completed": None}
_yield_warmup_done = False

CACHE_STALENESS_DAYS = 7
EXCLUDED_CATEGORIES_DEFAULT = {"Single Stock ETF", "-"}
MIN_AUM_DEFAULT = 5_000_000
MIN_TRADING_DAYS = 60


# ── DB Setup (DuckDB) ────────────────────────────────────────────────────────

def get_conn():
    return duckdb.connect(DB_PATH)

def init_db():
    conn = get_conn()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS prices (
            ticker TEXT, date DATE, close DOUBLE,
            PRIMARY KEY (ticker, date)
        );
        CREATE TABLE IF NOT EXISTS metadata (
            ticker TEXT PRIMARY KEY, last_updated DATE
        );
        CREATE TABLE IF NOT EXISTS yields (
            ticker TEXT PRIMARY KEY,
            dividend_yield DOUBLE,
            mer DOUBLE,
            last_updated DATE
        );
    ''')
    conn.close()

init_db()


# ── Helpers ───────────────────────────────────────────────────────────────────

def get_clean_ticker(t):
    t = str(t).strip().upper()
    if not t.endswith('.TO') and not t.endswith('.V'):
        return f"{t}.TO"
    return t

def parse_aum(val) -> float:
    try:
        v = str(val).strip().replace(',', '')
        return 0.0 if v in ('-', '', 'nan', 'None') else float(v)
    except (ValueError, TypeError):
        return 0.0


# ── Price fetching & caching ──────────────────────────────────────────────────

def fetch_and_cache(tickers: List[str], force_refresh: bool = False):
    conn = get_conn()
    start_date = (datetime.now() - timedelta(days=5 * 365)).strftime('%Y-%m-%d')
    staleness_cutoff = (datetime.now() - timedelta(days=CACHE_STALENESS_DAYS)).strftime('%Y-%m-%d')

    cached_meta = conn.execute("SELECT ticker, last_updated FROM metadata").df()
    cached_map = dict(zip(cached_meta['ticker'], cached_meta['last_updated'].astype(str)))

    to_fetch = [t for t in tickers if t not in cached_map or force_refresh or
                (cached_map.get(t) and cached_map[t] < staleness_cutoff)]

    if not to_fetch:
        conn.close()
        return

    print(f"[prices] Fetching {len(to_fetch)} tickers...")
    empty_batches = 0
    for i in range(0, len(to_fetch), 20):
        batch = to_fetch[i:i+20]
        try:
            df = yf.download(batch, start=start_date, group_by='ticker', progress=False)
            if len(batch) == 1:
                tickers_to_save = [(batch[0], df)]
            elif hasattr(df.columns, 'levels'):
                tickers_to_save = [(t, df[t]) for t in batch if t in df.columns.levels[0]]
            else:
                tickers_to_save = []

            saved_any = False
            for ticker, tdf in tickers_to_save:
                try:
                    sdf = tdf['Close'].dropna().reset_index()
                    if sdf.empty:
                        # Failed download (e.g. rate limited) — leave the ticker
                        # unstamped so it gets retried on the next request.
                        continue
                    sdf['ticker'] = ticker
                    sdf['Date'] = pd.to_datetime(sdf['Date']).dt.date
                    sdf = sdf[['ticker', 'Date', 'Close']]
                    sdf.columns = ['ticker', 'date', 'close']

                    conn.execute("DELETE FROM prices WHERE ticker = ?", [ticker])
                    conn.register('sdf_temp', sdf)
                    conn.execute("INSERT INTO prices SELECT * FROM sdf_temp")
                    conn.unregister('sdf_temp')

                    conn.execute("INSERT OR REPLACE INTO metadata VALUES (?, ?)",
                                 [ticker, datetime.now().date()])
                    saved_any = True
                except Exception as e:
                    print(f"  err {ticker}: {e}")

            if saved_any:
                empty_batches = 0
            else:
                empty_batches += 1
                if empty_batches >= 3:
                    print("[prices] Aborting fetch: repeated empty batches (Yahoo is likely "
                          "rate limiting). Unfetched tickers will retry on the next request.")
                    break
            time.sleep(1)
        except Exception as e:
            print(f"  batch err: {e}")
    conn.close()


# ── Yield/MER: NEVER block on API calls during ranking ───────────────────────

def get_cached_yields(tickers: List[str]) -> dict:
    conn = get_conn()
    if not tickers:
        conn.close()
        return {}
    
    placeholders = ",".join("?" for _ in tickers)
    query = f"SELECT ticker, dividend_yield, mer FROM yields WHERE ticker IN ({placeholders})"
    df = conn.execute(query, tickers).df()
    conn.close()
    
    return {r['ticker']: {"dividendYield": r['dividend_yield'] or 0.0, "mer": r['mer'] or 0.005} 
            for _, r in df.iterrows()}


def _background_fetch_yields(tickers: List[str]):
    global _yield_warmup_done
    if not tickers:
        _yield_warmup_done = True
        return
    conn = get_conn()
    staleness = (datetime.now() - timedelta(days=CACHE_STALENESS_DAYS)).date()

    placeholders = ",".join("?" for _ in tickers)
    existing = conn.execute(
        f"SELECT ticker, last_updated FROM yields WHERE ticker IN ({placeholders})", tickers
    ).df()
    
    fresh = set(existing[existing['last_updated'].dt.date >= staleness]['ticker'])
    to_fetch = [t for t in tickers if t not in fresh]
    conn.close()

    if not to_fetch:
        _yield_warmup_done = True
        return

    print(f"[yields] Background fetching {len(to_fetch)} tickers...")
    failed = 0
    for i, ticker in enumerate(to_fetch):
        try:
            info = yf.Ticker(ticker).info
            # yfinance >= 1.x: 'yield' is a fraction (0.0217), 'dividendYield'
            # is a percentage (2.17). Prefer the fraction; frontend expects it.
            div_yield = float(info.get('yield') or 0)
            if not div_yield:
                div_yield = float(info.get('dividendYield') or 0) / 100
            mer = 0.005
            for key in ('annualReportExpenseRatio', 'totalExpenseRatio', 'expenseRatio'):
                val = info.get(key)
                if val and val > 0:
                    mer = float(val)
                    break
        except Exception:
            # Don't cache failures (e.g. rate limits) — leave the ticker
            # missing so it gets retried on the next startup.
            failed += 1
            time.sleep(2)
            continue

        c = get_conn()
        c.execute("INSERT OR REPLACE INTO yields VALUES (?, ?, ?, ?)",
                  [ticker, div_yield, mer, datetime.now().date()])
        c.close()

        time.sleep(0.2)  # stay under Yahoo's rate limit
        if (i + 1) % 50 == 0:
            print(f"  [yields] {i+1}/{len(to_fetch)} done")

    print(f"[yields] Done: {len(to_fetch) - failed} updated, {failed} failed (will retry next startup)")

    _yield_warmup_done = True


# ── Metrics calculation (DuckDB optimized) ───────────────────────────────────

def calculate_metrics_for_window(ticker, start, end, conn):
    df = conn.execute(
        "SELECT date, close FROM prices WHERE ticker = ? AND date >= CAST(? AS DATE) AND date <= CAST(? AS DATE) ORDER BY date",
        [ticker, start, end]
    ).df()
    
    if len(df) < MIN_TRADING_DAYS:
        return None

    prices = df['close']
    returns = prices.pct_change().dropna()
    trading_days = len(returns)
    total_return = (prices.iloc[-1] / prices.iloc[0]) - 1
    annualized_return = (1 + total_return) ** (252 / max(trading_days, 1)) - 1

    if abs(annualized_return) > 5.0:
        return None

    roll_max = prices.cummax()
    max_drawdown = abs(((prices - roll_max) / roll_max).min())
    volatility = returns.std() * np.sqrt(252)

    neg_returns = returns[returns < 0]
    downside_std = neg_returns.std() * np.sqrt(252) if len(neg_returns) > 0 else 0
    mean_annual = returns.mean() * 252
    sortino = (mean_annual - 0.045) / downside_std if downside_std > 0 else 0
    
    # Calmar Ratio: Return / Max Drawdown
    calmar = annualized_return / max_drawdown if max_drawdown > 0 else 0

    return {
        "annualReturn": round(float(annualized_return), 6),
        "totalReturn": round(float(total_return), 6),
        "maxDrawdown": round(float(max_drawdown), 6),
        "volatility": round(float(volatility), 6),
        "sortino": round(float(sortino), 4),
        "calmar": round(float(calmar), 4),
    }


# ── Startup ───────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup_warmup():
    df = pd.read_csv(ETF_OVERVIEW_PATH)
    df['Symbol'] = df['Symbol'].apply(get_clean_ticker)
    df['_aum'] = df['AUM ($)'].apply(parse_aum)
    quality = df[(df['_aum'] >= MIN_AUM_DEFAULT) & (~df['Asset Class'].isin(EXCLUDED_CATEGORIES_DEFAULT))]
    tickers = quality['Symbol'].tolist()
    thread = threading.Thread(target=_background_fetch_yields, args=(tickers,), daemon=True)
    thread.start()


# ── API Endpoints ─────────────────────────────────────────────────────────────

@app.get("/categories")
async def get_categories():
    df = pd.read_csv(ETF_OVERVIEW_PATH)
    cats = sorted(c for c in df['Asset Class'].dropna().unique() if c not in ('-', '', 'nan'))
    return cats


@app.get("/rank")
async def rank_etfs(
    start: str = "2024-01-01",
    end: str = "2025-01-01",
    weight_yield: float = 0.25,
    weight_mer: float = 0.25,
    weight_performance: float = 0.25,
    weight_risk: float = 0.25,
    search: Optional[str] = None,
    categories: Optional[str] = None,
    exclude_categories: Optional[str] = None,
    min_aum: float = MIN_AUM_DEFAULT,
    min_return: Optional[float] = None,
    max_drawdown: Optional[float] = None,
    max_mer: Optional[float] = None,
    min_yield: Optional[float] = None,
):
    df_meta = pd.read_csv(ETF_OVERVIEW_PATH)
    df_meta['Symbol'] = df_meta['Symbol'].apply(get_clean_ticker)
    df_meta['_aum'] = df_meta['AUM ($)'].apply(parse_aum)

    df_meta = df_meta[df_meta['_aum'] >= min_aum]

    if categories:
        df_meta = df_meta[df_meta['Asset Class'].isin([c.strip() for c in categories.split(',')])]
    elif exclude_categories:
        df_meta = df_meta[~df_meta['Asset Class'].isin([c.strip() for c in exclude_categories.split(',')])]
    else:
        df_meta = df_meta[~df_meta['Asset Class'].isin(EXCLUDED_CATEGORIES_DEFAULT)]

    if search:
        s = re.escape(search)
        df_meta = df_meta[
            df_meta['Symbol'].str.contains(s, case=False, na=False) |
            df_meta['Fund Name'].str.contains(s, case=False, na=False)
        ]

    cache_key = f"{start}|{end}"
    with _metrics_cache_lock:
        precalc = _metrics_cache.get(cache_key)

    if not precalc:
        process_df = df_meta.head(100)
        fetch_and_cache(process_df['Symbol'].tolist())
    else:
        process_df = df_meta

    conn = get_conn()
    ticker_list = process_df['Symbol'].tolist()
    yield_cache = get_cached_yields(ticker_list)

    results = []
    for _, row in process_df.iterrows():
        ticker = row['Symbol']
        m = precalc.get(ticker) if precalc else calculate_metrics_for_window(ticker, start, end, conn)
        if not m:
            continue

        yinfo = yield_cache.get(ticker, {"dividendYield": 0.0, "mer": 0.005})
        results.append({
            "ticker": ticker,
            "name": row['Fund Name'],
            "category": row['Asset Class'],
            "aum": row['_aum'],
            "yield": yinfo["dividendYield"],
            "mer": yinfo["mer"],
            **m
        })
    conn.close()

    if not results: return []
    df_res = pd.DataFrame(results)

    if min_return is not None: df_res = df_res[df_res['annualReturn'] >= min_return]
    if max_drawdown is not None: df_res = df_res[df_res['maxDrawdown'] <= max_drawdown]
    if max_mer is not None: df_res = df_res[df_res['mer'] <= max_mer]
    if min_yield is not None: df_res = df_res[df_res['yield'] >= min_yield]

    if df_res.empty: return []

    for col in ['annualReturn', 'sortino', 'yield', 'calmar']:
        df_res[f'n_{col}'] = df_res[col].rank(pct=True)
    for col in ['mer', 'maxDrawdown']:
        df_res[f'n_{col}'] = 1 - df_res[col].rank(pct=True)

    df_res['score'] = (
        df_res['n_annualReturn'] * weight_performance +
        df_res['n_mer'] * weight_mer +
        df_res['n_yield'] * weight_yield +
        (df_res['n_sortino'] * 0.4 + df_res['n_calmar'] * 0.3 + df_res['n_maxDrawdown'] * 0.3) * weight_risk
    ) * 100

    return df_res.sort_values('score', ascending=False).to_dict(orient='records')


@app.get("/history")
async def get_history(
    tickers: List[str] = Query(...),
    start: str = "2024-01-01",
    end: str = "2025-01-01",
    normalized: bool = True,
):
    conn = get_conn()
    fetch_and_cache(tickers)
    
    # Efficient DuckDB query for multiple tickers
    placeholders = ",".join("?" for _ in tickers)
    query = f"""
        SELECT date AS Date, ticker, close
        FROM prices
        WHERE ticker IN ({placeholders})
          AND date >= CAST(? AS DATE)
          AND date <= CAST(? AS DATE)
        ORDER BY date, ticker
    """
    df_all = conn.execute(query, [*tickers, start, end]).df()
    conn.close()
    
    if df_all.empty: return []
    
    # Pivot for charting
    df_pivot = df_all.pivot(index='Date', columns='ticker', values='close').sort_index()
    df_pivot = df_pivot.ffill().dropna(how='all')
    
    if normalized:
        # "Common Start Date" alignment: normalize relative to the FIRST available point for EACH ticker
        # If a ticker starts late, its "100" starts at its inception date.
        for col in df_pivot.columns:
            first_valid_idx = df_pivot[col].first_valid_index()
            if first_valid_idx is not None:
                first_val = df_pivot.loc[first_valid_idx, col]
                df_pivot[col] = (df_pivot[col] / first_val) * 100
    
    df_pivot = df_pivot.reset_index()
    df_pivot['Date'] = df_pivot['Date'].astype(str)
    
    return df_pivot.to_dict(orient='records')


def _background_precalculate(start: str, end: str):
    global _precalc_status
    cache_key = f"{start}|{end}"
    with _metrics_cache_lock:
        if cache_key in _metrics_cache: return

    _precalc_status = {"running": True, "progress": 0, "total": 0, "last_completed": None}
    df = pd.read_csv(ETF_OVERVIEW_PATH)
    df['Symbol'] = df['Symbol'].apply(get_clean_ticker)
    all_tickers = df['Symbol'].tolist()
    _precalc_status["total"] = len(all_tickers)

    fetch_and_cache(all_tickers)
    conn = get_conn()
    results = {}
    for i, ticker in enumerate(all_tickers):
        m = calculate_metrics_for_window(ticker, start, end, conn)
        if m: results[ticker] = m
        _precalc_status["progress"] = i + 1
    conn.close()

    with _metrics_cache_lock:
        _metrics_cache[cache_key] = results
    _precalc_status = {"running": False, "progress": len(all_tickers), "total": len(all_tickers),
                       "last_completed": datetime.now().isoformat()}


@app.get("/precalculate")
async def trigger_precalculate(start: str = "2024-01-01", end: str = "2025-01-01"):
    cache_key = f"{start}|{end}"
    with _metrics_cache_lock:
        if cache_key in _metrics_cache: return {"status": "already_cached", "count": len(_metrics_cache[cache_key])}
    if _precalc_status["running"]: return {"status": "in_progress", **_precalc_status}
    threading.Thread(target=_background_precalculate, args=(start, end), daemon=True).start()
    return {"status": "started"}


@app.get("/refresh-cache")
async def refresh_cache(ticker: Optional[str] = None):
    if ticker: tickers = [get_clean_ticker(ticker)]
    else: tickers = pd.read_csv(ETF_OVERVIEW_PATH)['Symbol'].apply(get_clean_ticker).tolist()
    fetch_and_cache(tickers, force_refresh=True)
    with _metrics_cache_lock: _metrics_cache.clear()
    return {"status": "refreshed", "count": len(tickers)}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
