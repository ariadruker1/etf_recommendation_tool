import { useState, useMemo, useEffect } from 'react';
import { Search, SlidersHorizontal, TrendingUp, ShieldAlert, DollarSign, Calendar, Info, CheckCircle2, ChevronRight, Filter, ExternalLink } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import axios from 'axios';

interface ETF {
  ticker: string;
  name: string;
  yield: number;
  mer: number;
  category: string;
  annualReturn: number;
  maxDrawdown: number;
  sortino: number;
  score: number;
}

const METRIC_DETAILS = {
  sortino: {
    label: "Sortino Ratio",
    desc: "Measures risk-adjusted return, but only penalizes 'bad' (downward) volatility. It ignores 'good' volatility (upward spikes).",
    grounding: "If an ETF has a Sortino of 2.0, it's returning twice as much as the 'bad' risk it's taking.",
    link: "https://www.investopedia.com/terms/s/sortinoratio.asp"
  },
  mdd: {
    label: "Max Drawdown (MDD)",
    desc: "The 'Worst Case Scenario'. The largest peak-to-trough drop in value during the period.",
    grounding: "If MDD is 25%, it means if you bought at the absolute high ($100), the lowest it fell before recovering was $75.",
    link: "https://www.investopedia.com/terms/m/maximum-drawdown-mdd.asp"
  },
  mer: {
    label: "Management Fees (MER)",
    desc: "The annual cost of owning the ETF. Higher fees eat into your long-term 'take-home' returns.",
    grounding: "An MER of 0.50% means you pay $5 every year for every $1,000 invested.",
    link: "https://www.investopedia.com/terms/m/mner.asp"
  },
  yield: {
    label: "Dividend Yield",
    desc: "The percentage of the stock price paid out in dividends annually.",
    grounding: "A 4% yield means for every $1,000 invested, you get $40 in cash dividends per year.",
    link: "https://www.investopedia.com/terms/d/dividendyield.asp"
  }
};

const InfoIcon = ({ metric }: { metric: keyof typeof METRIC_DETAILS }) => {
  const m = METRIC_DETAILS[metric];
  return (
    <div className="group relative inline-block ml-1 align-middle">
      <Info size={12} className="text-slate-300 group-hover:text-blue-500 cursor-help transition-colors" />
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block w-64 p-4 bg-slate-900 text-white text-[11px] rounded-xl shadow-2xl z-50">
        <div className="font-black mb-1 uppercase tracking-widest text-blue-400">{m.label}</div>
        <p className="mb-2 text-slate-300 leading-relaxed">{m.desc}</p>
        <div className="p-2 bg-slate-800 rounded-lg mb-2 italic border-l-2 border-blue-500">
          <span className="font-bold text-white">Example:</span> {m.grounding}
        </div>
        <a href={m.link} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-blue-400 font-bold hover:underline">
          LEARN MORE <ExternalLink size={10} />
        </a>
        <div className="absolute top-full left-1/2 -translate-x-1/2 border-8 border-transparent border-t-slate-900"></div>
      </div>
    </div>
  );
};

