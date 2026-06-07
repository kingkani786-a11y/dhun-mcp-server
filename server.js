const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;
const BASE_URL = 'https://dhun-mcp-server.onrender.com';

app.use(function(req, res, next) {
  const ts = new Date().toISOString();
  console.log('[REQ]', ts, req.method, req.path, JSON.stringify(req.query));
  res.on('finish', function() { console.log('[RES]', req.method, req.path, res.statusCode); });
  next();
});

const registeredClients = {};
const authCodes = {};
const accessTokens = {};

// ── Yahoo Finance helpers ────────────────────────────────────────────────────

async function yahooQuote(symbol) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?interval=1m&range=1d';
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json'
    }
  });
  if (!res.ok) throw new Error('Yahoo Finance error: ' + res.status + ' for ' + symbol);
  const data = await res.json();
  const meta = data && data.chart && data.chart.result && data.chart.result[0] && data.chart.result[0].meta;
  if (!meta) throw new Error('No data from Yahoo Finance for ' + symbol);
  return {
    symbol: meta.symbol,
    ltp: meta.regularMarketPrice || meta.previousClose || 0,
    open: meta.regularMarketOpen || 0,
    high: meta.regularMarketDayHigh || 0,
    low: meta.regularMarketDayLow || 0,
    prevClose: meta.previousClose || 0,
    change: parseFloat(((meta.regularMarketPrice - meta.previousClose) || 0).toFixed(2)),
    changePct: parseFloat((((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 100 || 0).toFixed(2)),
    currency: meta.currency || 'INR',
    exchangeName: meta.exchangeName || 'NSE',
    ts: new Date().toISOString()
  };
}

async function yahooOptionChain(symbol) {
  const url = 'https://query1.finance.yahoo.com/v7/finance/options/' + encodeURIComponent(symbol);
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json'
    }
  });
  if (!res.ok) throw new Error('Yahoo Options error: ' + res.status + ' for ' + symbol);
  const data = await res.json();
  const result = data && data.optionChain && data.optionChain.result && data.optionChain.result[0];
  if (!result) throw new Error('No option chain data for ' + symbol);

  const spot = (result.quote && result.quote.regularMarketPrice) || 0;
  const expirations = result.expirationDates || [];
  const options = (result.options && result.options[0]) || {};
  const calls = options.calls || [];
  const puts = options.puts || [];

  let totalCEOI = 0, totalPEOI = 0;
  let maxCEOI = 0, maxPEOI = 0;
  let maxCEStrike = 0, maxPEStrike = 0;

  calls.forEach(function(c) {
    const oi = c.openInterest || 0;
    totalCEOI += oi;
    if (oi > maxCEOI) { maxCEOI = oi; maxCEStrike = c.strike || 0; }
  });

  puts.forEach(function(p) {
    const oi = p.openInterest || 0;
    totalPEOI += oi;
    if (oi > maxPEOI) { maxPEOI = oi; maxPEStrike = p.strike || 0; }
  });

  const pcr = totalCEOI > 0 ? parseFloat((totalPEOI / totalCEOI).toFixed(3)) : 0;

  const nearStrikes = calls
    .filter(function(c) { return c.strike >= spot * 0.97 && c.strike <= spot * 1.03; })
    .map(function(c) {
      const p = puts.find(function(x) { return x.strike === c.strike; }) || {};
      return {
        strike: c.strike,
        ce_ltp: c.lastPrice || 0,
        ce_oi: c.openInterest || 0,
        ce_iv: parseFloat((c.impliedVolatility * 100 || 0).toFixed(2)),
        pe_ltp: p.lastPrice || 0,
        pe_oi: p.openInterest || 0,
        pe_iv: parseFloat((p.impliedVolatility * 100 || 0).toFixed(2))
      };
    });

  return {
    spot: spot,
    pcr: pcr,
    totalCEOI: totalCEOI,
    totalPEOI: totalPEOI,
    maxCEStrike: maxCEStrike,
    maxPEStrike: maxPEStrike,
    expirationDates: expirations.slice(0, 5).map(function(e) { return new Date(e * 1000).toISOString().split('T')[0]; }),
    nearExpiry: expirations[0] ? new Date(expirations[0] * 1000).toISOString().split('T')[0] : '',
    optionData: nearStrikes
  };
}

