const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;
const BASE_URL = 'https://dhun-mcp-server.onrender.com';

app.use((req, res, next) => {
  const ts = new Date().toISOString();
  console.log('[REQ]', ts, req.method, req.path, JSON.stringify(req.query), JSON.stringify(req.body || {}).slice(0, 300));
  res.on('finish', () => console.log('[RES]', req.method, req.path, res.statusCode));
  next();
});

const registeredClients = {};
const authCodes = {};
const accessTokens = {};

// NSE API helpers
const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.nseindia.com/',
  'Connection': 'keep-alive'
};

let nse_cookies = '';
let nse_cookie_ts = 0;

async function getNSECookies() {
  const now = Date.now();
  if (nse_cookies && (now - nse_cookie_ts) < 5 * 60 * 1000) return nse_cookies;
  try {
    const res = await fetch('https://www.nseindia.com/', { headers: NSE_HEADERS });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      nse_cookies = setCookie.split(',').map(c => c.split(';')[0]).join('; ');
      nse_cookie_ts = now;
      console.log('[NSE] Cookies refreshed');
    }
  } catch (e) {
    console.log('[NSE] Cookie fetch error:', e.message);
  }
  return nse_cookies;
}

async function nseGet(url) {
  const cookies = await getNSECookies();
  const headers = { ...NSE_HEADERS, 'Cookie': cookies };
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error('NSE API error: ' + res.status + ' ' + url);
  return await res.json();
}

async function fetchNiftyOptionChain() {
  return await nseGet('https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY');
}

async function fetchBankNiftyOptionChain() {
  return await nseGet('https://www.nseindia.com/api/option-chain-indices?symbol=BANKNIFTY');
}

function processOptionChain(data, symbol) {
  const records = data && data.records;
  const spot = (records && records.underlyingValue) || 0;
  const expiryDates = (records && records.expiryDates) || [];
  const nearExpiry = expiryDates[0] || '';

  let totalCEOI = 0, totalPEOI = 0;
  let maxCEOI = 0, maxPEOI = 0;
  let maxCEStrike = 0, maxPEStrike = 0;
  const optionData = [];

  ((records && records.data) || []).forEach(function(item) {
    const strike = item.strikePrice;
    const ce = item.CE;
    const pe = item.PE;
    if (ce) {
      totalCEOI += ce.openInterest || 0;
      if ((ce.openInterest || 0) > maxCEOI) { maxCEOI = ce.openInterest; maxCEStrike = strike; }
    }
    if (pe) {
      totalPEOI += pe.openInterest || 0;
      if ((pe.openInterest || 0) > maxPEOI) { maxPEOI = pe.openInterest; maxPEStrike = strike; }
    }
    if (ce || pe) {
      optionData.push({
        strike: strike,
        ce_ltp: (ce && ce.lastPrice) || 0,
        ce_oi: (ce && ce.openInterest) || 0,
        ce_iv: (ce && ce.impliedVolatility) || 0,
        pe_ltp: (pe && pe.lastPrice) || 0,
        pe_oi: (pe && pe.openInterest) || 0,
        pe_iv: (pe && pe.impliedVolatility) || 0
      });
    }
  });

  const pcr = totalCEOI > 0 ? parseFloat((totalPEOI / totalCEOI).toFixed(3)) : 0;
  return {
    symbol: symbol,
    spot: spot,
    pcr: pcr,
    totalCEOI: totalCEOI,
    totalPEOI: totalPEOI,
    maxCEStrike: maxCEStrike,
    maxPEStrike: maxPEStrike,
    nearExpiry: nearExpiry,
    expiryDates: expiryDates.slice(0, 5),
    optionData: optionData.filter(function(o) { return o.strike >= spot * 0.97 && o.strike <= spot * 1.03; })
  };
}

function calculateSignal(spot, pcr, maxCEStrike, maxPEStrike) {
  let trend = 'sideways';
  let signal = 'WAIT';
  const reason = [];

  if (pcr < 0.7) { trend = 'bearish'; reason.push('PCR ' + pcr + ' < 0.7 bearish'); }
  else if (pcr > 1.3) { trend = 'bullish'; reason.push('PCR ' + pcr + ' > 1.3 bullish'); }
  else if (pcr > 1.1) { trend = 'mildly_bullish'; reason.push('PCR ' + pcr + ' mild bullish'); }
  else if (pcr < 0.85) { trend = 'mildly_bearish'; reason.push('PCR ' + pcr + ' mild bearish'); }
  else { reason.push('PCR ' + pcr + ' neutral'); }

  reason.push('Resistance (Max CE OI): ' + maxCEStrike);
  reason.push('Support (Max PE OI): ' + maxPEStrike);

  if (trend === 'bullish' || trend === 'mildly_bullish') { signal = 'BUY CE near ' + maxPEStrike; }
  else if (trend === 'bearish' || trend === 'mildly_bearish') { signal = 'BUY PE near ' + maxCEStrike; }
  else { signal = 'WAIT - Sell straddle near ' + Math.round((maxPEStrike + maxCEStrike) / 2); }

  return { trend: trend, signal: signal, reason: reason };
}

// Routes
app.get('/', function(req, res) {
  res.json({
    service: 'dhun-mcp-server', version: 'v8-nse', status: 'live',
    data_source: 'NSE India - Free, No Token',
    endpoints: ['/health', '/get_live_nifty', '/get_live_banknifty', '/get_option_chain', '/get_signal', '/mcp']
  });
});