const App = () => {
  const [etfs, setEtfs] = useState<ETF[]>([]);
  const [historyData, setHistoryData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [chartLoading, setChartLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [isNormalized, setIsNormalized] = useState(true);
  const [selectedTickers, setSelectedTickers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  
  // Hard Filters
  const [maxMER, setMaxMER] = useState(1.0);
  const [maxMDD, setMaxMDD] = useState(1.0);

  const [dateRange, setDateRange] = useState({
    start: "2024-01-01",
    end: new Date().toISOString().split('T')[0]
  });

  const [weights, setWeights] = useState({
    yield: 0.25,
    mer: 0.25,
    risk: 0.25,
    performance: 0.25,
  });

  const fetchRankings = async () => {
    setLoading(true);
    try {
      const res = await axios.get('http://localhost:8000/rank', {
        params: {
          start: dateRange.start,
          end: dateRange.end,
          weight_yield: weights.yield,
          weight_mer: weights.mer,
          weight_performance: weights.performance,
          weight_risk: weights.risk,
          search: searchTerm,
          category: categoryFilter
        }
      });
      setEtfs(res.data);
      if (selectedTickers.length === 0 && res.data.length > 0) {
        setSelectedTickers(res.data.slice(0, 5).map((e: ETF) => e.ticker));
      }
    } catch (err) {
      setError("Backend Error. Ensure python3 backend/main.py is running.");
    } finally {
      setLoading(false);
    }
  };

  const fetchHistory = async () => {
    if (selectedTickers.length === 0) return;
    setChartLoading(true);
    try {
      const res = await axios.get('http://localhost:8000/history', {
        params: { tickers: selectedTickers, start: dateRange.start, end: dateRange.end }
      });
      setHistoryData(res.data);
    } finally {
      setChartLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => fetchRankings(), 600);
    return () => clearTimeout(timer);
  }, [dateRange, weights, searchTerm, categoryFilter]);

  useEffect(() => {
    fetchHistory();
  }, [selectedTickers, dateRange]);

  const filteredETFs = useMemo(() => {
    return etfs.filter(e => e.mer <= maxMER && e.maxDrawdown <= maxMDD);
  }, [etfs, maxMER, maxMDD]);

  const chartColors = ["#2563eb", "#7c3aed", "#db2777", "#ea580c", "#16a34a", "#0891b2", "#4f46e5", "#b91c1c"];

  if (error) return <div className="p-20 text-center font-bold text-red-500">{error}</div>;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-4 md:p-8 font-sans">
      <div className="max-w-7xl mx-auto">
        <header className="flex flex-col md:flex-row justify-between items-end mb-12 gap-6">
          <div>
            <h1 className="text-6xl font-black tracking-tighter mb-2">TSX ETF <span className="text-blue-600">RANKER</span></h1>
            <p className="text-slate-400 font-bold uppercase tracking-widest text-xs">Production Grade Risk Analysis & Portfolio Simulation</p>
          </div>
          <div className="flex bg-white p-2 rounded-2xl shadow-sm border border-slate-200">
            <Calendar size={18} className="mx-3 self-center text-blue-500" />
            <input type="date" className="bg-transparent font-bold text-sm outline-none px-2" value={dateRange.start} onChange={e => setDateRange({...dateRange, start: e.target.value})} />
            <span className="self-center text-slate-300 mx-2">→</span>
            <input type="date" className="bg-transparent font-bold text-sm outline-none px-2" value={dateRange.end} onChange={e => setDateRange({...dateRange, end: e.target.value})} />
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 mb-12">
          {/* Controls Panel */}
          <div className="lg:col-span-4 space-y-8">
            {/* SEARCH */}
            <div className="relative group">
              <Search className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-300 group-focus-within:text-blue-500 transition-colors" size={20} />
              <input 
                type="text" placeholder="Search Symbol (e.g. XIT, VFV)..." 
                className="w-full pl-14 pr-6 py-5 rounded-[2rem] bg-white border-2 border-transparent shadow-xl shadow-blue-900/5 focus:border-blue-500 outline-none font-black text-slate-700 transition-all placeholder:text-slate-300"
                value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
              />
            </div>

            {/* WEIGHTS */}
            <div className="bg-white p-8 rounded-[2.5rem] shadow-xl border border-slate-100">
              <h2 className="text-xs font-black uppercase tracking-[0.2em] text-slate-400 mb-8 flex items-center gap-2">
                <SlidersHorizontal size={14} /> Algorithm Weights
              </h2>
              <div className="space-y-8">
                {[
                  { key: 'performance', label: 'Performance', metric: 'sortino' },
                  { key: 'risk', label: 'Safety', metric: 'mdd' },
                  { key: 'mer', label: 'Low Fees', metric: 'mer' },
                  { key: 'yield', label: 'Yield', metric: 'yield' },
                ].map((item) => (
                  <div key={item.key}>
                    <div className="flex justify-between items-center mb-3">
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center">
                        {item.label} <InfoIcon metric={item.metric as any} />
                      </label>
                      <span className="text-xs font-mono font-black text-blue-600 bg-blue-50 px-2 py-0.5 rounded">{(weights[item.key as keyof typeof weights] * 100).toFixed(0)}%</span>
                    </div>
                    <input type="range" min="0" max="1" step="0.05" className="w-full accent-blue-600" value={weights[item.key as keyof typeof weights]} onChange={e => setWeights({...weights, [item.key]: parseFloat(e.target.value)})} />
                  </div>
                ))}
              </div>
            </div>

            {/* HARD FILTERS */}
            <div className="bg-slate-900 p-8 rounded-[2.5rem] shadow-2xl text-white">
              <h2 className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500 mb-6 flex items-center gap-2">
                <Filter size={14} /> Hard Filters (Elimination)
              </h2>
              <div className="space-y-6">
                <div>
                  <div className="flex justify-between mb-2">
                    <span className="text-[10px] font-bold text-slate-400">MAX MER: {(maxMER * 100).toFixed(2)}%</span>
                  </div>
                  <input type="range" min="0" max="0.02" step="0.0005" className="w-full accent-blue-400" value={maxMER} onChange={e => setMaxMER(parseFloat(e.target.value))} />
                </div>
                <div>
                  <div className="flex justify-between mb-2">
                    <span className="text-[10px] font-bold text-slate-400">MAX DRAWDOWN: {(maxMDD * 100).toFixed(0)}%</span>
                  </div>
                  <input type="range" min="0" max="1" step="0.05" className="w-full accent-red-400" value={maxMDD} onChange={e => setMaxMDD(parseFloat(e.target.value))} />
                </div>
              </div>
            </div>
          </div>

          {/* Visualization Panel */}
          <div className="lg:col-span-8 bg-white p-10 rounded-[3rem] shadow-xl border border-slate-100 flex flex-col min-h-[500px]">
            <div className="flex justify-between items-start mb-10">
              <div>
                <h2 className="text-2xl font-black tracking-tight">Performance Simulator</h2>
                <p className="text-slate-400 text-sm font-medium">Growth of $10,000 across selected period</p>
              </div>
              <div className="flex items-center gap-2 bg-slate-50 p-1.5 rounded-xl border border-slate-100">
                <button onClick={() => setIsNormalized(true)} className={`px-4 py-2 text-[10px] font-black rounded-lg transition-all ${isNormalized ? 'bg-white shadow-md text-blue-600' : 'text-slate-400 hover:text-slate-600'}`}>GROWTH %</button>
                <button onClick={() => setIsNormalized(false)} className={`px-4 py-2 text-[10px] font-black rounded-lg transition-all ${!isNormalized ? 'bg-white shadow-md text-blue-600' : 'text-slate-400 hover:text-slate-600'}`}>PRICE $</button>
              </div>
            </div>
            
            <div className="flex-1 w-full min-h-[350px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={historyData}>
                  <CartesianGrid strokeDasharray="10 10" vertical={false} stroke="#f1f5f9" />
                  <XAxis dataKey="Date" hide />
                  <YAxis domain={['auto', 'auto']} tick={{fontSize: 10, fontWeight: 900, fill: '#cbd5e1'}} axisLine={false} tickLine={false} tickFormatter={v => `${v}%`} />
                  <Tooltip contentStyle={{borderRadius: '24px', border: 'none', boxShadow: '0 25px 50px -12px rgb(0 0 0 / 0.15)', padding: '20px'}} itemStyle={{fontSize: '12px', fontWeight: 900}} labelStyle={{display: 'none'}} />
                  <Legend iconType="circle" wrapperStyle={{paddingTop: '20px'}} />
                  {selectedTickers.map((t, i) => (
                    <Line key={t} type="monotone" dataKey={t} stroke={chartColors[i % chartColors.length]} strokeWidth={4} dot={false} animationDuration={800} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Table Section */}
        <div className="bg-white rounded-[3rem] shadow-2xl border border-slate-100 overflow-hidden relative">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50/50 border-b border-slate-100 text-[10px] font-black text-slate-400 uppercase tracking-[0.25em]">
                  <th className="px-10 py-8 w-10 text-center">Chart</th>
                  <th className="px-4 py-8">Symbol</th>
                  <th className="px-4 py-8">Fund Name</th>
                  <th className="px-4 py-8 text-center">Score</th>
                  <th className="px-4 py-8 text-right font-black">Return</th>
                  <th className="px-4 py-8 text-right font-black">Drawdown <InfoIcon metric="mdd" /></th>
                  <th className="px-4 py-8 text-right font-black">Fees <InfoIcon metric="mer" /></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {filteredETFs.map((e, i) => (
                  <tr key={e.ticker} className={`group hover:bg-blue-50/30 transition-all cursor-pointer ${selectedTickers.includes(e.ticker) ? 'bg-blue-50/20' : ''}`} onClick={() => setSelectedTickers(prev => prev.includes(e.ticker) ? prev.filter(t => t !== e.ticker) : [...prev, e.ticker].slice(-8))}>
                    <td className="px-10 py-6">
                      <div className={`w-6 h-6 rounded-lg border-2 transition-all flex items-center justify-center ${selectedTickers.includes(e.ticker) ? 'bg-blue-600 border-blue-600 shadow-lg shadow-blue-600/30' : 'border-slate-200 bg-white group-hover:border-blue-300'}`}>
                        {selectedTickers.includes(e.ticker) && <CheckCircle2 size={14} className="text-white" />}
                      </div>
                    </td>
                    <td className="px-4 py-6 font-black text-slate-900 tracking-tight">{e.ticker}</td>
                    <td className="px-4 py-6 text-xs font-bold text-slate-500 truncate max-w-[280px]">{e.name}</td>
                    <td className="px-4 py-6 text-center">
                       <span className="text-xs font-black text-white bg-slate-900 px-4 py-1.5 rounded-full shadow-xl">
                        {e.score.toFixed(1)}
                       </span>
                    </td>
                    <td className={`px-4 py-6 text-right font-mono text-sm font-black ${e.annualReturn >= 0 ? 'text-green-600' : 'text-red-500'}`}>{(e.annualReturn * 100).toFixed(1)}%</td>
                    <td className="px-4 py-6 text-right font-mono text-sm font-bold text-red-400">{(e.maxDrawdown * 100).toFixed(1)}%</td>
                    <td className="px-4 py-6 text-right font-mono text-sm font-bold text-slate-600">{(e.mer * 100).toFixed(2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
