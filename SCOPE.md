# TSX ETF Evaluator - Project Scope

## Goal
A professional-grade dashboard for analyzing and ranking TSX-listed ETFs with a focus on downside risk protection and dynamic time-series analysis.

## Core Features
1.  **Dynamic Ranking Engine:** Multi-factor scoring (Yield, Fees, Performance, Risk) with user-adjustable weights.
2.  **Time-Series Analysis:** Recalculate metrics (Sortino, Max Drawdown) across any date range (presets for 6M, 1Y, 3Y, 5Y).
3.  **Visual Comparison:** Interactive performance chart comparing multiple ETFs normalized to 100%.
4.  **Metric Education:** Integrated tooltips explaining professional financial metrics (Sortino, MDD, MER).
5.  **Large Universe:** Supports the full list of TSX ETFs from `data/ETF-overview.csv`.

## Architecture
- **Frontend:** React 19 + Vite + Tailwind CSS v4 + Recharts.
- **Backend:** Python 3.9 + FastAPI + Pandas + yfinance.
- **Data:** CSV-based metadata with dynamic Yahoo Finance fetching.

## Infrastructure Status
- [x] Python Backend with Ranking/History endpoints.
- [x] React Frontend with interactive dashboard.
- [x] Dynamic weight calculations.
- [x] Selection-based comparison charting.
