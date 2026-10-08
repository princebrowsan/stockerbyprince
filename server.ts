import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';

const app = express();
const PORT = 3000;

app.use(express.json());

// Map user symbols to Yahoo Finance Indian tickers
function toYahooTicker(sym: string): string {
  const clean = sym.toUpperCase().trim();
  if (clean === 'NIFTY 50' || clean === 'NIFTY' || clean === '^NSEI') return '^NSEI';
  if (clean === 'SENSEX' || clean === 'BSESN' || clean === '^BSESN') return '^BSESN';
  if (clean === 'BANK NIFTY' || clean === 'BANKNIFTY' || clean === '^NSEBANK') return '^NSEBANK';
  if (clean.endsWith('.NS') || clean.endsWith('.BO')) return clean;
  return `${clean}.NS`;
}

// Format volume into Indian units (Crores / Lakhs)
function formatIndianVolume(num: number): string {
  if (!num || isNaN(num)) return '0 L';
  if (num >= 10000000) return `${(num / 10000000).toFixed(2)} Cr`;
  if (num >= 100000) return `${(num / 100000).toFixed(1)} L`;
  return num.toLocaleString('en-IN');
}

// Convert epoch to IST time string
function toISTTime(epochSec: number): string {
  const date = new Date(epochSec * 1000);
  return date.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }) + ' IST';
}

// 1. Live Quote & Candlestick Feed for any Indian stock
app.get('/api/quote/:symbol', async (req, res) => {
  try {
    const rawSymbol = req.params.symbol;
    const ticker = toYahooTicker(rawSymbol);
    const range = (req.query.range as string) || '1d';
    const interval = (req.query.interval as string) || '5m';

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Provider error: ${response.statusText}` });
    }

    const data = (await response.json()) as any;
    const chartResult = data?.chart?.result?.[0];

    if (!chartResult) {
      return res.status(404).json({ error: 'Stock not found' });
    }

    const meta = chartResult.meta;
    const timestamps: number[] = chartResult.timestamp || [];
    const quote = chartResult.indicators?.quote?.[0] || {};
    const opens = quote.open || [];
    const highs = quote.high || [];
    const lows = quote.low || [];
    const closes = quote.close || [];
    const volumes = quote.volume || [];

    // Filter valid candlestick points
    const candles: Array<{ open: number; high: number; low: number; close: number; volume: number; time: string; ema?: number }> = [];

    for (let i = 0; i < timestamps.length; i++) {
      const o = opens[i];
      const h = highs[i];
      const l = lows[i];
      const c = closes[i];
      if (o != null && h != null && l != null && c != null) {
        candles.push({
          open: Number(o.toFixed(2)),
          high: Number(h.toFixed(2)),
          low: Number(l.toFixed(2)),
          close: Number(c.toFixed(2)),
          volume: volumes[i] || 0,
          time: toISTTime(timestamps[i]),
        });
      }
    }

    // Compute 20-EMA across candles
    if (candles.length > 0) {
      const k = 2 / (20 + 1);
      let ema = candles[0].close;
      for (let i = 0; i < candles.length; i++) {
        ema = candles[i].close * k + ema * (1 - k);
        candles[i].ema = Number(ema.toFixed(2));
      }
    }

    const currentPrice = meta.regularMarketPrice ?? (candles.length ? candles[candles.length - 1].close : 0);
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? currentPrice;
    const dayHigh = meta.regularMarketDayHigh ?? (candles.length ? Math.max(...candles.map(c => c.high)) : currentPrice);
    const dayLow = meta.regularMarketDayLow ?? (candles.length ? Math.min(...candles.map(c => c.low)) : currentPrice);
    const change = Number((currentPrice - prevClose).toFixed(2));
    const pct = Number(((change / prevClose) * 100).toFixed(2));

    const cleanSymbol = rawSymbol.toUpperCase();

    res.json({
      success: true,
      symbol: cleanSymbol,
      name: meta.longName || meta.shortName || `${cleanSymbol} Equities`,
      exchange: meta.fullExchangeName || meta.exchangeName || 'NSE',
      currency: meta.currency || 'INR',
      price: Number(currentPrice.toFixed(2)),
      change: change,
      pct: pct,
      open: meta.regularMarketOpen ?? (candles.length ? candles[0].open : currentPrice),
      high: Number(dayHigh.toFixed(2)),
      low: Number(dayLow.toFixed(2)),
      prevClose: Number(prevClose.toFixed(2)),
      volume: formatIndianVolume(meta.regularMarketVolume || 0),
      range52: `${meta.fiftyTwoWeekLow?.toFixed(0) || '0'} - ${meta.fiftyTwoWeekHigh?.toFixed(0) || '0'}`,
      candles: candles,
    });
  } catch (err: any) {
    console.error('API Error in /api/quote:', err);
    res.status(500).json({ error: err?.message || 'Failed to fetch quote' });
  }
});

// 2. Live Market Indices Snapshot
app.get('/api/indices', async (_req, res) => {
  try {
    const indices = [
      { key: 'NIFTY 50', ticker: '^NSEI' },
      { key: 'SENSEX', ticker: '^BSESN' },
      { key: 'BANK NIFTY', ticker: '^NSEBANK' },
    ];

    const results = await Promise.all(
      indices.map(async item => {
        try {
          const resp = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(item.ticker)}?interval=1d&range=1d`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            },
          });
          const json = (await resp.json()) as any;
          const meta = json?.chart?.result?.[0]?.meta;
          if (meta) {
            const price = meta.regularMarketPrice;
            const prev = meta.chartPreviousClose || price;
            const chg = price - prev;
            const pct = (chg / prev) * 100;
            return {
              name: item.key,
              price: price.toFixed(2),
              change: chg.toFixed(2),
              pct: pct.toFixed(2),
              isUp: chg >= 0,
            };
          }
        } catch (e) {}
        return null;
      })
    );

    res.json({ success: true, indices: results.filter(Boolean) });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Failed to fetch indices' });
  }
});

async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  } else {
    // Mount Vite development middlewares
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Stock market server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