function calculateSignal(spot, pcr, maxCEStrike, maxPEStrike) {
  let trend = 'sideways';
  let signal = 'WAIT';
  const reason = [];

  if (pcr < 0.7) { trend = 'bearish'; reason.push('PCR ' + pcr + ' < 0.7 (bearish)'); }
  else if (pcr > 1.3) { trend = 'bullish'; reason.push('PCR ' + pcr + ' > 1.3 (bullish)'); }
  else if (pcr > 1.1) { trend = 'mildly_bullish'; reason.push('PCR ' + pcr + ' > 1.1 (mild bullish)'); }
  else if (pcr < 0.85) { trend = 'mildly_bearish'; reason.push('PCR ' + pcr + ' < 0.85 (mild bearish)'); }
  else { reason.push('PCR ' + pcr + ' neutral (0.85-1.1)'); }

  reason.push('Resistance (Max CE OI): ' + maxCEStrike);
  reason.push('Support (Max PE OI): ' + maxPEStrike);

  if (trend === 'bullish' || trend === 'mildly_bullish') { signal = 'BUY CE near ' + maxPEStrike; }
  else if (trend === 'bearish' || trend === 'mildly_bearish') { signal = 'BUY PE near ' + maxCEStrike; }
  else { signal = 'WAIT - Sideways, sell straddle near ' + Math.round((maxPEStrike + maxCEStrike) / 2); }

  return { trend: trend, signal: signal, reason: reason };
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/', function(req, res) {
  res.json({
    service: 'dhun-mcp-server', version: 'v9-yahoo', status: 'live',
    data_source: 'Yahoo Finance - Free, No Token',
    endpoints: ['/health', '/get_live_nifty', '/get_live_banknifty', '/get_option_chain?symbol=NIFTY', '/get_signal?symbol=NIFTY', '/mcp']
  });
});

app.get('/health', function(req, res) {
  res.json({ status: 'ok', ts: new Date().toISOString(), source: 'Yahoo Finance' });
});

