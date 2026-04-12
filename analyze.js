// ============================================================
// Prediction Markets AI Autopilot — Trading Engine v2
// Corre via GitHub Actions cada 5 min, 24/7, gratis
// Portfolio persiste en portfolio.json dentro del repo
// ============================================================

const fs = require('fs');
const path = require('path');

const PORTFOLIO_PATH = path.join(__dirname, 'public', 'portfolio.json');
const ANALYSIS_PATH = path.join(__dirname, 'public', 'latest-analysis.json');

const CONFIG = {
  STARTING_CASH: 1000,
  MAX_POSITION_PCT: 0.10,   // máximo 10% del portfolio por posición
  MIN_EDGE: 0.05,            // mínimo 5% de edge para entrar
  MAX_OPEN_POSITIONS: 8,     // máximo posiciones abiertas simultáneas
  STOP_LOSS_PCT: 0.40,       // cerrar si pierde 40% del valor
  TAKE_PROFIT_PCT: 0.80,     // cerrar si gana 80% del valor
  PLATFORMS: ['polymarket', 'kalshi']
};

// ─── HELPERS ────────────────────────────────────────────────

function loadPortfolio() {
  try {
    if (fs.existsSync(PORTFOLIO_PATH)) {
      return JSON.parse(fs.readFileSync(PORTFOLIO_PATH, 'utf8'));
    }
  } catch (e) { console.log('Portfolio no encontrado, creando nuevo...'); }

  return {
    polymarket: {
      cash: CONFIG.STARTING_CASH,
      startingCash: CONFIG.STARTING_CASH,
      positions: [],
      closedTrades: [],
      totalTrades: 0,
      winningTrades: 0
    },
    kalshi: {
      cash: CONFIG.STARTING_CASH,
      startingCash: CONFIG.STARTING_CASH,
      positions: [],
      closedTrades: [],
      totalTrades: 0,
      winningTrades: 0
    },
    createdAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    analysisCount: 0
  };
}

function calcPortfolioValue(platform) {
  const posValue = platform.positions.reduce((sum, p) => sum + (p.shares * p.currentPrice), 0);
  return platform.cash + posValue;
}

function calcPnL(platform) {
  return calcPortfolioValue(platform) - platform.startingCash;
}

function calcWinRate(platform) {
  if (platform.totalTrades === 0) return 0;
  return ((platform.winningTrades / platform.totalTrades) * 100).toFixed(1);
}

// ─── MARKET DATA ────────────────────────────────────────────

async function fetchPolymarketData() {
  try {
    const res = await fetch(
      'https://gamma-api.polymarket.com/markets?closed=false&limit=20&order=volume&ascending=false',
      { signal: AbortSignal.timeout(8000) }
    );
    const data = await res.json();
    return data
      .filter(m => m.volume > 10000 && m.outcomePrices)
      .slice(0, 10)
      .map(m => {
        let prices = [];
        try { prices = JSON.parse(m.outcomePrices); } catch(e) {}
        return {
          id: m.id,
          question: m.question,
          volume: parseFloat(m.volume) || 0,
          yesPrice: parseFloat(prices[0]) || 0.5,
          noPrice: parseFloat(prices[1]) || 0.5,
          endDate: m.endDate,
          platform: 'polymarket'
        };
      });
  } catch (e) {
    console.log('Polymarket API error:', e.message);
    return getMockMarkets('polymarket');
  }
}

async function fetchKalshiData() {
  try {
    const res = await fetch(
      'https://api.elections.kalshi.com/trade-api/v2/markets?limit=20&status=open',
      { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000) }
    );
    const data = await res.json();
    return (data.markets || [])
      .filter(m => m.volume > 1000)
      .slice(0, 10)
      .map(m => ({
        id: m.ticker,
        question: m.title,
        volume: m.volume || 0,
        yesPrice: (m.yes_bid || 50) / 100,
        noPrice: (m.no_bid || 50) / 100,
        endDate: m.close_time,
        platform: 'kalshi'
      }));
  } catch (e) {
    console.log('Kalshi API error:', e.message);
    return getMockMarkets('kalshi');
  }
}

function getMockMarkets(platform) {
  const markets = [
    { id: `${platform}-1`, question: 'Fed rate cut before June 2025?', yesPrice: 0.32, noPrice: 0.68, volume: 850000, endDate: '2025-06-30' },
    { id: `${platform}-2`, question: 'Bitcoin above $100k by July 2025?', yesPrice: 0.61, noPrice: 0.39, volume: 1200000, endDate: '2025-07-31' },
    { id: `${platform}-3`, question: 'US recession declared in 2025?', yesPrice: 0.22, noPrice: 0.78, volume: 430000, endDate: '2025-12-31' },
    { id: `${platform}-4`, question: 'S&P 500 above 6000 end of Q2?', yesPrice: 0.55, noPrice: 0.45, volume: 320000, endDate: '2025-06-30' },
    { id: `${platform}-5`, question: 'Ethereum above $4000 by August?', yesPrice: 0.48, noPrice: 0.52, volume: 280000, endDate: '2025-08-31' },
  ];
  return markets.map(m => ({ ...m, platform }));
}

