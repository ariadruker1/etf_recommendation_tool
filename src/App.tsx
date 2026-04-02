import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  Search, Calendar, Info, X, ChevronDown,
  Filter, RefreshCw, ExternalLink, ArrowUp, ArrowDown,
  ArrowUpDown, Check, MessageCircle, Lightbulb, ShieldCheck,
  Target, Clock, Wallet, AlertTriangle,
} from 'lucide-react';
import {
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, Area, AreaChart,
} from 'recharts';
import axios from 'axios';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ETF {
  ticker: string;
  name: string;
  yield: number;
  mer: number;
  aum: number;
  category: string;
  annualReturn: number;
  totalReturn: number;
  maxDrawdown: number;
  volatility: number;
  sortino: number;
  calmar: number;
  score: number;
}

type SortKey = 'score' | 'annualReturn' | 'sortino' | 'calmar' | 'maxDrawdown' | 'yield' | 'mer' | 'aum';
type SortDir = 'asc' | 'desc';

interface InvestorProfile {
  goal: 'growth' | 'income' | 'preservation' | 'balanced';
  horizon: 'short' | 'medium' | 'long' | 'very_long';
  riskTolerance: 'low' | 'moderate' | 'high';
  portfolioSize: 'small' | 'medium' | 'large' | 'institutional';
  feeAwareness: 'low' | 'moderate' | 'high';
}

