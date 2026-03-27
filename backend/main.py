import pandas as pd
import yfinance as yf
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from typing import List, Optional
import re
import sqlite3
import threading
from datetime import datetime, timedelta
import numpy as np

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

DB_PATH = "backend/cache.db"
ETF_OVERVIEW_PATH = "data/ETF-overview.csv"

_metrics_cache = {}
_metrics_cache_lock = threading.Lock()
_precalc_status = {"running": False, "progress": 0, "total": 0, "last_completed": None}
_yield_warmup_done = False

CACHE_STALENESS_DAYS = 7
EXCLUDED_CATEGORIES_DEFAULT = {"Single Stock ETF", "-"}
MIN_AUM_DEFAULT = 5_000_000
MIN_TRADING_DAYS = 60


# ── DB Setup ──────────────────────────────────────────────────────────────────

def get_conn():
    return sqlite3.connect(DB_PATH)

def init_db():
    conn = get_conn()
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS prices (
            ticker TEXT, date TEXT, close REAL,
            PRIMARY KEY (ticker, date)
        );
        CREATE TABLE IF NOT EXISTS metadata (
            ticker TEXT PRIMARY KEY, last_updated TEXT
        );
        CREATE TABLE IF NOT EXISTS yields (
            ticker TEXT PRIMARY KEY,
            dividend_yield REAL,
            mer REAL,
            last_updated TEXT
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

    cached_meta = pd.read_sql("SELECT ticker, last_updated FROM metadata", conn)
    cached_map = dict(zip(cached_meta['ticker'], cached_meta['last_updated']))

    to_fetch = [t for t in tickers if t not in cached_map or force_refresh or
                (cached_map.get(t) and cached_map[t] < staleness_cutoff)]

    if not to_fetch:
        conn.close()
        return

    print(f"[prices] Fetching {len(to_fetch)} tickers...")
    for i in range(0, len(to_fetch), 20):
        batch = to_fetch[i:i+20]
        try:
            df = yf.download(batch, start=start_date, group_by='ticker', progress=False)
            tickers_to_save = []
            if len(batch) == 1:
                tickers_to_save = [(batch[0], df)]
            elif hasattr(df.columns, 'levels'):
                tickers_to_save = [(t, df[t]) for t in batch if t in df.columns.levels[0]]

            for ticker, tdf in tickers_to_save:
                try:
                    sdf = tdf['Close'].dropna().reset_index()
                    sdf['ticker'] = ticker
                    sdf['Date'] = sdf['Date'].dt.strftime('%Y-%m-%d')
                    sdf = sdf[['ticker', 'Date', 'Close']]
                    sdf.columns = ['ticker', 'date', 'close']
                    conn.execute("DELETE FROM prices WHERE ticker = ?", (ticker,))
                    sdf.to_sql('prices', conn, if_exists='append', index=False)
                    conn.execute("INSERT OR REPLACE INTO metadata VALUES (?, ?)",
                                 (ticker, datetime.now().strftime('%Y-%m-%d')))
                    conn.commit()
                except Exception as e:
                    print(f"  err {ticker}: {e}")
        except Exception as e:
            print(f"  batch err: {e}")
    conn.close()


# ── Yield/MER: NEVER block on API calls during ranking ───────────────────────

def get_cached_yields(tickers: List[str]) -> dict:
    """Return cached yield/MER for tickers. Never makes API calls."""
    conn = get_conn()
    if not tickers:
        conn.close()
        return {}
    placeholders = ','.join('?' * len(tickers))
    rows = conn.execute(
        f"SELECT ticker, dividend_yield, mer FROM yields WHERE ticker IN ({placeholders})",
        tickers
    ).fetchall()
    conn.close()
    return {r[0]: {"dividendYield": r[1] or 0.0, "mer": r[2] or 0.005} for r in rows}


def _background_fetch_yields(tickers: List[str]):
    """Fetch yield/MER from yfinance in background thread. Writes to DB cache."""
    global _yield_warmup_done
    conn = get_conn()
    staleness = (datetime.now() - timedelta(days=CACHE_STALENESS_DAYS)).strftime('%Y-%m-%d')

    # Find which tickers need fetching
    existing = conn.execute(
        f"SELECT ticker, last_updated FROM yields WHERE ticker IN ({','.join('?' * len(tickers))})",
        tickers
    ).fetchall()
    fresh = {r[0] for r in existing if r[1] and r[1] >= staleness}
    to_fetch = [t for t in tickers if t not in fresh]
    conn.close()

    if not to_fetch:
        _yield_warmup_done = True
        return

    print(f"[yields] Background fetching {len(to_fetch)} tickers...")
    for i, ticker in enumerate(to_fetch):
        div_yield = 0.0
        mer = 0.005
        try:
            info = yf.Ticker(ticker).info
            div_yield = float(info.get('dividendYield', 0) or 0)
            for key in ('annualReportExpenseRatio', 'totalExpenseRatio', 'expenseRatio'):
                val = info.get(key)
                if val and val > 0:
                    mer = float(val)
                    break
        except Exception:
            pass

        c = get_conn()
        c.execute("INSERT OR REPLACE INTO yields VALUES (?, ?, ?, ?)",
                  (ticker, div_yield, mer, datetime.now().strftime('%Y-%m-%d')))
        c.commit()
        c.close()

        if (i + 1) % 50 == 0:
            print(f"  [yields] {i+1}/{len(to_fetch)} done")

    _yield_warmup_done = True
    print(f"[yields] Done: {len(to_fetch)} tickers updated")


# ── Metrics calculation ───────────────────────────────────────────────────────

def calculate_metrics_for_window(ticker, start, end, conn):
    df = pd.read_sql(
        "SELECT date, close FROM prices WHERE ticker = ? AND date >= ? AND date <= ? ORDER BY date",
        conn, params=(ticker, start, end)
    )
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

    return {
        "annualReturn": round(float(annualized_return), 6),
        "totalReturn": round(float(total_return), 6),
        "maxDrawdown": round(float(max_drawdown), 6),
        "volatility": round(float(volatility), 6),
        "sortino": round(float(sortino), 4),
    }


# ── Startup: warm caches in background ────────────────────────────────────────

@app.on_event("startup")
async def startup_warmup():
    """On server start, kick off background yield caching for common ETFs."""
    df = pd.read_csv(ETF_OVERVIEW_PATH)
    df['Symbol'] = df['Symbol'].apply(get_clean_ticker)
    df['_aum'] = df['AUM ($)'].apply(parse_aum)
    # Only warm yields for ETFs that pass quality gates (AUM >= $5M, real categories)
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

    # Quality gate
    df_meta = df_meta[df_meta['_aum'] >= min_aum]

    # Category filtering
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

    # Metrics: use precalc or on-the-fly
    cache_key = f"{start}|{end}"
    with _metrics_cache_lock:
        precalc = _metrics_cache.get(cache_key)

    if precalc:
        process_df = df_meta
    else:
        process_df = df_meta.head(100)
        fetch_and_cache(process_df['Symbol'].tolist())

    conn = get_conn()
    ticker_list = process_df['Symbol'].tolist()

    # Batch-read cached yields (single query, no API calls)
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

    if not results:
        return []

    df_res = pd.DataFrame(results)

    # Constraint filters
    if min_return is not None:
        df_res = df_res[df_res['annualReturn'] >= min_return]
    if max_drawdown is not None:
        df_res = df_res[df_res['maxDrawdown'] <= max_drawdown]
    if max_mer is not None:
        df_res = df_res[df_res['mer'] <= max_mer]
    if min_yield is not None:
        df_res = df_res[df_res['yield'] >= min_yield]

    if df_res.empty:
        return []

    # Scoring
    for col in ['annualReturn', 'sortino', 'yield']:
        df_res[f'n_{col}'] = df_res[col].rank(pct=True)
    for col in ['mer', 'maxDrawdown']:
        df_res[f'n_{col}'] = 1 - df_res[col].rank(pct=True)

    df_res['score'] = (
        df_res['n_annualReturn'] * weight_performance +
        df_res['n_mer'] * weight_mer +
        df_res['n_yield'] * weight_yield +
        df_res['n_sortino'] * weight_risk * 0.5 +
        df_res['n_maxDrawdown'] * weight_risk * 0.5
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
    # Ensure price data exists for these tickers
    fetch_and_cache(tickers)
    all_data = []
    for t in tickers:
        safe_col = re.sub(r'[^A-Za-z0-9_.]', '', t)
        df = pd.read_sql(
            "SELECT date as Date, close FROM prices WHERE ticker = ? AND date >= ? AND date <= ? ORDER BY date",
            conn, params=(t, start, end)
        )
        if not df.empty:
            df[safe_col] = (df['close'] / df['close'].iloc[0]) * 100 if normalized else df['close']
            all_data.append(df[['Date', safe_col]].set_index('Date'))
    conn.close()
    if not all_data:
        return []
    return pd.concat(all_data, axis=1).sort_index().ffill().dropna().reset_index().to_dict(orient='records')


def _background_precalculate(start: str, end: str):
    global _precalc_status
    cache_key = f"{start}|{end}"
    with _metrics_cache_lock:
        if cache_key in _metrics_cache:
            return

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
        if m:
            results[ticker] = m
        _precalc_status["progress"] = i + 1
    conn.close()

    with _metrics_cache_lock:
        _metrics_cache[cache_key] = results
    _precalc_status = {"running": False, "progress": len(all_tickers), "total": len(all_tickers),
                       "last_completed": datetime.now().isoformat()}
    print(f"[precalc] Done: {len(results)} ETFs for {cache_key}")


@app.get("/precalculate")
async def trigger_precalculate(start: str = "2024-01-01", end: str = "2025-01-01"):
    cache_key = f"{start}|{end}"
    with _metrics_cache_lock:
        if cache_key in _metrics_cache:
            return {"status": "already_cached", "count": len(_metrics_cache[cache_key])}
    if _precalc_status["running"]:
        return {"status": "in_progress", **_precalc_status}
    threading.Thread(target=_background_precalculate, args=(start, end), daemon=True).start()
    return {"status": "started"}


@app.get("/refresh-cache")
async def refresh_cache(ticker: Optional[str] = None):
    if ticker:
        tickers = [get_clean_ticker(ticker)]
    else:
        tickers = pd.read_csv(ETF_OVERVIEW_PATH)['Symbol'].apply(get_clean_ticker).tolist()
    fetch_and_cache(tickers, force_refresh=True)
    with _metrics_cache_lock:
        _metrics_cache.clear()
    return {"status": "refreshed", "count": len(tickers)}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