// ─── STRATEGY ENGINE ────────────────────────────────────────

function calculateEdge(market) {
  // Edge = desviación del precio justo estimado
  // Modelo simple basado en volumen y precio extremo
  const yesPrice = market.yesPrice;
  const noPrice = market.noPrice;

  // Precios muy extremos (< 0.15 o > 0.85) tienden a estar mal priceados
  let fairValueYes = yesPrice;
  if (yesPrice < 0.15) fairValueYes = yesPrice * 1.15;
  if (yesPrice > 0.85) fairValueYes = yesPrice * 0.95;

  // Ajuste por volumen (más volumen = precio más eficiente)
  const volumeAdjust = market.volume > 500000 ? 0.98 : 1.02;
  fairValueYes = fairValueYes * volumeAdjust;

  const edgeYes = fairValueYes - yesPrice;
  const edgeNo = (1 - fairValueYes) - noPrice;

  if (edgeYes > edgeNo && edgeYes > CONFIG.MIN_EDGE) {
    return { action: 'BUY_YES', edge: edgeYes, confidence: Math.min(edgeYes * 5, 0.95) };
  }
  if (edgeNo > edgeYes && edgeNo > CONFIG.MIN_EDGE) {
    return { action: 'BUY_NO', edge: edgeNo, confidence: Math.min(edgeNo * 5, 0.95) };
  }
  return { action: 'HOLD', edge: 0, confidence: 0 };
}

function calcPositionSize(portfolio, confidence) {
  const portfolioValue = calcPortfolioValue(portfolio);
  const basePct = CONFIG.MAX_POSITION_PCT * confidence;
  return Math.min(portfolioValue * basePct, portfolio.cash * 0.5);
}

// ─── TRADING LOGIC ──────────────────────────────────────────

function updateOpenPositions(portfolio, markets) {
  const marketMap = {};
  markets.forEach(m => marketMap[m.id] = m);

  const closedNow = [];
  const stillOpen = [];

  portfolio.positions.forEach(pos => {
    const market = marketMap[pos.marketId];

    // Actualizar precio actual
    if (market) {
      pos.currentPrice = pos.side === 'YES' ? market.yesPrice : market.noPrice;
    }

    const costBasis = pos.shares * pos.entryPrice;
    const currentValue = pos.shares * pos.currentPrice;
    const pnl = currentValue - costBasis;
    const pnlPct = pnl / costBasis;

    // Check stop loss / take profit
    if (pnlPct <= -CONFIG.STOP_LOSS_PCT || pnlPct >= CONFIG.TAKE_PROFIT_PCT) {
      portfolio.cash += currentValue;
      portfolio.totalTrades++;
      if (pnl > 0) portfolio.winningTrades++;

      closedNow.push({
        marketId: pos.marketId,
        question: pos.question,
        side: pos.side,
        entryPrice: pos.entryPrice,
        exitPrice: pos.currentPrice,
        shares: pos.shares,
        pnl: parseFloat(pnl.toFixed(2)),
        pnlPct: parseFloat((pnlPct * 100).toFixed(1)),
        reason: pnlPct >= CONFIG.TAKE_PROFIT_PCT ? 'TAKE_PROFIT' : 'STOP_LOSS',
        openedAt: pos.openedAt,
        closedAt: new Date().toISOString()
      });
    } else {
      stillOpen.push({ ...pos, currentValue: parseFloat(currentValue.toFixed(2)), pnl: parseFloat(pnl.toFixed(2)) });
    }
  });

  portfolio.positions = stillOpen;
  portfolio.closedTrades = [...closedNow, ...(portfolio.closedTrades || [])].slice(0, 50);
  return closedNow;
}