interface AdvisorLimits {
  categories: string[];
  excludeCategories: string[];
  minAUM: number;
  maxDrawdown: number | null;
  maxMER: number | null;
  minYield: number | null;
  minReturn: number | null;
  weightPerformance: number;
  weightRisk: number;
  weightMER: number;
  weightYield: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CHART_COLORS = [
  '#2d5a9e', '#c8a24e', '#c0392b', '#1e7a4a',
  '#7b5ea7', '#d97706', '#0e7490', '#be185d',
];

const METRIC_INFO: Record<string, { label: string; desc: string; example: string; link: string }> = {
  sortino: {
    label: 'Sortino Ratio',
    desc: "Risk-adjusted return penalizing only downside volatility. Higher is better.",
    example: 'Sortino of 2.0 = earning 2x your downside risk. Below 0 = underperforming risk-free rates.',
    link: 'https://www.investopedia.com/terms/s/sortinoratio.asp',
  },
  calmar: {
    label: 'Calmar Ratio',
    desc: 'Annual return divided by maximum drawdown. Measures return per unit of "crash" risk.',
    example: '15% return / 10% drawdown = 1.5 Calmar. Higher is better.',
    link: 'https://www.investopedia.com/terms/c/calmarratio.asp',
  },
  mdd: {
    label: 'Max Drawdown',
    desc: 'Largest peak-to-trough decline. Your worst-case paper loss.',
    example: '15% MDD: a $10,000 investment dropped to $8,500 at worst.',
    link: 'https://www.investopedia.com/terms/m/maximum-drawdown-mdd.asp',
  },
  mer: {
    label: 'Management Expense Ratio',
    desc: 'Annual cost of holding the ETF. Compounds over decades.',
    example: '0.20% on $100K = $200/yr. 1.00% = $1,000/yr for the same exposure.',
    link: 'https://www.investopedia.com/terms/e/expenseratio.asp',
  },
  yield: {
    label: 'Dividend Yield',
    desc: 'Annual cash distributions as a percentage of price.',
    example: '4% yield on $50 ETF = $2.00/unit/year in dividends.',
    link: 'https://www.investopedia.com/terms/d/dividendyield.asp',
  },
};

// ─── Advisor Logic ───────────────────────────────────────────────────────────

function buildAdvisorProfile(profile: InvestorProfile): {
  limits: AdvisorLimits;
  reasoning: { key: string; text: string; icon: any }[];
  profileName: string;
  profileDesc: string;
} {
  const limits: AdvisorLimits = {
    categories: [],
    excludeCategories: ['Single Stock ETF', '-'],
    minAUM: 10_000_000,
    maxDrawdown: null,
    maxMER: null,
    minYield: null,
    minReturn: null,
    weightPerformance: 0.25,
    weightRisk: 0.25,
    weightMER: 0.25,
    weightYield: 0.25,
  };

  const reasoning: { key: string; text: string; icon: any }[] = [];
  let profileName = '';
  let profileDesc = '';

  // Always exclude single-stock and unclassified
  reasoning.push({
    key: 'quality',
    text: 'We automatically filtered out single-stock ETFs (which just track one company — that\'s not diversification) and unclassified funds with unreliable data.',
    icon: ShieldCheck,
  });

  // Goal-based adjustments
  switch (profile.goal) {
    case 'growth':
      profileName = 'Growth Investor';
      profileDesc = 'Maximize long-term capital appreciation.';
      limits.weightPerformance = 0.45;
      limits.weightRisk = 0.25;
      limits.weightMER = 0.20;
      limits.weightYield = 0.10;
      limits.categories = ['Equity', 'Alternative'];
      reasoning.push({
        key: 'goal',
        text: 'Since you\'re focused on growth, we\'re showing stock-based (Equity) and Alternative funds — these have historically offered the best long-term returns. Dividend income is weighted low because at this stage, you want compound growth, not cash payouts.',
        icon: Target,
      });
      break;
    case 'income':
      profileName = 'Income Investor';
      profileDesc = 'Generate reliable cash flow from dividends.';
      limits.weightPerformance = 0.15;
      limits.weightRisk = 0.25;
      limits.weightMER = 0.20;
      limits.weightYield = 0.40;
      limits.minYield = 0.02;
      limits.categories = ['Equity', 'Fixed Income', 'Preferred Share'];
      reasoning.push({
        key: 'goal',
        text: 'We\'re showing funds that actually pay you — dividend stocks, bonds, and preferred shares. Any ETF paying less than 2% in dividends is excluded because it won\'t generate meaningful income for you.',
        icon: Target,
      });
      break;
    case 'preservation':
      profileName = 'Capital Preserver';
      profileDesc = 'Protect principal above all else.';
      limits.weightPerformance = 0.10;
      limits.weightRisk = 0.45;
      limits.weightMER = 0.25;
      limits.weightYield = 0.20;
      limits.maxDrawdown = 0.10;
      limits.categories = ['Fixed Income', 'Cash/Currency', 'Asset Allocation'];
      reasoning.push({
        key: 'goal',
        text: 'We\'re only showing the safest categories — bonds, cash equivalents, and balanced funds. Any fund that has dropped more than 10% from its peak during the selected period is excluded. Your priority is not losing money.',
        icon: Target,
      });
      break;
    case 'balanced':
    default:
      profileName = 'Balanced Investor';
      profileDesc = 'Grow steadily while managing risk.';
      limits.weightPerformance = 0.30;
      limits.weightRisk = 0.30;
      limits.weightMER = 0.20;
      limits.weightYield = 0.20;
      limits.categories = ['Equity', 'Fixed Income', 'Asset Allocation', 'Alternative'];
      reasoning.push({
        key: 'goal',
        text: 'We\'re showing a healthy mix — stocks for growth, bonds for stability, and balanced funds that do both. Growth and safety are weighted equally, so you get the best of both worlds without too much risk.',
        icon: Target,
      });
      break;
  }

  // Horizon adjustments
  switch (profile.horizon) {
    case 'short':
      limits.maxDrawdown = Math.min(limits.maxDrawdown ?? 0.15, 0.15);
      limits.weightRisk += 0.10;
      limits.weightPerformance -= 0.10;
      reasoning.push({
        key: 'horizon',
        text: 'Since you need this money within 2 years, we\'re being extra cautious. A 15% drop right before you need the cash could set you back significantly. Honestly, if you need this money very soon, a high-interest savings account might be safer than any ETF.',
        icon: Clock,
      });
      break;
    case 'medium':
      reasoning.push({
        key: 'horizon',
        text: 'With 2-5 years, you have some room to recover from dips but not enough to ride out a deep bear market (which can take 3-5 years to fully recover from). We\'re keeping things moderate.',
        icon: Clock,
      });
      break;
    case 'long':
      reasoning.push({
        key: 'horizon',
        text: '5-10 years is a great investing timeframe. You can handle short-term drops because you have time for the market to recover. This is where the power of compounding really starts to show.',
        icon: Clock,
      });
      break;
    case 'very_long':
      limits.maxDrawdown = null;
      reasoning.push({
        key: 'horizon',
        text: 'With 10+ years, time is your superpower. Every major market crash in history — 2008, 2020, dot-com — fully recovered within this timeframe. We\'ve removed all drawdown limits because short-term drops don\'t matter when you\'re playing the long game.',
        icon: Clock,
      });
      break;
  }

  // Risk tolerance
  switch (profile.riskTolerance) {
    case 'low':
      limits.maxDrawdown = Math.min(limits.maxDrawdown ?? 0.10, 0.10);
      limits.excludeCategories.push('Leverage/Inverse', 'Cryptocurrency');
      reasoning.push({
        key: 'risk',
        text: 'Since big drops would cause you real stress, we\'ve removed leveraged ETFs (which amplify gains AND losses — often 2x or 3x), inverse ETFs (which bet against the market), and crypto ETFs. We also capped the maximum historical drop at 10%.',
        icon: AlertTriangle,
      });
      break;
    case 'moderate':
      limits.excludeCategories.push('Leverage/Inverse');
      reasoning.push({
        key: 'risk',
        text: 'Leveraged and inverse ETFs are excluded — these are short-term trading tools, not investments you hold. They can lose money even when the market goes up due to daily rebalancing. Crypto is still available but will naturally rank lower because of its volatility.',
        icon: AlertTriangle,
      });
      break;
    case 'high':
      reasoning.push({
        key: 'risk',
        text: 'All categories are available to you. Just remember: the ability to tolerate risk is only valuable if you actually stay disciplined during a downturn. The worst thing you can do is sell at the bottom after telling yourself you wouldn\'t.',
        icon: AlertTriangle,
      });
      break;
  }

  // Fee awareness
  switch (profile.feeAwareness) {
    case 'low':
      reasoning.push({
        key: 'fees',
        text: 'No fee cap applied. Some actively managed funds charge higher fees (1%+) because a team of analysts is picking investments for you. The research is mixed on whether this is worth it — many expensive funds underperform cheap index funds over time.',
        icon: Wallet,
      });
      break;
    case 'moderate':
      limits.maxMER = limits.maxMER ? Math.min(limits.maxMER, 0.0075) : 0.0075;
      limits.weightMER = 0.25;
      reasoning.push({
        key: 'fees',
        text: 'Fees capped at 0.75% per year. For context, on a $100,000 portfolio that\'s $750/year taken automatically from your returns. This keeps out the most expensive funds while still allowing some actively managed options.',
        icon: Wallet,
      });
      break;
    case 'high':
      limits.maxMER = limits.maxMER ? Math.min(limits.maxMER, 0.004) : 0.004;
      limits.weightMER = 0.35;
      reasoning.push({
        key: 'fees',
        text: 'Fees capped at 0.40%. You\'ll mostly see passive index ETFs — funds that simply track a market index like the S&P 500 instead of paying analysts to pick stocks. Study after study shows these beat most actively managed funds over 10+ years, largely because of lower fees.',
        icon: Wallet,
      });
      break;
  }

  // Portfolio size → AUM floor
  switch (profile.portfolioSize) {
    case 'small':
      limits.minAUM = 10_000_000;
      reasoning.push({
        key: 'size',
        text: 'We\'re only showing funds with at least $10M in total assets. Tiny funds can be hard to buy and sell, have wider price spreads, and sometimes close down entirely — which forces an inconvenient sale.',
        icon: Wallet,
      });
      break;
    case 'medium':
      limits.minAUM = 25_000_000;
      reasoning.push({
        key: 'size',
        text: 'Minimum fund size set to $25M. At your investment level, you want funds that trade smoothly with tight bid-ask spreads. Small funds can have hidden costs when you go to sell.',
        icon: Wallet,
      });
      break;
    case 'large':
      limits.minAUM = 50_000_000;
      limits.maxMER = 0.0075;
      reasoning.push({
        key: 'size',
        text: 'Minimum fund size $50M. At $100K+ invested, even small fee differences add up fast — the difference between 0.20% and 0.70% MER on $200K is $1,000 per year, every year, compounding.',
        icon: Wallet,
      });
      break;
    case 'institutional':
      limits.minAUM = 100_000_000;
      limits.maxMER = 0.005;
      reasoning.push({
        key: 'size',
        text: 'Only showing funds with $100M+ in assets and fees under 0.50%. At your portfolio size, you should be in the same funds that pension plans and institutions use — the most liquid, lowest-cost options available.',
        icon: Wallet,
      });
      break;
  }

  return { limits, reasoning, profileName, profileDesc };
}

// ─── Small Components ────────────────────────────────────────────────────────

const MetricTooltip = ({ id }: { id: keyof typeof METRIC_INFO }) => {
  const m = METRIC_INFO[id];
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <span className="relative inline-flex" ref={ref}>
      <button onClick={(e) => { e.stopPropagation(); setOpen(!open); }} className="ml-1 text-[var(--muted)] hover:text-[var(--accent)] transition-colors">
        <Info size={11} />
      </button>
      {open && (
        <div className="panel-enter absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-72 bg-[var(--ink)] text-white rounded-lg shadow-2xl z-50 overflow-hidden">
          <div className="p-4">
            <div className="text-[var(--accent)] font-semibold text-xs tracking-wide uppercase mb-1.5">{m.label}</div>
            <p className="text-[13px] leading-relaxed text-slate-300 mb-3">{m.desc}</p>
            <div className="bg-white/5 rounded-md p-2.5 text-[12px] text-slate-400 leading-relaxed border-l-2 border-[var(--accent)]">{m.example}</div>
          </div>
          <a href={m.link} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 px-4 py-2.5 bg-white/5 text-[11px] font-semibold text-[var(--accent)] hover:bg-white/10 transition-colors">
            Learn more <ExternalLink size={10} />
          </a>
        </div>
      )}
    </span>
  );
};

