export interface ETF {
  ticker: string;
  name: string;
  price: number;
  mer: number;
  yield: number;
  aum: number;
  category: string;
  annualReturn: number;
  maxDrawdown: number;
  sortino: number;
  calmar: number;
  lastUpdated: string;
  score?: number;
}

export interface Weights {
  yield: number;
  mer: number;
  risk: number; // Penalty for Max Drawdown
  performance: number; // Sortino/Return
}
