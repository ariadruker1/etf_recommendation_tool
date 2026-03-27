export interface ETF {
  ticker: string;
  name: string;
  mer: number;
  yield: number;
  aum: number;
  category: string;
  annualReturn: number;
  totalReturn: number;
  maxDrawdown: number;
  volatility: number;
  sortino: number;
  score?: number;
}

export interface Weights {
  yield: number;
  mer: number;
  risk: number;
  performance: number;
}