const formatAUM = (val: number): string => {
  if (val >= 1e9) return `$${(val / 1e9).toFixed(1)}B`;
  if (val >= 1e6) return `$${(val / 1e6).toFixed(0)}M`;
  if (val >= 1e3) return `$${(val / 1e3).toFixed(0)}K`;
  if (val > 0) return `$${val.toFixed(0)}`;
  return '—';
};

const SortableHeader = ({ label, sortKey: sk, currentKey, dir, onClick, align, info, className }: {
  label: string; sortKey: SortKey; currentKey: SortKey; dir: SortDir;
  onClick: (k: SortKey) => void; align?: 'right'; info?: keyof typeof METRIC_INFO; className?: string;
}) => {
  const active = currentKey === sk;
  return (
    <th className={`px-3 py-3 cursor-pointer select-none hover:text-[var(--ink)] transition-colors whitespace-nowrap ${align === 'right' ? 'text-right' : ''} ${className ?? ''}`} onClick={() => onClick(sk)}>
      <span className="inline-flex items-center gap-1">
        {label}
        {info && <MetricTooltip id={info} />}
        {active ? (dir === 'desc' ? <ArrowDown size={10} className="text-[var(--accent)]" /> : <ArrowUp size={10} className="text-[var(--accent)]" />) : <ArrowUpDown size={9} className="opacity-30" />}
      </span>
    </th>
  );
};

// ─── Onboarding Flow ─────────────────────────────────────────────────────────

const DEFAULT_PROFILE: InvestorProfile = {
  goal: 'balanced', horizon: 'long', riskTolerance: 'moderate', portfolioSize: 'medium', feeAwareness: 'moderate',
};

