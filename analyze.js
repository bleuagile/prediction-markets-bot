// analyze.js - Prediction Markets AI Autopilot
// Corre via GitHub Actions cada 5 minutos, 24/7, gratis

const fs = require('fs');
const path = require('path');

// ─── 1. FETCH MARKET DATA ───────────────────────────────────────────────────

async function fetchPolymarketData() {
  try {
    const res = await fetch(
      'https://gamma-api.polymarket.com/markets?closed=false&limit=10&order=volume&ascending=false'
    );
    const data = await res.json();
    return data.map(m => ({
      id: m.id,
      question: m.question,
      volume: m.volume,
      outcomePrices: m.outcomePrices,
      outcomes: m.outcomes,
      endDate: m.endDate
    }));
  } catch (e) {
    console.log('Polymarket API error, using mock:', e.message);
    return getMockPolymarketData();
  }
}

async function fetchKalshiData() {
  try {
    const res = await fetch(
      'https://api.elections.kalshi.com/trade-api/v2/markets?limit=10&status=open',
      { headers: { 'Accept': 'application/json' } }
    );
    const data = await res.json();
    return (data.markets || []).map(m => ({
      id: m.ticker,
      question: m.title,
      yesPrice: m.yes_bid,
      noPrice: m.no_bid,
      volume: m.volume,
      closeDate: m.close_time
    }));
  } catch (e) {
    console.log('Kalshi API error, using mock:', e.message);
    return getMockKalshiData();
  }
}

function getMockPolymarketData() {
  return [
    { id: 'p1', question: 'Will the Fed cut rates in May 2025?', volume: 2500000, outcomePrices: '[0.32,0.68]', outcomes: '["Yes","No"]', endDate: '2025-05-31' },
    { id: 'p2', question: 'Will Bitcoin exceed $100k by June 2025?', volume: 1800000, outcomePrices: '[0.61,0.39]', outcomes: '["Yes","No"]', endDate: '2025-06-30' },
    { id: 'p3', question: 'Will there be a US recession in 2025?', volume: 950000, outcomePrices: '[0.28,0.72]', outcomes: '["Yes","No"]', endDate: '2025-12-31' },
  ];
}

function getMockKalshiData() {
  return [
    { id: 'FED-25MAY', question: 'Fed rate cut - May 2025', yesPrice: 0.30, noPrice: 0.70, volume: 180000, closeDate: '2025-05-07' },
    { id: 'BTC-100K-JUN', question: 'Bitcoin above $100K by June 2025', yesPrice: 0.58, noPrice: 0.42, volume: 95000, closeDate: '2025-06-30' },
    { id: 'NASDAQ-UP-Q2', question: 'NASDAQ positive Q2 2025', yesPrice: 0.65, noPrice: 0.35, volume: 72000, closeDate: '2025-06-30' },
  ];
}

// ─── 2. ANALYZE WITH CLAUDE ─────────────────────────────────────────────────

async function analyzeWithClaude(polymarkets, kalshiMarkets) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  const prompt = `Eres un experto en prediction markets. Analiza estos mercados y genera recomendaciones de trading con paper money.

POLYMARKET (top mercados por volumen):
${JSON.stringify(polymarkets.slice(0, 5), null, 2)}

KALSHI (top mercados):
${JSON.stringify(kalshiMarkets.slice(0, 5), null, 2)}

Responde SOLO con un JSON válido con esta estructura exacta (sin markdown, sin texto extra):
{
  "summary": "Resumen ejecutivo del mercado en 2 oraciones",
  "sentiment": "bullish|bearish|neutral",
  "confidence": 0.0-1.0,
  "polymarket_picks": [
    {
      "market": "nombre del mercado",
      "action": "BUY_YES|BUY_NO|HOLD",
      "amount": 10-50,
      "reasoning": "razón breve",
      "expectedReturn": 0.0-1.0
    }
  ],
  "kalshi_picks": [
    {
      "market": "nombre del mercado",
      "action": "BUY_YES|BUY_NO|HOLD",
      "amount": 10-50,
      "reasoning": "razón breve",
      "expectedReturn": 0.0-1.0
    }
  ],
  "risk_level": "low|medium|high",
  "next_key_events": ["evento 1", "evento 2"]
}`;

  if (apiKey) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',   // Modelo más económico, ideal para cron jobs
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const data = await res.json();
      const text = data.content[0].text.trim();
      return JSON.parse(text);
    } catch (e) {
      console.log('Claude API error, using rule-based analysis:', e.message);
    }
  }

  // Fallback: análisis basado en reglas
  return generateRuleBasedAnalysis(polymarkets, kalshiMarkets);
}

function generateRuleBasedAnalysis(polymarkets, kalshiMarkets) {
  return {
    summary: "Análisis automático basado en reglas. Mercados con alto volumen muestran actividad moderada.",
    sentiment: "neutral",
    confidence: 0.6,
    polymarket_picks: polymarkets.slice(0, 2).map(m => ({
      market: m.question,
      action: "HOLD",
      amount: 20,
      reasoning: "Volumen insuficiente para posición clara",
      expectedReturn: 0.05
    })),
    kalshi_picks: kalshiMarkets.slice(0, 2).map(m => ({
      market: m.question,
      action: "HOLD",
      amount: 15,
      reasoning: "Esperando confirmación de tendencia",
      expectedReturn: 0.04
    })),
    risk_level: "medium",
    next_key_events: ["Decisión Fed próxima reunión", "Datos CPI mensual"]
  };
}

// ─── 3. SAVE RESULTS ────────────────────────────────────────────────────────

async function main() {
  console.log('🤖 Prediction Markets AI Autopilot - Iniciando análisis...');
  const timestamp = new Date().toISOString();

  const [polymarkets, kalshiMarkets] = await Promise.all([
    fetchPolymarketData(),
    fetchKalshiData()
  ]);

  console.log(`✅ Datos obtenidos: ${polymarkets.length} Polymarket, ${kalshiMarkets.length} Kalshi`);

  const analysis = await analyzeWithClaude(polymarkets, kalshiMarkets);
  console.log('✅ Análisis completado. Sentiment:', analysis.sentiment);

  const output = {
    timestamp,
    analysis,
    markets: {
      polymarket: polymarkets,
      kalshi: kalshiMarkets
    },
    meta: {
      source: 'github-actions-cron',
      version: '1.0.0',
      nextRunIn: '5 minutos'
    }
  };

  const outputPath = path.join(__dirname, 'public', 'latest-analysis.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`💾 Guardado en: ${outputPath}`);
  console.log('🎯 Listo. Próximo análisis en ~5 minutos.');
}

main().catch(err => {
  console.error('❌ Error fatal:', err);
  process.exit(1);
});
