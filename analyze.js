const fs = require('fs');
const path = require('path');

const PORTFOLIO_PATH = path.join(__dirname, 'public', 'portfolio.json');
const ANALYSIS_PATH = path.join(__dirname, 'public', 'latest-analysis.json');

const CONFIG = {
  STARTING_CASH: 1000,
  MAX_POSITION_PCT: 0.15,
  MIN_EDGE: 0.02,
  MAX_OPEN_POSITIONS: 10,
  STOP_LOSS_PCT: 0.40,
  TAKE_PROFIT_PCT: 0.80,
};

function loadPortfolio() {
  try {
    if (fs.existsSync(PORTFOLIO_PATH)) {
      return JSON.parse(fs.readFileSync(PORTFOLIO_PATH, 'utf8'));
    }
  } catch (e) {}
  return {
    polymarket: { cash: CONFIG.STARTING_CASH, startingCash: CONFIG.STARTING_CASH, positions: [], closedTrades: [], totalTrades: 0, winningTrades: 0 },
    kalshi: { cash: CONFIG.STARTING_CASH, startingCash: CONFIG.STARTING_CASH, positions: [], closedTrades: [], totalTrades: 0, winningTrades: 0 },
    createdAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    analysisCount: 0
  };
}

function calcPortfolioValue(p) {
  return p.cash + p.positions.reduce((sum, pos) => sum + (pos.shares * pos.currentPrice), 0);
}

function calcPnL(p) { return calcPortfolioValue(p) - p.startingCash; }

function calcWinRate(p) {
  if (p.totalTrades === 0) return 0;
  return parseFloat(((p.winningTrades / p.totalTrades) * 100).toFixed(1));
}

function getMockMarkets(platform) {
  const seed = Date.now() % 1000;
  return [
    { id: `${platform}-fed`, question: 'Fed rate cut before June 2025?', yesPrice: 0.27 + (seed % 10) * 0.005, noPrice: 0.73, volume: 850000, platform },
    { id: `${platform}-btc`, question: 'Bitcoin above $100k by July 2025?', yesPrice: 0.64 + (seed % 8) * 0.004, noPrice: 0.36, volume: 1200000, platform },
    { id: `${platform}-recession`, question: 'US recession in 2025?', yesPrice: 0.18 + (seed % 6) * 0.003, noPrice: 0.82, volume: 430000, platform },
    { id: `${platform}-sp500`, question: 'S&P 500 above 6000 end Q2?', yesPrice: 0.58 + (seed % 7) * 0.003, noPrice: 0.42, volume: 320000, platform },
    { id: `${platform}-eth`, question: 'Ethereum above $4000 by August?', yesPrice: 0.43 + (seed % 9) * 0.004, noPrice: 0.57, volume: 280000, platform },
    { id: `${platform}-trump`, question: 'Trump approval above 50% in May?', yesPrice: 0.31 + (seed % 5) * 0.004, noPrice: 0.69, volume: 190000, platform },
    { id: `${platform}-nfl`, question: 'NFL Draft top pick QB?', yesPrice: 0.71 + (seed % 4) * 0.003, noPrice: 0.29, volume: 150000, platform },
  ];
}

