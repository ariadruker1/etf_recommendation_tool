# TSX ETF Ranker 🚀

A high-performance evaluator for TSX ETFs using Python (FastAPI/Pandas) and React.

## Quick Start

### 1. Start the Backend (Python)
Ensure you have the dependencies installed:
```bash
pip3 install fastapi uvicorn pandas yfinance
```
Launch the server:
```bash
python3 backend/main.py
```
*The API runs at http://localhost:8000*

### 2. Start the Frontend (Vite)
```bash
npm install
npm run dev
```
*The Dashboard runs at http://localhost:5173*

## Core Metrics
- **Sortino Ratio:** Measures risk-adjusted return, penalizing only downside volatility.
- **Max Drawdown:** The largest peak-to-trough drop in the selected period.
- **Normalized Growth:** Scales all selected ETFs to 100% at the start of the window for direct comparison.

## Data Source
- Metadata: `data/ETF-overview.csv`
- Historical Data: Yahoo Finance (Dynamic)
