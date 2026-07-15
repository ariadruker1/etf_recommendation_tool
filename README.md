# TSX ETF Ranker

An advisor-style ETF screener for the Toronto Stock Exchange. Answer five quick questions about your goals, timeline, and risk comfort, and the app narrows 1,680+ TSX-listed ETFs down to a ranked, risk-aligned shortlist — with interactive charts and plain-English explanations of every metric.

**Stack:** React 19 + TypeScript + Vite + Tailwind CSS v4 + Recharts frontend · FastAPI + DuckDB + yfinance backend · Docker/Railway deployment.

## Features

- **Investor quiz → advisor profile.** Five questions build a profile that sets scoring weights and hard limits (max drawdown, fees, minimum yield). Every limit can be reviewed and overridden — the advisor guides, it doesn't lock you in.
- **Multi-factor ranking engine.** ETFs are percentile-ranked on yield, fees (MER), performance, and risk, then combined with profile-driven weights. The risk score blends Sortino ratio (40%), Calmar ratio (30%), and max drawdown (30%).
- **Dynamic time windows.** All metrics are recomputed for any date range (6M / 1Y / 3Y / 5Y presets).
- **Fair comparison charting.** Selected ETFs are indexed to 100 at their first available data point ("common start date" alignment), so late-inception funds compare honestly.
- **Metric education.** Tooltips and Investopedia links explain Sortino, Calmar, MER, and max drawdown as you go.
- **Fast by design.** DuckDB caches five years of price history locally; yield/MER data is fetched in a background thread so it never blocks ranking.

## Quick Start

### 1. Backend (Python 3.9+)

```bash
pip3 install -r backend/requirements.txt
python3 backend/main.py
```

The API runs at http://localhost:8000.

**What to expect on first launch.** The DuckDB cache (`backend/cache.duckdb`) is not committed — it's built from Yahoo Finance on your machine:

- On startup, yield data for ~1,100 tickers is fetched in a background thread (throttled, takes ~5 minutes). The app is usable immediately; yields show as 0.00% until their fetch completes, so refresh after a few minutes.
- The first ranking request also fetches price history for its candidate ETFs, so it takes noticeably longer than usual. Subsequent starts and requests are fast — cached data is reused for 7 days.
- `HTTP Error 404: Quote not found` log lines are normal: the TSX universe includes `.U` (USD-denominated) and `.B` unit classes plus some delisted funds that Yahoo doesn't list. Those funds simply won't have yield data.
- If Yahoo rate-limits (`Too Many Requests`), failed fetches are never cached — they retry automatically on the next request or restart. Waiting 30–60 minutes clears the limit.

### 2. Frontend (Node 18+)

```bash
npm install
npm run dev
```

The dashboard runs at http://localhost:5173. To point it at a deployed backend, copy `.env.example` to `.env` and set `VITE_API_URL`.

## Core Metrics

- **Sortino Ratio** — risk-adjusted return that penalizes only downside volatility.
- **Calmar Ratio** — annualized return divided by max drawdown; rewards steady growth over boom-and-bust.
- **Max Drawdown** — the largest peak-to-trough drop in the selected period.
- **Annualized Volatility** — standard deviation of daily returns, annualized.

## Architecture

```
data/ETF-overview.csv      TSX ETF universe (metadata: name, asset class, AUM)
backend/main.py            FastAPI service: ranking, history, precalculation
backend/cache.duckdb       Local price/yield cache (auto-generated, not tracked)
src/App.tsx                React dashboard: quiz, advisor panel, table, charts
```

**API endpoints:** `/rank` (weighted scoring with filters), `/history` (normalized price series), `/precalculate` (background metric warmup for the full universe), `/categories`, `/refresh-cache`.

## Data Sources

- Metadata: `data/ETF-overview.csv` (TSX ETF universe)
- Prices and yields: Yahoo Finance via `yfinance`, cached in DuckDB with 7-day staleness refresh
- Fees (MER): Yahoo publishes no expense-ratio data for TSX-listed funds, so a 0.50% placeholder is used for all ETFs — treat the fee column and fee-based filtering as illustrative until a real fee source is wired in

## Author

**Aria Druker**