app.get('/get_live_nifty', async function(req, res) {
  try {
    const q = await yahooQuote('%5ENSEI');
    res.json({ success: true, symbol: 'NIFTY', spot: q.ltp, open: q.open, high: q.high, low: q.low, prevClose: q.prevClose, change: q.change, changePct: q.changePct, source: 'Yahoo Finance', ts: q.ts });
  } catch (e) {
    console.error('[NIFTY ERROR]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/get_live_banknifty', async function(req, res) {
  try {
    const q = await yahooQuote('%5ENSEBANK');
    res.json({ success: true, symbol: 'BANKNIFTY', spot: q.ltp, open: q.open, high: q.high, low: q.low, prevClose: q.prevClose, change: q.change, changePct: q.changePct, source: 'Yahoo Finance', ts: q.ts });
  } catch (e) {
    console.error('[BANKNIFTY ERROR]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/get_option_chain', async function(req, res) {
  const symbol = ((req.query.symbol) || 'NIFTY').toUpperCase();
  const yahooSym = symbol === 'BANKNIFTY' ? '%5ENSEBANK' : '%5ENSEI';
  try {
    const data = await yahooOptionChain(yahooSym);
    res.json(Object.assign({ success: true, symbol: symbol }, data, { source: 'Yahoo Finance', ts: new Date().toISOString() }));
  } catch (e) {
    console.error('[OPTCHAIN ERROR]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/get_signal', async function(req, res) {
  const symbol = ((req.query.symbol) || 'NIFTY').toUpperCase();
  const yahooSym = symbol === 'BANKNIFTY' ? '%5ENSEBANK' : '%5ENSEI';
  try {
    const data = await yahooOptionChain(yahooSym);
    const sig = calculateSignal(data.spot, data.pcr, data.maxCEStrike, data.maxPEStrike);
    res.json(Object.assign({ success: true, symbol: symbol, spot: data.spot, pcr: data.pcr }, sig, { nearExpiry: data.nearExpiry, source: 'Yahoo Finance', ts: new Date().toISOString() }));
  } catch (e) {
    console.error('[SIGNAL ERROR]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── OAuth endpoints ──────────────────────────────────────────────────────────

app.get('/.well-known/oauth-authorization-server', function(req, res) {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: BASE_URL + '/oauth/authorize',
    token_endpoint: BASE_URL + '/oauth/token',
    registration_endpoint: BASE_URL + '/oauth/register',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256']
  });
});

app.post('/oauth/register', function(req, res) {
  const clientId = 'client_' + crypto.randomBytes(8).toString('hex');
  const clientSecret = 'secret_' + crypto.randomBytes(16).toString('hex');
  registeredClients[clientId] = { clientId: clientId, clientSecret: clientSecret, redirectUris: req.body.redirect_uris || [] };
  res.status(201).json({ client_id: clientId, client_secret: clientSecret, redirect_uris: req.body.redirect_uris || [] });
});

app.get('/oauth/authorize', function(req, res) {
  const code = 'code_' + crypto.randomBytes(16).toString('hex');
  authCodes[code] = { client_id: req.query.client_id, redirect_uri: req.query.redirect_uri, ts: Date.now() };
  res.redirect(req.query.redirect_uri + '?code=' + code + (req.query.state ? '&state=' + req.query.state : ''));
});

app.post('/oauth/token', express.urlencoded({ extended: true }), function(req, res) {
  if (req.body.grant_type !== 'authorization_code') return res.status(400).json({ error: 'unsupported_grant_type' });
  const authCode = authCodes[req.body.code];
  if (!authCode) return res.status(400).json({ error: 'invalid_grant' });
  delete authCodes[req.body.code];
  const token = 'tok_' + crypto.randomBytes(32).toString('hex');
  accessTokens[token] = { client_id: req.body.client_id, ts: Date.now() };
  res.json({ access_token: token, token_type: 'bearer', expires_in: 86400 });
});

// ── MCP endpoints ────────────────────────────────────────────────────────────

app.get('/mcp', function(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write('data: ' + JSON.stringify({ type: 'connection', status: 'connected' }) + '\n\n');
  const keepAlive = setInterval(function() { res.write(': keepalive\n\n'); }, 25000);
  req.on('close', function() { clearInterval(keepAlive); });
});

app.post('/mcp', async function(req, res) {
  const body = req.body;
  const method = body && body.method;

  if (method === 'initialize') {
    return res.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'dhun-mcp-server', version: 'v9-yahoo' } } });
  }

  if (method === 'tools/list') {
    return res.json({ jsonrpc: '2.0', id: body.id, result: { tools: [
      { name: 'get_live_nifty', description: 'Live NIFTY 50 spot price from Yahoo Finance', inputSchema: { type: 'object', properties: {}, required: [] } },
      { name: 'get_live_banknifty', description: 'Live BANKNIFTY spot price from Yahoo Finance', inputSchema: { type: 'object', properties: {}, required: [] } },
      { name: 'get_option_chain', description: 'Option chain with PCR and OI for NIFTY or BANKNIFTY', inputSchema: { type: 'object', properties: { symbol: { type: 'string', default: 'NIFTY' } }, required: [] } },
      { name: 'get_signal', description: 'Trading signal based on PCR and OI analysis', inputSchema: { type: 'object', properties: { symbol: { type: 'string', default: 'NIFTY' } }, required: [] } }
    ] } });
  }

  if (method === 'tools/call') {
    const toolName = body.params && body.params.name;
    const toolArgs = (body.params && body.params.arguments) || {};
    try {
      let result;
      const sym = ((toolArgs.symbol) || 'NIFTY').toUpperCase();
      const yahooSym = sym === 'BANKNIFTY' ? '%5ENSEBANK' : '%5ENSEI';

      if (toolName === 'get_live_nifty') {
        const q = await yahooQuote('%5ENSEI');
        result = { spot: q.ltp, change: q.change, changePct: q.changePct, high: q.high, low: q.low, source: 'Yahoo Finance' };
      } else if (toolName === 'get_live_banknifty') {
        const q = await yahooQuote('%5ENSEBANK');
        result = { spot: q.ltp, change: q.change, changePct: q.changePct, high: q.high, low: q.low, source: 'Yahoo Finance' };
      } else if (toolName === 'get_option_chain') {
        result = await yahooOptionChain(yahooSym);
        result.symbol = sym;
      } else if (toolName === 'get_signal') {
        const data = await yahooOptionChain(yahooSym);
        result = Object.assign({ symbol: sym, spot: data.spot, pcr: data.pcr }, calculateSignal(data.spot, data.pcr, data.maxCEStrike, data.maxPEStrike), { nearExpiry: data.nearExpiry });
      } else {
        return res.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Tool not found: ' + toolName } });
      }
      return res.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
    } catch (e) {
      return res.json({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: e.message } });
    }
  }

  res.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
});

// ── Start server ─────────────────────────────────────────────────────────────

app.listen(PORT, function() {
  console.log('[START] dhun-mcp-server v9-yahoo on port', PORT);
  console.log('[START] Data source: Yahoo Finance - Free, No Token Required');
  console.log('[START] Endpoints ready: /get_live_nifty /get_live_banknifty /get_option_chain /get_signal');
});