app.get('/health', function(req, res) {
  res.json({ status: 'ok', ts: new Date().toISOString(), source: 'NSE India' });
});

app.get('/get_live_nifty', async function(req, res) {
  try {
    const data = await fetchNiftyOptionChain();
    const p = processOptionChain(data, 'NIFTY');
    res.json({ success: true, symbol: 'NIFTY', spot: p.spot, pcr: p.pcr, maxCEStrike: p.maxCEStrike, maxPEStrike: p.maxPEStrike, nearExpiry: p.nearExpiry, source: 'NSE India', ts: new Date().toISOString() });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/get_live_banknifty', async function(req, res) {
  try {
    const data = await fetchBankNiftyOptionChain();
    const p = processOptionChain(data, 'BANKNIFTY');
    res.json({ success: true, symbol: 'BANKNIFTY', spot: p.spot, pcr: p.pcr, maxCEStrike: p.maxCEStrike, maxPEStrike: p.maxPEStrike, nearExpiry: p.nearExpiry, source: 'NSE India', ts: new Date().toISOString() });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/get_option_chain', async function(req, res) {
  const symbol = ((req.query.symbol) || 'NIFTY').toUpperCase();
  try {
    const data = symbol === 'BANKNIFTY' ? await fetchBankNiftyOptionChain() : await fetchNiftyOptionChain();
    const p = processOptionChain(data, symbol);
    res.json(Object.assign({ success: true }, p, { source: 'NSE India', ts: new Date().toISOString() }));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/get_signal', async function(req, res) {
  const symbol = ((req.query.symbol) || 'NIFTY').toUpperCase();
  try {
    const data = symbol === 'BANKNIFTY' ? await fetchBankNiftyOptionChain() : await fetchNiftyOptionChain();
    const p = processOptionChain(data, symbol);
    const sig = calculateSignal(p.spot, p.pcr, p.maxCEStrike, p.maxPEStrike);
    res.json(Object.assign({ success: true, symbol: symbol, spot: p.spot, pcr: p.pcr }, sig, { nearExpiry: p.nearExpiry, source: 'NSE India', ts: new Date().toISOString() }));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// OAuth endpoints
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

// MCP endpoints
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
    return res.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'dhun-mcp-server', version: 'v8-nse' } } });
  }

  if (method === 'tools/list') {
    return res.json({ jsonrpc: '2.0', id: body.id, result: { tools: [
      { name: 'get_live_nifty', description: 'Live NIFTY spot, PCR, OI from NSE India', inputSchema: { type: 'object', properties: {}, required: [] } },
      { name: 'get_live_banknifty', description: 'Live BANKNIFTY spot, PCR, OI from NSE India', inputSchema: { type: 'object', properties: {}, required: [] } },
      { name: 'get_option_chain', description: 'Full option chain for NIFTY or BANKNIFTY', inputSchema: { type: 'object', properties: { symbol: { type: 'string', default: 'NIFTY' } }, required: [] } },
      { name: 'get_signal', description: 'Trading signal based on PCR and OI analysis', inputSchema: { type: 'object', properties: { symbol: { type: 'string', default: 'NIFTY' } }, required: [] } }
    ] } });
  }

  if (method === 'tools/call') {
    const toolName = body.params && body.params.name;
    const toolArgs = (body.params && body.params.arguments) || {};
    try {
      let result;
      if (toolName === 'get_live_nifty') {
        const p = processOptionChain(await fetchNiftyOptionChain(), 'NIFTY');
        result = { spot: p.spot, pcr: p.pcr, maxCEStrike: p.maxCEStrike, maxPEStrike: p.maxPEStrike, nearExpiry: p.nearExpiry, source: 'NSE India' };
      } else if (toolName === 'get_live_banknifty') {
        const p = processOptionChain(await fetchBankNiftyOptionChain(), 'BANKNIFTY');
        result = { spot: p.spot, pcr: p.pcr, maxCEStrike: p.maxCEStrike, maxPEStrike: p.maxPEStrike, nearExpiry: p.nearExpiry, source: 'NSE India' };
      } else if (toolName === 'get_option_chain') {
        const sym = ((toolArgs.symbol) || 'NIFTY').toUpperCase();
        result = processOptionChain(sym === 'BANKNIFTY' ? await fetchBankNiftyOptionChain() : await fetchNiftyOptionChain(), sym);
      } else if (toolName === 'get_signal') {
        const sym = ((toolArgs.symbol) || 'NIFTY').toUpperCase();
        const p = processOptionChain(sym === 'BANKNIFTY' ? await fetchBankNiftyOptionChain() : await fetchNiftyOptionChain(), sym);
        result = Object.assign({ symbol: sym, spot: p.spot, pcr: p.pcr }, calculateSignal(p.spot, p.pcr, p.maxCEStrike, p.maxPEStrike), { nearExpiry: p.nearExpiry });
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

app.listen(PORT, function() {
  console.log('[START] dhun-mcp-server v8-nse on port', PORT);
  console.log('[START] Data source: NSE India - Free, No Token Required');
  console.log('[START] Ready: /get_live_nifty /get_live_banknifty /get_option_chain /get_signal');
});