async function fetchPolymarketData() {
  try {
    const res = await fetch('https://clob.polymarket.com/markets?next_cursor=&limit=20', { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    const filtered = data.filter(m => m.volume > 5000 && m.outcomePrices).slice(0, 10).map(m => {
      let prices = [];
      try { prices = JSON.parse(m.outcomePrices); } catch(e) {}
      return { id: m.id, question: m.question, volume: parseFloat(m.volume) || 0, yesPrice: parseFloat(prices[0]) || 0.5, noPrice: parseFloat(prices[1]) || 0.5, endDate: m.endDate, platform: 'polymarket' };
    });
    if (filtered.length > 0) { console.log(`  Polymarket API: ${filtered.length} mercados reales`); return filtered; }
    throw new Error('No markets returned');
  } catch (e) {
    console.log(`  Polymarket API falló (${e.message}), usando mock`);
    return getMockMarkets('polymarket');
  }
}

async function fetchKalshiData() {
  try {
    const res = await fetch('https://trading-api.kalshi.com/trade-api/v2/markets?limit=20&status=open', { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    const filtered = (data.markets || []).filter(m => m.volume > 500).slice(0, 10).map(m => ({
      id: m.ticker, question: m.title, volume: m.volume || 0,
      yesPrice: (m.yes_bid || 50) / 100, noPrice: (m.no_bid || 50) / 100,
      endDate: m.close_time, platform: 'kalshi'
    }));
    if (filtered.length > 0) { console.log(`  Kalshi API: ${filtered.length} mercados reales`); return filtered; }
    throw new Error('No markets returned');
  } catch (e) {
    console.log(`  Kalshi API falló (${e.message}), usando mock`);
    return getMockMarkets('kalshi');
  }
}

function calculateEdge(market) {
  const y = market.yesPrice;
  let fair = y;
  if (y < 0.20) fair = y * 1.20;
  else if (y < 0.35) fair = y * 1.10;
  else if (y > 0.80) fair = y * 0.92;
  else if (y > 0.65) fair = y * 0.96;
  const adj = market.volume > 500000 ? 0.99 : market.volume > 100000 ? 1.01 : 1.04;
  fair = Math.min(Math.max(fair * adj, 0.01), 0.99);
  const eY = fair - y;
  const eN = (1 - fair) - market.noPrice;
  if (eY > eN && eY > CONFIG.MIN_EDGE) return { action: 'BUY_YES', edge: eY, confidence: Math.min(eY * 8, 0.90) };
  if (eN > eY && eN > CONFIG.MIN_EDGE) return { action: 'BUY_NO', edge: eN, confidence: Math.min(eN * 8, 0.90) };
  return { action: 'HOLD', edge: 0, confidence: 0 };
}

function updateOpenPositions(portfolio, markets) {
  const mm = {};
  markets.forEach(m => mm[m.id] = m);
  const closed = [], open = [];
  portfolio.positions.forEach(pos => {
    if (mm[pos.marketId]) pos.currentPrice = pos.side === 'YES' ? mm[pos.marketId].yesPrice : mm[pos.marketId].noPrice;
    const cost = pos.shares * pos.entryPrice;
    const val = pos.shares * pos.currentPrice;
    const pnl = val - cost;
    const pct = cost > 0 ? pnl / cost : 0;
    if (pct <= -CONFIG.STOP_LOSS_PCT || pct >= CONFIG.TAKE_PROFIT_PCT) {
      portfolio.cash += val;
      portfolio.totalTrades++;
      if (pnl > 0) portfolio.winningTrades++;
      closed.push({ marketId: pos.marketId, question: pos.question, side: pos.side, entryPrice: pos.entryPrice, exitPrice: pos.currentPrice, shares: pos.shares, pnl: parseFloat(pnl.toFixed(2)), pnlPct: parseFloat((pct * 100).toFixed(1)), reason: pct >= CONFIG.TAKE_PROFIT_PCT ? 'TAKE_PROFIT' : 'STOP_LOSS', openedAt: pos.openedAt, closedAt: new Date().toISOString() });
    } else {
      open.push({ ...pos, currentValue: parseFloat(val.toFixed(2)), pnl: parseFloat(pnl.toFixed(2)) });
    }
  });
  portfolio.positions = open;
  portfolio.closedTrades = [...closed, ...(portfolio.closedTrades || [])].slice(0, 50);
  return closed;
}

function openNewPositions(portfolio, markets) {
  const opened = [];
  const openIds = new Set(portfolio.positions.map(p => p.marketId));
  if (portfolio.positions.length >= CONFIG.MAX_OPEN_POSITIONS || portfolio.cash < 15) return opened;

  const opps = markets
    .filter(m => !openIds.has(m.id))
    .map(m => ({ market: m, signal: calculateEdge(m) }))
    .filter(o => o.signal.action !== 'HOLD')
    .sort((a, b) => b.signal.edge - a.signal.edge);

  console.log(`  Oportunidades encontradas: ${opps.length}`);

  for (const opp of opps) {
    if (portfolio.positions.length >= CONFIG.MAX_OPEN_POSITIONS || portfolio.cash < 15) break;
    const pv = calcPortfolioValue(portfolio);
    const size = Math.min(pv * CONFIG.MAX_POSITION_PCT * opp.signal.confidence, portfolio.cash * 0.4, 150);
    if (size < 10) continue;
    const price = opp.signal.action === 'BUY_YES' ? opp.market.yesPrice : opp.market.noPrice;
    if (price <= 0.01 || price >= 0.99) continue;
    const actual = Math.min(size, portfolio.cash);
    portfolio.cash -= actual;
    const pos = { marketId: opp.market.id, question: opp.market.question, platform: opp.market.platform, side: opp.signal.action === 'BUY_YES' ? 'YES' : 'NO', entryPrice: parseFloat(price.toFixed(4)), currentPrice: parseFloat(price.toFixed(4)), shares: parseFloat((actual / price).toFixed(2)), cost: parseFloat(actual.toFixed(2)), currentValue: parseFloat(actual.toFixed(2)), pnl: 0, edge: parseFloat(opp.signal.edge.toFixed(4)), openedAt: new Date().toISOString() };
    portfolio.positions.push(pos);
    opened.push(pos);
    console.log(`  + OPEN ${pos.side} "${pos.question.slice(0, 45)}" @ ${price.toFixed(3)} $${actual.toFixed(2)} edge:${opp.signal.edge.toFixed(3)}`);
  }
  return opened;
}

async function main() {
  console.log('🤖 Prediction Markets AI Autopilot v2.1 — ' + new Date().toISOString());
  fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });

  const portfolio = loadPortfolio();
  portfolio.analysisCount = (portfolio.analysisCount || 0) + 1;

  const [poly, kal] = await Promise.all([fetchPolymarketData(), fetchKalshiData()]);
  console.log(`📊 Total mercados: Polymarket ${poly.length} | Kalshi ${kal.length}`);

  const results = {};
  for (const [key, markets] of [['polymarket', poly], ['kalshi', kal]]) {
    const plat = portfolio[key];
    updateOpenPositions(plat, markets);
    openNewPositions(plat, markets);
    const val = calcPortfolioValue(plat);
    const pnl = calcPnL(plat);
    results[key] = { totalValue: parseFloat(val.toFixed(2)), cash: parseFloat(plat.cash.toFixed(2)), pnl: parseFloat(pnl.toFixed(2)), pnlPct: parseFloat(((pnl / plat.startingCash) * 100).toFixed(2)), openPositions: plat.positions.length, totalTrades: plat.totalTrades, winRate: calcWinRate(plat), };
    console.log(`  ${key}: $${val.toFixed(2)} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | Pos: ${plat.positions.length}`);
  }

  const cv = results.polymarket.totalValue + results.kalshi.totalValue;
  const cp = results.polymarket.pnl + results.kalshi.pnl;
  portfolio.lastUpdated = new Date().toISOString();
  fs.writeFileSync(PORTFOLIO_PATH, JSON.stringify(portfolio, null, 2));

  const analysis = {
    timestamp: new Date().toISOString(),
    analysisCount: portfolio.analysisCount,
    combined: { totalValue: parseFloat(cv.toFixed(2)), totalPnL: parseFloat(cp.toFixed(2)), totalPnLPct: parseFloat(((cp / 2000) * 100).toFixed(2)), sentiment: cp > 20 ? 'bullish' : cp < -20 ? 'bearish' : 'neutral' },
    platforms: results,
    positions: { polymarket: portfolio.polymarket.positions, kalshi: portfolio.kalshi.positions },
    recentTrades: { polymarket: portfolio.polymarket.closedTrades.slice(0, 10), kalshi: portfolio.kalshi.closedTrades.slice(0, 10) },
    meta: { source: 'github-actions-cron', version: '2.1.0' }
  };

  fs.writeFileSync(ANALYSIS_PATH, JSON.stringify(analysis, null, 2));
  console.log(`✅ Análisis #${portfolio.analysisCount} completo | Total: $${cv.toFixed(2)} | P&L: ${cp >= 0 ? '+' : ''}$${cp.toFixed(2)}`);
}

main().catch(err => { console.error('❌ Error:', err); process.exit(1); });