function openNewPositions(portfolio, markets) {
  const openedNow = [];
  const openIds = new Set(portfolio.positions.map(p => p.marketId));

  if (portfolio.positions.length >= CONFIG.MAX_OPEN_POSITIONS) return openedNow;
  if (portfolio.cash < 20) return openedNow;

  // Ordenar mercados por edge
  const opportunities = markets
    .filter(m => !openIds.has(m.id))
    .map(m => ({ market: m, signal: calculateEdge(m) }))
    .filter(o => o.signal.action !== 'HOLD')
    .sort((a, b) => b.signal.edge - a.signal.edge);

  for (const opp of opportunities) {
    if (portfolio.positions.length >= CONFIG.MAX_OPEN_POSITIONS) break;
    if (portfolio.cash < 20) break;

    const size = calcPositionSize(portfolio, opp.signal.confidence);
    if (size < 10) continue;

    const price = opp.signal.action === 'BUY_YES' ? opp.market.yesPrice : opp.market.noPrice;
    if (price <= 0 || price >= 1) continue;

    const shares = size / price;
    portfolio.cash -= size;

    const position = {
      marketId: opp.market.id,
      question: opp.market.question,
      platform: opp.market.platform,
      side: opp.signal.action === 'BUY_YES' ? 'YES' : 'NO',
      entryPrice: parseFloat(price.toFixed(4)),
      currentPrice: parseFloat(price.toFixed(4)),
      shares: parseFloat(shares.toFixed(2)),
      cost: parseFloat(size.toFixed(2)),
      currentValue: parseFloat(size.toFixed(2)),
      pnl: 0,
      edge: parseFloat(opp.signal.edge.toFixed(4)),
      openedAt: new Date().toISOString()
    };

    portfolio.positions.push(position);
    openedNow.push(position);
    console.log(`  + OPEN ${position.side} ${position.question.slice(0, 50)} @ ${price.toFixed(3)} size $${size.toFixed(2)}`);
  }

  return openedNow;
}

// ─── MAIN ───────────────────────────────────────────────────

async function main() {
  console.log('\n🤖 Prediction Markets AI Autopilot v2 — ' + new Date().toISOString());
  fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });

  const portfolio = loadPortfolio();
  portfolio.analysisCount = (portfolio.analysisCount || 0) + 1;

  // Fetch market data
  console.log('📡 Fetching market data...');
  const [polymarkets, kalshiMarkets] = await Promise.all([
    fetchPolymarketData(),
    fetchKalshiData()
  ]);
  console.log(`  Polymarket: ${polymarkets.length} mercados | Kalshi: ${kalshiMarkets.length} mercados`);

  // Process each platform
  const results = {};
  for (const [platformKey, markets] of [['polymarket', polymarkets], ['kalshi', kalshiMarkets]]) {
    console.log(`\n💼 Processing ${platformKey}...`);
    const plat = portfolio[platformKey];

    const closed = updateOpenPositions(plat, markets);
    const opened = openNewPositions(plat, markets);

    const totalValue = calcPortfolioValue(plat);
    const pnl = calcPnL(plat);

    results[platformKey] = {
      totalValue: parseFloat(totalValue.toFixed(2)),
      cash: parseFloat(plat.cash.toFixed(2)),
      pnl: parseFloat(pnl.toFixed(2)),
      pnlPct: parseFloat(((pnl / plat.startingCash) * 100).toFixed(2)),
      openPositions: plat.positions.length,
      totalTrades: plat.totalTrades,
      winRate: parseFloat(calcWinRate(plat)),
      closedThisRun: closed.length,
      openedThisRun: opened.length
    };

    console.log(`  Portfolio: $${totalValue.toFixed(2)} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | Positions: ${plat.positions.length}`);
  }

  // Combined stats
  const combinedValue = results.polymarket.totalValue + results.kalshi.totalValue;
  const combinedPnL = results.polymarket.pnl + results.kalshi.pnl;
  const combinedStart = CONFIG.STARTING_CASH * 2;

  portfolio.lastUpdated = new Date().toISOString();

  // Determine market sentiment
  const sentiment = combinedPnL > 50 ? 'bullish' : combinedPnL < -50 ? 'bearish' : 'neutral';

  // Save portfolio state
  fs.writeFileSync(PORTFOLIO_PATH, JSON.stringify(portfolio, null, 2));

  // Save analysis summary
  const analysis = {
    timestamp: new Date().toISOString(),
    analysisCount: portfolio.analysisCount,
    combined: {
      totalValue: parseFloat(combinedValue.toFixed(2)),
      totalPnL: parseFloat(combinedPnL.toFixed(2)),
      totalPnLPct: parseFloat(((combinedPnL / combinedStart) * 100).toFixed(2)),
      sentiment
    },
    platforms: results,
    positions: {
      polymarket: portfolio.polymarket.positions,
      kalshi: portfolio.kalshi.positions
    },
    recentTrades: {
      polymarket: portfolio.polymarket.closedTrades.slice(0, 10),
      kalshi: portfolio.kalshi.closedTrades.slice(0, 10)
    },
    meta: {
      source: 'github-actions-cron',
      version: '2.0.0',
      nextRunIn: '5 minutos'
    }
  };

  fs.writeFileSync(ANALYSIS_PATH, JSON.stringify(analysis, null, 2));

  console.log(`\n✅ Listo. Portfolio total: $${combinedValue.toFixed(2)} | P&L: ${combinedPnL >= 0 ? '+' : ''}$${combinedPnL.toFixed(2)}`);
  console.log(`📊 Análisis #${portfolio.analysisCount} completado. Próximo en ~5 minutos.`);
}

main().catch(err => {
  console.error('❌ Error fatal:', err);
  process.exit(1);
});
