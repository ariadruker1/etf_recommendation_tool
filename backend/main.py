import pandas as pd
import yfinance as yf
from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from typing import List, Optional
import os
import sqlite3
from datetime import datetime, timedelta
import numpy as np

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_PATH = "backend/cache.db"
ETF_OVERVIEW_PATH = "data/ETF-overview.csv"

def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    # Table for historical daily closes
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS prices (
            ticker TEXT,
            date TEXT,
            close REAL,
            PRIMARY KEY (ticker, date)
        )
    ''')
    # Table for ticker metadata status
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS metadata (
            ticker TEXT PRIMARY KEY,
            last_updated TEXT
        )
    ''')
    conn.commit()
    conn.close()

init_db()

def get_clean_ticker(t):
    t = str(t).strip().upper()
    if not t.endswith('.TO') and not t.endswith('.V'):
        return f"{t}.TO"
    return t

def fetch_and_cache(tickers: List[str]):
    """Fetch missing or outdated historical data from Yahoo Finance and save to SQLite."""
    conn = sqlite3.connect(DB_PATH)
    
    # We'll fetch last 5 years to be safe for any window
    start_date = (datetime.now() - timedelta(days=5*365)).strftime('%Y-%m-%d')
    
    # Check what we already have
    cached_tickers = pd.read_sql("SELECT DISTINCT ticker FROM prices", conn)['ticker'].tolist()
    to_fetch = [t for t in tickers if t not in cached_tickers]
    
    if to_fetch:
        print(f"Fetching new data for {len(to_fetch)} tickers...")
        # Fetch in batches
        batch_size = 20
        for i in range(0, len(to_fetch), batch_size):
            batch = to_fetch[i:i+batch_size]
            try:
                df = yf.download(batch, start=start_date, group_by='ticker', progress=False)
                for ticker in batch:
                    try:
                        if ticker in df.columns.levels[0]:
                            ticker_df = df[ticker]['Close'].dropna().reset_index()
                            ticker_df['ticker'] = ticker
                            ticker_df['Date'] = ticker_df['Date'].dt.strftime('%Y-%m-%d')
                            ticker_df = ticker_df[['ticker', 'Date', 'Close']]
                            ticker_df.columns = ['ticker', 'date', 'close']
                            ticker_df.to_sql('prices', conn, if_exists='append', index=False)
                    except Exception as e:
                        print(f"Error caching {ticker}: {e}")
            except Exception as e:
                print(f"Batch fetch error: {e}")
    conn.close()

def calculate_metrics_for_window(ticker, start, end, conn):
    query = f"SELECT date, close FROM prices WHERE ticker = '{ticker}' AND date >= '{start}' AND date <= '{end}' ORDER BY date"
    df = pd.read_sql(query, conn)
    if len(df) < 5: return None
    
    prices = df['close']
    returns = prices.pct_change().dropna()
    
    total_return = (prices.iloc[-1] / prices.iloc[0]) - 1
    
    # MDD
    roll_max = prices.cummax()
    drawdown = (prices - roll_max) / roll_max
    max_drawdown = abs(drawdown.min())
    
    # Sortino
    neg_returns = returns[returns < 0]
    downside_std = neg_returns.std() * np.sqrt(252)
    mean_annual_return = returns.mean() * 252
    sortino = (mean_annual_return - 0.02) / downside_std if downside_std > 0 else 0
    
    return {
        "annualReturn": float(total_return),
        "maxDrawdown": float(max_drawdown),
        "sortino": float(sortino)
    }

@app.get("/rank")
async def rank_etfs(
    start: str = "2024-01-01", 
    end: str = "2025-01-01",
    weight_yield: float = 0.25,
    weight_mer: float = 0.25,
    weight_performance: float = 0.25,
    weight_risk: float = 0.25,
    search: Optional[str] = None,
    category: str = "All"
):
    df_meta = pd.read_csv(ETF_OVERVIEW_PATH)
    df_meta['Symbol'] = df_meta['Symbol'].apply(get_clean_ticker)
    
    # Apply filters early
    if search:
        df_meta = df_meta[
            df_meta['Symbol'].str.contains(search, case=False) | 
            df_meta['Fund Name'].str.contains(search, case=False)
        ]
    
    if category != "All":
        df_meta = df_meta[df_meta['Asset Class'] == category]

    # Limit processing to first 100 for responsiveness, but search works on ALL
    # In a fully optimized production version, we'd pre-calculate these metrics in the background
    process_list = df_meta.head(100) 
    tickers = process_list['Symbol'].tolist()
    
    # Ensure cached
    fetch_and_cache(tickers)
    
    conn = sqlite3.connect(DB_PATH)
    results = []
    for _, row in process_list.iterrows():
        m = calculate_metrics_for_window(row['Symbol'], start, end, conn)
        if m:
            # Parse Mgmt Fee
            try:
                mer = float(str(row['Mgmt Fee (%)']).replace('%', '').strip()) / 100.0
            except:
                mer = 0.005 # Default if missing
                
            results.append({
                "ticker": row['Symbol'],
                "name": row['Fund Name'],
                "category": row['Asset Class'],
                "yield": 0.02, # Mock yield as it's not in the CSV reliable, would fetch from quoteSummary
                "mer": mer,
                **m
            })
    conn.close()

    if not results: return []

    df_res = pd.DataFrame(results)
    # Normalization for scoring
    for col in ['annualReturn', 'sortino']:
        df_res[f'n_{col}'] = (df_res[col] - df_res[col].min()) / (df_res[col].max() - df_res[col].min() + 1e-6)
    for col in ['mer', 'maxDrawdown']:
        df_res[f'n_{col}'] = 1 - (df_res[col] - df_res[col].min()) / (df_res[col].max() - df_res[col].min() + 1e-6)

    df_res['score'] = (
        df_res['n_annualReturn'] * weight_performance +
        df_res['n_mer'] * weight_mer +
        df_res['n_sortino'] * weight_performance + 
        df_res['n_maxDrawdown'] * weight_risk
    ) * 100

    return df_res.sort_values('score', ascending=False).to_dict(orient='records')

@app.get("/history")
async def get_history(tickers: List[str] = Query(...), start: str = "2024-01-01", end: str = "2025-01-01"):
    conn = sqlite3.connect(DB_PATH)
    all_data = []
    
    for t in tickers:
        df = pd.read_sql(f"SELECT date as Date, close as {t} FROM prices WHERE ticker = '{t}' AND date >= '{start}' AND date <= '{end}' ORDER BY date", conn)
        if not df.empty:
            # Normalize to 100
            df[t] = (df[t] / df[t].iloc[0]) * 100
            all_data.append(df.set_index('Date'))
    
    conn.close()
    if not all_data: return []
    
    combined = pd.concat(all_data, axis=1).sort_index().ffill().dropna().reset_index()
    return combined.to_dict(orient='records')

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