const OnboardingFlow = ({ onComplete }: { onComplete: (profile: InvestorProfile) => void }) => {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Partial<InvestorProfile>>({});

  const steps = [
    {
      question: "What matters most to you right now?",
      subtitle: "Think about why you're investing — there's no wrong answer. This helps us focus on the right type of ETF for your situation.",
      learn: { text: "What is an ETF?", url: "https://www.investopedia.com/terms/e/etf.asp" },
      key: 'goal' as const,
      options: [
        { value: 'growth', label: 'I want my money to grow over time', desc: 'You\'re not planning to touch this money soon — you want it to build wealth. We\'ll focus on stock-based ETFs with the strongest track records.', icon: TrendingUpIcon },
        { value: 'income', label: 'I want regular cash coming in', desc: 'You want investments that pay you dividends — real money deposited into your account regularly, like a paycheque from your portfolio.', icon: CashIcon },
        { value: 'preservation', label: 'I don\'t want to lose what I have', desc: 'Safety first. We\'ll focus on stable, lower-risk funds like bonds and cash equivalents — they won\'t grow fast, but they won\'t keep you up at night.', icon: ShieldIcon },
        { value: 'balanced', label: 'A healthy mix of growth and safety', desc: 'You want your money to grow, but you also want to sleep at night. We\'ll blend stock funds with bonds for a smoother ride.', icon: BalanceIcon },
      ],
    },
    {
      question: "When will you need this money?",
      subtitle: "This is one of the most important questions in investing. The longer you can leave your money invested, the more risk you can afford to take — because you have time to recover from any dips.",
      learn: { text: "Why time horizon matters", url: "https://www.investopedia.com/terms/t/timehorizon.asp" },
      key: 'horizon' as const,
      options: [
        { value: 'short', label: 'Within the next 2 years', desc: 'Since you may need this money soon, we\'ll avoid anything too volatile. A big drop right before you need the cash would be devastating.', icon: null },
        { value: 'medium', label: 'In about 2 to 5 years', desc: 'You have some room for ups and downs, but not enough to ride out a major crash. We\'ll keep things moderate.', icon: null },
        { value: 'long', label: '5 to 10 years from now', desc: 'Great — this is real investing territory. You can ride out a bad year or two because you have time for the market to recover.', icon: null },
        { value: 'very_long', label: '10+ years (retirement, long-term savings)', desc: 'This is the sweet spot. Historically, the stock market has always recovered over 10+ years. Time is your biggest advantage.', icon: null },
      ],
    },
    {
      question: "Imagine you invested $10,000 and it dropped to $8,000. What would you do?",
      subtitle: "This isn't a test — it's about self-awareness. The best investment plan is one you can actually stick with when markets get rough. Most people overestimate their risk tolerance until they see real losses.",
      learn: { text: "Understanding risk tolerance", url: "https://www.investopedia.com/terms/r/risktolerance.asp" },
      key: 'riskTolerance' as const,
      options: [
        { value: 'low', label: 'I\'d probably sell — I can\'t watch it drop further', desc: 'That\'s completely okay. We\'ll filter out anything that could swing that much. Steady and predictable is the goal.', icon: null },
        { value: 'moderate', label: 'I\'d feel sick but I\'d hold on', desc: 'You can handle some turbulence as long as it\'s not extreme. We\'ll exclude the riskiest categories but keep solid options on the table.', icon: null },
        { value: 'high', label: 'I\'d buy more — stocks are on sale', desc: 'You understand that drops are temporary and that volatility is the price of higher returns. We\'ll keep all options available.', icon: null },
      ],
    },
    {
      question: "Roughly how much are you planning to invest?",
      subtitle: "This isn't about judgement — it's about liquidity and fees. Larger portfolios need ETFs that trade easily (high volume) and where even tiny fee differences add up to real money.",
      learn: { text: "Why fund size matters", url: "https://www.investopedia.com/terms/a/aum.asp" },
      key: 'portfolioSize' as const,
      options: [
        { value: 'small', label: 'Under $25,000', desc: 'Great starting point. We\'ll make sure you\'re in funds with enough daily trading volume that you can buy and sell without issues.', icon: null },
        { value: 'medium', label: '$25,000 to $100,000', desc: 'At this level, liquidity starts to matter more. We\'ll stick to well-established funds with real trading volume.', icon: null },
        { value: 'large', label: '$100,000 to $500,000', desc: 'At this scale, a 0.5% fee difference costs you $500–$2,500 per year. We\'ll prioritize cost-efficient, highly liquid funds.', icon: null },
        { value: 'institutional', label: 'Over $500,000', desc: 'Every basis point matters. We\'ll only show the most liquid, lowest-cost funds — the kind institutional investors use.', icon: null },
      ],
    },
    {
      question: "How do you feel about the fees ETFs charge?",
      subtitle: "Every ETF charges an annual fee (called the MER — Management Expense Ratio). It's taken automatically from your returns. The difference between a 0.10% fee and a 1.00% fee on $100,000 is $900/year — and it compounds over decades.",
      learn: { text: "How fees eat your returns", url: "https://www.investopedia.com/articles/personal-finance/092613/pay-attention-your-funds-expense-ratio.asp" },
      key: 'feeAwareness' as const,
      options: [
        { value: 'low', label: 'I care more about performance than fees', desc: 'That\'s a valid perspective — some actively managed funds charge more because they aim to beat the market. Just keep in mind that most don\'t succeed long-term.', icon: null },
        { value: 'moderate', label: 'Keep fees reasonable — under 0.75%', desc: 'A good middle ground. This filters out the most expensive active funds while keeping quality options available.', icon: null },
        { value: 'high', label: 'Give me the cheapest options possible', desc: 'Smart. Research consistently shows that low-cost index funds outperform most actively managed funds over 10+ years. We\'ll cap fees at 0.40%.', icon: null },
      ],
    },
  ];

  const currentStep = steps[step];

  const selectOption = (value: string) => {
    const newAnswers = { ...answers, [currentStep.key]: value };
    setAnswers(newAnswers);

    if (step < steps.length - 1) {
      setTimeout(() => setStep(step + 1), 200);
    } else {
      setTimeout(() => onComplete(newAnswers as InvestorProfile), 300);
    }
  };

  return (
    <div className="noise-bg min-h-screen flex items-center justify-center p-6">
      <div className="max-w-xl w-full">
        {/* Progress */}
        <div className="flex gap-2 mb-10">
          {steps.map((_, i) => (
            <div key={i} className={`h-1 flex-1 rounded-full transition-all duration-500 ${i <= step ? 'bg-[var(--ink)]' : 'bg-[var(--border)]'}`} />
          ))}
        </div>

        {/* Greeting on first step */}
        {step === 0 && (
          <div className="mb-10 panel-enter">
            <h1 className="text-4xl md:text-5xl mb-3" style={{ fontFamily: 'Instrument Serif, serif' }}>
              Let's find the right ETFs for you.
            </h1>
            <p className="text-[var(--muted)] text-lg leading-relaxed mb-4">
              There are over 1,680 ETFs listed on the TSX. Most of them aren't right for you. Answer five quick questions and we'll narrow it down to the ones that actually fit your goals, timeline, and comfort level.
            </p>
            <button
              onClick={() => onComplete(DEFAULT_PROFILE)}
              className="text-sm text-[var(--muted)] hover:text-[var(--ink)] underline underline-offset-4 transition-colors"
            >
              Skip &mdash; use balanced defaults
            </button>
          </div>
        )}

        {/* Question */}
        <div className="panel-enter" key={step}>
          <div className="mb-2 text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">
            Question {step + 1} of {steps.length}
          </div>
          <h2 className="text-2xl font-semibold mb-2 tracking-tight">{currentStep.question}</h2>
          <p className="text-[var(--muted)] text-sm leading-relaxed mb-2">{currentStep.subtitle}</p>
          {currentStep.learn && (
            <a href={currentStep.learn.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)] hover:underline mb-6">
              <ExternalLink size={10} /> {currentStep.learn.text} — Investopedia
            </a>
          )}
          {!currentStep.learn && <div className="mb-6" />}

          <div className="space-y-3">
            {currentStep.options.map((opt) => {
              const selected = answers[currentStep.key] === opt.value;
              return (
                <button
                  key={opt.value}
                  onClick={() => selectOption(opt.value)}
                  className={`w-full text-left p-5 rounded-xl border-2 transition-all group ${
                    selected
                      ? 'border-[var(--ink)] bg-[var(--ink)] text-white'
                      : 'border-[var(--border)] bg-[var(--surface)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-semibold text-[15px]">{opt.label}</div>
                      <div className={`text-sm mt-0.5 ${selected ? 'text-white/70' : 'text-[var(--muted)]'}`}>{opt.desc}</div>
                    </div>
                    {selected && <Check size={18} />}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Navigation */}
        <div className="mt-6 flex items-center justify-between">
          {step > 0 ? (
            <button onClick={() => setStep(step - 1)} className="text-sm text-[var(--muted)] hover:text-[var(--ink)] transition-colors">
              &larr; Back
            </button>
          ) : <span />}
          <button
            onClick={() => {
              const filled: InvestorProfile = {
                goal: (answers.goal as any) || DEFAULT_PROFILE.goal,
                horizon: (answers.horizon as any) || DEFAULT_PROFILE.horizon,
                riskTolerance: (answers.riskTolerance as any) || DEFAULT_PROFILE.riskTolerance,
                portfolioSize: (answers.portfolioSize as any) || DEFAULT_PROFILE.portfolioSize,
                feeAwareness: (answers.feeAwareness as any) || DEFAULT_PROFILE.feeAwareness,
              };
              onComplete(filled);
            }}
            className="text-sm text-[var(--muted)] hover:text-[var(--ink)] transition-colors"
          >
            Skip remaining &rarr;
          </button>
        </div>
      </div>
    </div>
  );
};

// Small inline SVG icons for onboarding (avoids importing more from lucide)
const TrendingUpIcon = () => null;
const CashIcon = () => null;
const ShieldIcon = () => null;
const BalanceIcon = () => null;

// ─── Advisor Panel ───────────────────────────────────────────────────────────

const AdvisorPanel = ({
  profileName, profileDesc, reasoning, limits, onReset, collapsed, onToggle,
}: {
  profileName: string; profileDesc: string;
  reasoning: { key: string; text: string; icon: any }[];
  limits: AdvisorLimits;
  onReset: () => void;
  collapsed: boolean;
  onToggle: () => void;
}) => {
  return (
    <div className="bg-[var(--surface)] rounded-xl border border-[var(--border)] overflow-hidden">
      {/* Header — always visible */}
      <button onClick={onToggle} className="w-full flex items-center justify-between px-5 py-4 hover:bg-[var(--surface-hover)] transition-colors">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-[var(--ink)] flex items-center justify-center flex-shrink-0">
            <MessageCircle size={14} className="text-[var(--accent)]" />
          </div>
          <div className="text-left">
            <div className="text-sm font-semibold">{profileName}</div>
            <div className="text-xs text-[var(--muted)]">{profileDesc}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={(e) => { e.stopPropagation(); onReset(); }}
            className="text-[11px] text-[var(--muted)] hover:text-[var(--red)] font-medium px-2 py-1 rounded hover:bg-[var(--paper)] transition-colors"
          >
            Retake quiz
          </button>
          <ChevronDown size={14} className={`text-[var(--muted)] transition-transform ${collapsed ? '' : 'rotate-180'}`} />
        </div>
      </button>

      {/* Reasoning — collapsible */}
      {!collapsed && (
        <div className="px-5 pb-5 border-t border-[var(--border)]">
          <div className="pt-4 space-y-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">
              <Lightbulb size={12} />
              Why these filters?
            </div>
            {reasoning.map((r) => {
              const Icon = r.icon;
              return (
                <div key={r.key} className="flex gap-3 text-sm text-[var(--ink)]/80 leading-relaxed">
                  <Icon size={14} className="text-[var(--accent)] flex-shrink-0 mt-0.5" />
                  <span>{r.text}</span>
                </div>
              );
            })}

            {/* Active limits summary */}
            <div className="mt-4 pt-4 border-t border-[var(--border)] flex flex-wrap gap-2">
              {limits.categories.length > 0 && (
                <span className="px-2.5 py-1 bg-[var(--paper)] rounded-md text-[11px] font-medium text-[var(--muted)]">
                  {limits.categories.join(', ')}
                </span>
              )}
              <span className="px-2.5 py-1 bg-[var(--paper)] rounded-md text-[11px] font-medium text-[var(--muted)]">
                AUM &ge; {formatAUM(limits.minAUM)}
              </span>
              {limits.maxDrawdown !== null && (
                <span className="px-2.5 py-1 bg-[var(--paper)] rounded-md text-[11px] font-medium text-[var(--muted)]">
                  Drawdown &le; {(limits.maxDrawdown * 100).toFixed(0)}%
                </span>
              )}
              {limits.maxMER !== null && (
                <span className="px-2.5 py-1 bg-[var(--paper)] rounded-md text-[11px] font-medium text-[var(--muted)]">
                  MER &le; {(limits.maxMER * 100).toFixed(2)}%
                </span>
              )}
              {limits.minYield !== null && (
                <span className="px-2.5 py-1 bg-[var(--paper)] rounded-md text-[11px] font-medium text-[var(--muted)]">
                  Yield &ge; {(limits.minYield * 100).toFixed(0)}%
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Limit Override Panel ────────────────────────────────────────────────────

const LimitOverrides = ({
  limits, allCategories, onChange,
}: {
  limits: AdvisorLimits;
  allCategories: string[];
  onChange: (newLimits: AdvisorLimits) => void;
}) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggleCategory = (cat: string) => {
    const current = limits.categories;
    if (current.length === 0) {
      // Currently showing all — switch to all-except-this
      onChange({ ...limits, categories: allCategories.filter(c => c !== cat) });
    } else if (current.includes(cat)) {
      onChange({ ...limits, categories: current.filter(c => c !== cat) });
    } else {
      onChange({ ...limits, categories: [...current, cat] });
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-4 py-2.5 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-sm font-medium hover:border-[var(--border-strong)] transition-colors"
      >
        <Filter size={13} />
        Adjust Limits
        <ChevronDown size={12} className="text-[var(--muted)]" />
      </button>
      {open && (
        <div className="panel-enter absolute top-full mt-2 right-0 z-40 bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-xl w-[380px] p-5 max-h-[70vh] overflow-y-auto">
          <div className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider mb-4">
            Override advisor limits
          </div>

          {/* Asset Classes */}
          <div className="mb-5">
            <div className="text-sm font-medium mb-2.5">Asset Classes</div>
            <div className="flex flex-wrap gap-1.5">
              {allCategories.map(cat => {
                const isActive = limits.categories.length === 0 || limits.categories.includes(cat);
                const isExcluded = limits.excludeCategories.includes(cat);
                return (
                  <button
                    key={cat}
                    onClick={() => !isExcluded && toggleCategory(cat)}
                    className={`px-2.5 py-1.5 text-[11px] font-semibold rounded-md transition-all ${
                      isExcluded
                        ? 'bg-[var(--paper)] text-[var(--border-strong)] line-through cursor-not-allowed'
                        : isActive
                          ? 'bg-[var(--ink)] text-white'
                          : 'bg-[var(--paper)] text-[var(--muted)] hover:text-[var(--ink)]'
                    }`}
                    title={isExcluded ? 'Excluded by advisor — retake quiz to change' : ''}
                  >
                    {cat}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Numeric limits */}
          <div className="space-y-4">
            <LimitSlider
              label="Min Fund Size (AUM)"
              value={limits.minAUM}
              onChange={v => onChange({ ...limits, minAUM: v })}
              min={0} max={500_000_000} step={5_000_000}
              format={formatAUM}
            />
            <LimitSlider
              label="Max Drawdown"
              value={limits.maxDrawdown ?? 1}
              onChange={v => onChange({ ...limits, maxDrawdown: v >= 1 ? null : v })}
              min={0.05} max={1} step={0.05}
              format={v => v >= 1 ? 'No limit' : `${(v * 100).toFixed(0)}%`}
            />
            <LimitSlider
              label="Max MER (Fees)"
              value={limits.maxMER ?? 0.03}
              onChange={v => onChange({ ...limits, maxMER: v >= 0.03 ? null : v })}
              min={0.001} max={0.03} step={0.0005}
              format={v => v >= 0.03 ? 'No limit' : `${(v * 100).toFixed(2)}%`}
            />
            <LimitSlider
              label="Min Dividend Yield"
              value={limits.minYield ?? 0}
              onChange={v => onChange({ ...limits, minYield: v <= 0 ? null : v })}
              min={0} max={0.10} step={0.005}
              format={v => v <= 0 ? 'No minimum' : `${(v * 100).toFixed(1)}%`}
            />
          </div>
        </div>
      )}
    </div>
  );
};

const LimitSlider = ({ label, value, onChange, min, max, step, format }: {
  label: string; value: number; onChange: (v: number) => void;
  min: number; max: number; step: number; format: (v: number) => string;
}) => (
  <div>
    <div className="flex justify-between mb-1.5">
      <span className="text-sm font-medium">{label}</span>
      <span className="text-sm font-mono font-semibold text-[var(--accent)]">{format(value)}</span>
    </div>
    <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(parseFloat(e.target.value))} className="w-full" />
  </div>
);

// ─── Main App ────────────────────────────────────────────────────────────────

const App = () => {
  const [profile, setProfile] = useState<InvestorProfile | null>(null);
  const [advisorResult, setAdvisorResult] = useState<ReturnType<typeof buildAdvisorProfile> | null>(null);
  const [limits, setLimits] = useState<AdvisorLimits | null>(null);
  const [advisorCollapsed, setAdvisorCollapsed] = useState(true);

  const [etfs, setEtfs] = useState<ETF[]>([]);
  const [historyData, setHistoryData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [isNormalized, setIsNormalized] = useState(true);
  const [selectedTickers, setSelectedTickers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [sortKey, setSortKey] = useState<SortKey>('score');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const [dateRange, setDateRange] = useState({
    start: '2024-01-01',
    end: new Date().toISOString().split('T')[0],
  });

  // Fetch categories once
  useEffect(() => {
    axios.get(`${API}/categories`).then(r => setCategories(r.data)).catch(() => {});
  }, []);

  // Handle onboarding completion
  const handleProfileComplete = (p: InvestorProfile) => {
    setProfile(p);
    const result = buildAdvisorProfile(p);
    setAdvisorResult(result);
    setLimits(result.limits);
  };

  const handleReset = () => {
    setProfile(null);
    setAdvisorResult(null);
    setLimits(null);
    setEtfs([]);
    setSelectedTickers([]);
    setHistoryData([]);
    setSearchTerm('');
  };

  const fetchRankings = useCallback(async () => {
    if (!limits) return;
    setLoading(true);
    try {
      const params: Record<string, any> = {
        start: dateRange.start, end: dateRange.end,
        weight_performance: limits.weightPerformance,
        weight_risk: limits.weightRisk,
        weight_mer: limits.weightMER,
        weight_yield: limits.weightYield,
        min_aum: limits.minAUM,
        search: searchTerm || undefined,
      };
      if (limits.categories.length > 0) params.categories = limits.categories.join(',');
      if (limits.excludeCategories.length > 0) params.exclude_categories = limits.excludeCategories.join(',');
      if (limits.maxDrawdown !== null) params.max_drawdown = limits.maxDrawdown;
      if (limits.maxMER !== null) params.max_mer = limits.maxMER;
      if (limits.minYield !== null) params.min_yield = limits.minYield;
      if (limits.minReturn !== null) params.min_return = limits.minReturn;

      const res = await axios.get(`${API}/rank`, { params });
      setEtfs(res.data);
      if (selectedTickers.length === 0 && res.data.length > 0) {
        setSelectedTickers(res.data.slice(0, 3).map((e: ETF) => e.ticker));
      }
    } catch {
      setError('Could not reach the backend. Run: python3 backend/main.py');
    } finally {
      setLoading(false);
    }
  }, [limits, dateRange, searchTerm]);

  const fetchHistory = useCallback(async () => {
    if (selectedTickers.length === 0) { setHistoryData([]); return; }
    try {
      // FastAPI expects repeated query params for lists: ?tickers=A&tickers=B
      const tickerParams = selectedTickers.map(t => `tickers=${encodeURIComponent(t)}`).join('&');
      const res = await axios.get(
        `${API}/history?${tickerParams}&start=${dateRange.start}&end=${dateRange.end}&normalized=${isNormalized}`
      );
      setHistoryData(res.data);
    } catch {}
  }, [selectedTickers, dateRange, isNormalized]);

  useEffect(() => {
    const t = setTimeout(fetchRankings, 500);
    return () => clearTimeout(t);
  }, [fetchRankings]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  const toggleTicker = (ticker: string) => {
    setSelectedTickers(prev => prev.includes(ticker) ? prev.filter(t => t !== ticker) : [...prev, ticker].slice(-8));
  };

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  const displayETFs = useMemo(() => {
    return [...etfs].sort((a, b) => {
      const mul = sortDir === 'desc' ? -1 : 1;
      return mul * ((a[sortKey] ?? 0) - (b[sortKey] ?? 0));
    });
  }, [etfs, sortKey, sortDir]);

  const maxScore = useMemo(() => Math.max(...displayETFs.map(e => e.score), 1), [displayETFs]);

  // ─── Show onboarding if no profile ───
  if (!profile) {
    return <OnboardingFlow onComplete={handleProfileComplete} />;
  }

  if (error) {
    return (
      <div className="noise-bg min-h-screen flex items-center justify-center p-8">
        <div className="text-center max-w-md">
          <div className="text-5xl mb-6" style={{ fontFamily: 'Instrument Serif, serif' }}>Connection Error</div>
          <p className="text-[var(--muted)] mb-4">{error}</p>
          <button onClick={() => { setError(null); fetchRankings(); }} className="px-6 py-2.5 bg-[var(--ink)] text-white rounded-lg text-sm font-semibold">Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="noise-bg min-h-screen p-4 md:p-6 lg:p-8">
      <div className="max-w-[1400px] mx-auto">

        {/* ═══ HEADER ═══ */}
        <header className="mb-6">
          <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 mb-5">
            <div>
              <h1 className="text-4xl md:text-5xl tracking-tight mb-1" style={{ fontFamily: 'Instrument Serif, serif' }}>
                TSX ETF Ranker
              </h1>
              <p className="text-[var(--muted)] text-sm">
                {displayETFs.length} ETFs matched your profile
                {loading && <span className="pulse-subtle ml-2">&middot; updating...</span>}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 bg-[var(--surface)] px-4 py-2.5 rounded-lg border border-[var(--border)] text-sm">
                <Calendar size={14} className="text-[var(--muted)]" />
                <input type="date" value={dateRange.start} onChange={e => setDateRange(p => ({ ...p, start: e.target.value }))} className="bg-transparent outline-none font-medium w-[120px]" />
                <span className="text-[var(--border-strong)]">/</span>
                <input type="date" value={dateRange.end} onChange={e => setDateRange(p => ({ ...p, end: e.target.value }))} className="bg-transparent outline-none font-medium w-[120px]" />
              </div>
              <button
                onClick={async () => { setRefreshing(true); try { await axios.get(`${API}/refresh-cache`); await fetchRankings(); } finally { setRefreshing(false); } }}
                className="p-2.5 bg-[var(--surface)] rounded-lg border border-[var(--border)] hover:border-[var(--border-strong)] transition-colors"
                title="Refresh price data"
              >
                <RefreshCw size={14} className={`text-[var(--muted)] ${refreshing ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          {/* Toolbar: search + limit overrides */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px] max-w-[360px]">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
              <input
                type="text" placeholder="Search ticker or name..."
                value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-4 py-2.5 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-sm outline-none focus:border-[var(--accent)] transition-colors placeholder:text-[var(--border-strong)]"
              />
            </div>
            <div className="flex-1" />
            {limits && (
              <LimitOverrides limits={limits} allCategories={categories} onChange={setLimits} />
            )}
          </div>
        </header>

        {/* ═══ ADVISOR PANEL ═══ */}
        {advisorResult && limits && (
          <div className="mb-6">
            <AdvisorPanel
              profileName={advisorResult.profileName}
              profileDesc={advisorResult.profileDesc}
              reasoning={advisorResult.reasoning}
              limits={limits}
              onReset={handleReset}
              collapsed={advisorCollapsed}
              onToggle={() => setAdvisorCollapsed(!advisorCollapsed)}
            />
          </div>
        )}

        {/* ═══ CHART ═══ */}
        <section className="bg-[var(--surface)] rounded-xl border border-[var(--border)] mb-6 overflow-hidden">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-6 py-4 border-b border-[var(--border)]">
            <div className="flex items-center gap-4">
              <h2 className="text-lg font-semibold" style={{ fontFamily: 'Instrument Serif, serif' }}>
                {isNormalized ? 'Side-by-Side Comparison' : 'Price History'}
              </h2>
              {isNormalized && (
                <span className="text-[11px] text-[var(--muted)] hidden sm:inline">All start at 100 so you can compare fairly</span>
              )}
              <div className="flex bg-[var(--paper)] rounded-md p-0.5 border border-[var(--border)]">
                <button onClick={() => setIsNormalized(true)} className={`px-3 py-1 text-[11px] font-semibold rounded transition-all ${isNormalized ? 'bg-[var(--surface)] shadow-sm text-[var(--ink)]' : 'text-[var(--muted)]'}`}>Growth %</button>
                <button onClick={() => setIsNormalized(false)} className={`px-3 py-1 text-[11px] font-semibold rounded transition-all ${!isNormalized ? 'bg-[var(--surface)] shadow-sm text-[var(--ink)]' : 'text-[var(--muted)]'}`}>Price $</button>
              </div>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {selectedTickers.length === 0 && <span className="text-xs text-[var(--muted)] italic">Click rows below to compare</span>}
              {selectedTickers.map((t, i) => (
                <button key={t} onClick={() => toggleTicker(t)} className="chip-enter flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-md text-xs font-semibold text-white hover:opacity-80 transition-opacity" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }}>
                  {t.replace('.TO', '')} <X size={11} />
                </button>
              ))}
              {selectedTickers.length > 1 && (
                <button
                  onClick={() => setSelectedTickers([])}
                  className="flex items-center gap-1 pl-2 pr-2 py-1 rounded-md text-[11px] font-medium text-[var(--muted)] hover:text-[var(--red)] bg-[var(--paper)] hover:bg-red-50 border border-[var(--border)] transition-colors"
                >
                  Clear all <X size={10} />
                </button>
              )}
            </div>
          </div>

          <div className="h-[320px] px-2">
            {historyData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={historyData} margin={{ top: 20, right: 20, bottom: 10, left: 10 }}>
                  <defs>
                    {selectedTickers.map((t, i) => (
                      <linearGradient key={t} id={`grad-${i}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={CHART_COLORS[i % CHART_COLORS.length]} stopOpacity={0.12} />
                        <stop offset="100%" stopColor={CHART_COLORS[i % CHART_COLORS.length]} stopOpacity={0} />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="Date" tick={{ fontSize: 10, fill: 'var(--muted)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" tickFormatter={v => new Date(v).toLocaleDateString('en-CA', { month: 'short', year: '2-digit' })} />
                  <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10, fill: 'var(--muted)', fontFamily: 'JetBrains Mono' }} axisLine={false} tickLine={false} width={55} tickFormatter={v => isNormalized ? `${Number(v).toFixed(0)}` : `$${Number(v).toFixed(2)}`} />
                  <Tooltip
                    contentStyle={{ background: 'var(--ink)', border: 'none', borderRadius: '8px', padding: '10px 14px', boxShadow: '0 8px 30px rgba(0,0,0,0.2)' }}
                    itemStyle={{ fontSize: '12px', fontWeight: 600, fontFamily: 'JetBrains Mono', color: '#fff' }}
                    labelStyle={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '4px' }}
                    labelFormatter={v => new Date(v as string).toLocaleDateString('en-CA', { month: 'long', day: 'numeric', year: 'numeric' })}
                    formatter={(value) => [isNormalized ? `${Number(value).toFixed(1)}%` : `$${Number(value).toFixed(2)}`, '']}
                  />
                  <Legend iconType="plainline" wrapperStyle={{ paddingTop: '8px' }} formatter={(val: string) => <span className="text-xs font-medium text-[var(--muted)]">{val.replace('.TO', '')}</span>} />
                  {selectedTickers.map((t, i) => (
                    <Area key={t} type="monotone" dataKey={t} stroke={CHART_COLORS[i % CHART_COLORS.length]} fill={`url(#grad-${i})`} strokeWidth={2} dot={false} animationDuration={600} />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-[var(--muted)] text-sm">
                {loading ? <span className="pulse-subtle">Loading...</span> : 'Select ETFs from the table to visualize'}
              </div>
            )}
          </div>
        </section>

        {/* ═══ TABLE ═══ */}
        <section className="bg-[var(--surface)] rounded-xl border border-[var(--border)] overflow-hidden">
          <div className="flex items-center justify-between px-6 py-3 border-b border-[var(--border)]">
            <span className="text-xs text-[var(--muted)]">
              {loading ? <span className="pulse-subtle">Calculating...</span> : <>{displayETFs.length} ETFs ranked</>}
            </span>
            <span className="text-xs text-[var(--muted)]">Click row to chart &middot; max 8</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
              <thead>
                <tr className="text-[10px] font-semibold text-[var(--muted)] uppercase tracking-wider">
                  <th className="pl-6 pr-2 py-3 w-8" />
                  <th className="px-3 py-3 w-[90px]">Ticker</th>
                  <th className="px-3 py-3">Fund Name</th>
                  <SortableHeader label="Score" sortKey="score" currentKey={sortKey} dir={sortDir} onClick={handleSort} className="w-[160px]" />
                  <SortableHeader label="Return" sortKey="annualReturn" currentKey={sortKey} dir={sortDir} onClick={handleSort} align="right" />
                  <SortableHeader label="Sortino" sortKey="sortino" currentKey={sortKey} dir={sortDir} onClick={handleSort} align="right" info="sortino" />
                  <SortableHeader label="Calmar" sortKey="calmar" currentKey={sortKey} dir={sortDir} onClick={handleSort} align="right" info="calmar" />
                  <SortableHeader label="Drawdown" sortKey="maxDrawdown" currentKey={sortKey} dir={sortDir} onClick={handleSort} align="right" info="mdd" />
                  <SortableHeader label="Yield" sortKey="yield" currentKey={sortKey} dir={sortDir} onClick={handleSort} align="right" info="yield" />
                  <SortableHeader label="Fees" sortKey="mer" currentKey={sortKey} dir={sortDir} onClick={handleSort} align="right" info="mer" />
                  <SortableHeader label="AUM" sortKey="aum" currentKey={sortKey} dir={sortDir} onClick={handleSort} align="right" />
                </tr>
              </thead>
              <tbody>
                {displayETFs.map((e, idx) => {
                  const isSelected = selectedTickers.includes(e.ticker);
                  const colorIdx = selectedTickers.indexOf(e.ticker);
                  const lineColor = colorIdx >= 0 ? CHART_COLORS[colorIdx % CHART_COLORS.length] : undefined;
                  return (
                    <tr
                      key={e.ticker} onClick={() => toggleTicker(e.ticker)}
                      className="table-row-enter group cursor-pointer border-t border-[var(--border)] hover:bg-[var(--paper-warm)] transition-colors"
                      style={{ animationDelay: `${Math.min(idx * 15, 300)}ms` }}
                    >
                      <td className="pl-6 pr-2 py-3.5">
                        <div className={`w-4 h-4 rounded-[4px] border-2 transition-all flex items-center justify-center ${isSelected ? 'border-transparent' : 'border-[var(--border)] group-hover:border-[var(--border-strong)]'}`} style={isSelected ? { background: lineColor } : {}}>
                          {isSelected && <svg width="8" height="8" viewBox="0 0 10 8" fill="none"><path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                        </div>
                      </td>
                      <td className="px-3 py-3.5"><span className="text-sm font-bold tracking-tight" style={isSelected ? { color: lineColor } : {}}>{e.ticker.replace('.TO', '')}</span></td>
                      <td className="px-3 py-3.5 text-xs text-[var(--muted)] truncate max-w-[250px]">{e.name}</td>
                      <td className="px-3 py-3.5">
                        <div className="flex items-center gap-2.5">
                          <span className="text-sm font-mono font-bold w-[36px]">{e.score.toFixed(0)}</span>
                          <div className="flex-1 h-[6px] bg-[var(--paper)] rounded-full overflow-hidden">
                            <div className="score-bar-fill h-full rounded-full" style={{ width: `${(e.score / maxScore) * 100}%`, background: 'linear-gradient(90deg, var(--accent), var(--accent-dim))', animationDelay: `${Math.min(idx * 25, 400)}ms` }} />
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3.5 text-right">
                        <span className={`text-sm font-mono font-semibold ${e.annualReturn >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                          {e.annualReturn >= 0 ? '+' : ''}{(e.annualReturn * 100).toFixed(1)}%
                        </span>
                      </td>
                      <td className="px-3 py-3.5 text-right">
                        <span className={`text-sm font-mono font-medium ${e.sortino >= 1 ? 'text-[var(--green)]' : e.sortino >= 0 ? 'text-[var(--accent-dim)]' : 'text-[var(--red)]'}`}>{e.sortino.toFixed(2)}</span>
                      </td>
                      <td className="px-3 py-3.5 text-right">
                        <span className={`text-sm font-mono font-medium ${e.calmar >= 1 ? 'text-[var(--green)]' : e.calmar >= 0 ? 'text-[var(--accent-dim)]' : 'text-[var(--red)]'}`}>{e.calmar.toFixed(2)}</span>
                      </td>
                      <td className="px-3 py-3.5 text-right"><span className="text-sm font-mono font-medium text-[var(--red)]">{(e.maxDrawdown * 100).toFixed(1)}%</span></td>
                      <td className="px-3 py-3.5 text-right"><span className="text-sm font-mono font-medium text-[var(--green)]">{(e.yield * 100).toFixed(2)}%</span></td>
                      <td className="px-3 py-3.5 text-right"><span className="text-sm font-mono font-medium text-[var(--muted)]">{(e.mer * 100).toFixed(2)}%</span></td>
                      <td className="px-3 py-3.5 text-right"><span className="text-sm font-mono font-medium text-[var(--muted)]">{formatAUM(e.aum)}</span></td>
                    </tr>
                  );
                })}
                {displayETFs.length === 0 && !loading && (
                  <tr><td colSpan={10} className="py-16 text-center text-[var(--muted)] text-sm">No ETFs match your current limits. Try adjusting in the panel above.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <footer className="mt-6 text-center text-[11px] text-[var(--border-strong)] pb-4">
          Data from Yahoo Finance &middot; Not financial advice &middot; Rankings are algorithmic, not recommendations
        </footer>
      </div>
    </div>
  );
};

export default App;
