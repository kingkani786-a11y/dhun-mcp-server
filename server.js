const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;
const BASE_URL = 'https://dhun-mcp-server.onrender.com';

// Dhan API credentials from environment
const DHAN_CLIENT_ID = process.env.DHAN_CLIENT_ID || '';
const DHAN_ACCESS_TOKEN = process.env.DHAN_ACCESS_TOKEN || '';

// Global request logger
app.use((req, res, next) => {
  const ts = new Date().toISOString();
  console.log('[REQ]', ts, req.method, req.path, JSON.stringify(req.query), JSON.stringify(req.body || {}).slice(0, 300));
  res.on('finish', () => console.log('[RES]', req.method, req.path, res.statusCode));
  next();
});

// In-memory stores
const registeredClients = {};
const authCodes = {};
const accessTokens = {};

// ─── Dhan API helpers ────────────────────────────────────────────────────────

async function dhanHeaders() {
  return {
    'Content-Type': 'application/json',
    'access-token': DHAN_ACCESS_TOKEN,
    'client-id': DHAN_CLIENT_ID
  };
}

// Get live LTP for a security
// securityId: NSE NIFTY 50 = "13", exchange = "NSE_FNO"
async function fetchLiveQuote(securityId, exchangeSegment) {
  const url = 'https://api.dhan.co/v2/marketfeed/ltp';
  const body = {
    NSE_FNO: [securityId]
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: await dhanHeaders(),
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Dhan LTP API error: ' + res.status + ' ' + err);
  }
  return await res.json();
}

// Get NIFTY 50 Index quote (NSE_IDX segment)
async function fetchNiftySpot() {
  const url = 'https://api.dhan.co/v2/marketfeed/ltp';
  const body = { IDX_I: ['13'] };
  const res = await fetch(url, {
    method: 'POST',
    headers: await dhanHeaders(),
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Dhan NIFTY spot error: ' + res.status + ' ' + err);
  }
  const data = await res.json();
  // Extract LTP from response
  const ltp = data?.data?.IDX_I?.['13']?.last_price
    || data?.IDX_I?.['13']?.ltp
    || data?.IDX_I?.['13']?.last_price
    || null;
  return { spot: ltp, raw: data };
}

// Get Option Chain for NIFTY
async function fetchOptionChain(expiryDate) {
  // expiryDate format: "2024-06-13"
  const url = 'https://api.dhan.co/v2/optionchain';
  const body = {
    UnderlyingScrip: 13,
    UnderlyingSeg: 'IDX_I',
    Expiry: expiryDate
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: await dhanHeaders(),
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Dhan Option Chain error: ' + res.status + ' ' + err);
  }
  return await res.json();
}

// ─── Signal calculation logic ─────────────────────────────────────────────────

function calculateSignal(spot, vix, pcr, optionChain) {
  let trend = 'sideways';
  let signal = 'WAIT';
  let reason = [];

  // PCR analysis
  if (pcr < 0.7) {
    trend = 'bearish';
    reason.push('PCR ' + pcr + ' < 0.7 (bearish)');
  } else if (pcr > 1.2) {
    trend = 'bullish';
    reason.push('PCR ' + pcr + ' > 1.2 (bullish)');
  } else {
    reason.push('PCR ' + pcr + ' neutral');
  }

  // VIX analysis
  if (vix > 20) {
    reason.push('VIX ' + vix + ' high - avoid buying premium');
    signal = 'AVOID';
  } else if (vix < 12) {
    reason.push('VIX ' + vix + ' low - premium cheap, good to buy');
  } else {
    reason.push('VIX ' + vix + ' moderate');
  }

  // Final signal
  if (signal !== 'AVOID') {
    if (trend === 'bearish') signal = 'BUY_PE';
    else if (trend === 'bullish') signal = 'BUY_CE';
    else signal = 'WAIT';
  }

  return { trend, signal, reason: reason.join(' | ') };
}

function analyzeOptionChain(chainData, spot) {
  if (!chainData || !chainData.data) return null;

  const strikes = chainData.data;
  let maxCeOI = 0, maxPeOI = 0;
  let maxCeStrike = 0, maxPeStrike = 0;
  let totalCeOI = 0, totalPeOI = 0;

  for (const strike of strikes) {
    const ceOI = strike.call_oi || 0;
    const peOI = strike.put_oi || 0;
    totalCeOI += ceOI;
    totalPeOI += peOI;
    if (ceOI > maxCeOI) { maxCeOI = ceOI; maxCeStrike = strike.strike_price; }
    if (peOI > maxPeOI) { maxPeOI = peOI; maxPeStrike = strike.strike_price; }
  }

  const pcr = totalCeOI > 0 ? (totalPeOI / totalCeOI).toFixed(2) : 'N/A';
  const atmStrike = Math.round(spot / 50) * 50;

  return {
    pcr: parseFloat(pcr),
    maxCeStrike,
    maxPeStrike,
    maxCeOI,
    maxPeOI,
    atmStrike,
    totalCeOI,
    totalPeOI
  };
}

// ─── MCP Tools definition ─────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'analyze_option',
    description: 'Analyze NIFTY option with Greeks for CE/PE entry signal',
    inputSchema: {
      type: 'object',
      properties: {
        strike: { type: 'number', description: 'Strike price' },
        optionType: { type: 'string', enum: ['CE', 'PE'], description: 'Option type' },
        premium: { type: 'number', description: 'Current premium' },
        delta: { type: 'number', description: 'Delta (-1 to 1)' },
        theta: { type: 'number', description: 'Theta daily decay' },
        iv: { type: 'number', description: 'Implied volatility %' }
      },
      required: ['strike', 'optionType', 'premium']
    }
  },
  {
    name: 'get_signal',
    description: 'Get CE/PE entry signal based on NIFTY spot and trend',
    inputSchema: {
      type: 'object',
      properties: {
        niftySpot: { type: 'number', description: 'NIFTY spot price' },
        trend: { type: 'string', enum: ['bullish', 'bearish', 'sideways'] },
        vix: { type: 'number', description: 'India VIX' }
      },
      required: ['niftySpot', 'trend']
    }
  },
  {
    name: 'get_live_nifty',
    description: 'Fetch live NIFTY 50 spot price from Dhan API',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_option_chain',
    description: 'Fetch live NIFTY option chain from Dhan API with PCR, max pain, OI walls',
    inputSchema: {
      type: 'object',
      properties: {
        expiry: { type: 'string', description: 'Expiry date in YYYY-MM-DD format e.g. 2025-06-12' }
      },
      required: ['expiry']
    }
  },
  {
    name: 'get_auto_signal',
    description: 'Auto-fetch live NIFTY spot + option chain and generate trading signal. No manual input needed.',
    inputSchema: {
      type: 'object',
      properties: {
        expiry: { type: 'string', description: 'Expiry date YYYY-MM-DD' },
        vix: { type: 'number', description: 'India VIX (manual input until VIX API available)' }
      },
      required: ['expiry', 'vix']
    }
  }
];

// ─── Tool execution ───────────────────────────────────────────────────────────

async function runTool(name, args) {

  // ── Original tools (no Dhan API) ──
  if (name === 'analyze_option') {
    const { strike, optionType, premium, delta, theta, iv } = args;
    const sig = delta && Math.abs(delta) > 0.4 ? 'STRONG' : 'MODERATE';
    return {
      strike, optionType, premium,
      signal: sig + '_BUY_' + optionType,
      delta: delta || 'N/A', iv: iv || 'N/A',
      analysis: optionType + ' strike ' + strike + ' premium ' + premium + ' | Signal: ' + sig
    };
  }

  if (name === 'get_signal') {
    const { niftySpot, trend, vix } = args;
    const sig = trend === 'bullish' ? 'BUY_CE' : trend === 'bearish' ? 'BUY_PE' : 'WAIT';
    return {
      niftySpot, trend, vix: vix || 'N/A', signal: sig,
      entry: sig !== 'WAIT' ? 'ATM or 1-strike OTM ' + (trend === 'bullish' ? 'CE' : 'PE') : 'Wait for trend clarity'
    };
  }

  // ── New Live Dhan API tools ──
  if (name === 'get_live_nifty') {
    if (!DHAN_ACCESS_TOKEN) throw new Error('DHAN_ACCESS_TOKEN not set in environment');
    const result = await fetchNiftySpot();
    return {
      source: 'Dhan API Live',
      spot: result.spot,
      timestamp: new Date().toISOString(),
      raw: result.raw
    };
  }

  if (name === 'get_option_chain') {
    if (!DHAN_ACCESS_TOKEN) throw new Error('DHAN_ACCESS_TOKEN not set in environment');
    const { expiry } = args;
    const chainData = await fetchOptionChain(expiry);
    return {
      source: 'Dhan API Live',
      expiry,
      timestamp: new Date().toISOString(),
      data: chainData
    };
  }

  if (name === 'get_auto_signal') {
    if (!DHAN_ACCESS_TOKEN) throw new Error('DHAN_ACCESS_TOKEN not set in environment');
    const { expiry, vix } = args;

    // Step 1: Get live spot
    const spotResult = await fetchNiftySpot();
    const spot = spotResult.spot;
    if (!spot) throw new Error('Could not fetch NIFTY spot. Check Dhan token.');

    // Step 2: Get option chain
    const chainData = await fetchOptionChain(expiry);

    // Step 3: Analyze
    const analysis = analyzeOptionChain(chainData, spot);
    if (!analysis) throw new Error('Option chain analysis failed');

    // Step 4: Generate signal
    const { trend, signal, reason } = calculateSignal(spot, vix, analysis.pcr, chainData);

    const atmStrike = analysis.atmStrike;
    const entryStrike = trend === 'bearish'
      ? atmStrike - 50
      : trend === 'bullish'
        ? atmStrike + 50
        : atmStrike;

    return {
      source: 'Dhan API Live + Auto Analysis',
      timestamp: new Date().toISOString(),
      spot,
      expiry,
      vix,
      pcr: analysis.pcr,
      atmStrike,
      maxCeWall: analysis.maxCeStrike,
      maxPeWall: analysis.maxPeStrike,
      trend,
      signal,
      suggestedStrike: entryStrike,
      suggestedOption: trend === 'bearish' ? entryStrike + ' PE' : trend === 'bullish' ? entryStrike + ' CE' : 'WAIT',
      reason
    };
  }

  throw new Error('Unknown tool: ' + name);
}

// ─── OAuth endpoints ──────────────────────────────────────────────────────────

app.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json({
    resource: BASE_URL,
    authorization_servers: [BASE_URL],
    bearer_methods_supported: ['header'],
    resource_signing_alg_values_supported: ['RS256']
  });
});

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: BASE_URL + '/oauth/authorize',
    token_endpoint: BASE_URL + '/oauth/token',
    registration_endpoint: BASE_URL + '/oauth/register',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    scopes_supported: ['mcp'],
    response_modes_supported: ['query']
  });
});

app.get('/.well-known/openid-configuration', (req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: BASE_URL + '/oauth/authorize',
    token_endpoint: BASE_URL + '/oauth/token',
    registration_endpoint: BASE_URL + '/oauth/register',
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    code_challenge_methods_supported: ['S256', 'plain'],
    grant_types_supported: ['authorization_code'],
    scopes_supported: ['mcp', 'openid']
  });
});

app.post('/oauth/register', (req, res) => {
  const { client_name, redirect_uris, grant_types, response_types, scope } = req.body || {};
  if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris required' });
  }
  const clientId = 'dhun-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const clientSecret = 'sec-' + crypto.randomBytes(16).toString('hex');
  registeredClients[clientId] = {
    client_id: clientId, client_secret: clientSecret,
    client_name: client_name || 'Claude', redirect_uris,
    grant_types: grant_types || ['authorization_code'],
    response_types: response_types || ['code'],
    scope: scope || 'mcp', token_endpoint_auth_method: 'none'
  };
  res.status(201).json({
    client_id: clientId, client_secret: clientSecret,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: client_name || 'Claude', redirect_uris,
    grant_types: grant_types || ['authorization_code'],
    response_types: response_types || ['code'],
    scope: scope || 'mcp', token_endpoint_auth_method: 'none'
  });
});

app.get('/oauth/authorize', (req, res) => {
  const { redirect_uri, state, code_challenge, code_challenge_method, client_id, scope } = req.query;
  if (!redirect_uri) return res.status(400).send('Missing redirect_uri');
  const code = 'code-' + crypto.randomBytes(16).toString('hex');
  authCodes[code] = {
    client_id, redirect_uri,
    code_challenge: code_challenge || null,
    code_challenge_method: code_challenge_method || null,
    scope: scope || 'mcp', created_at: Date.now()
  };
  let url = redirect_uri + '?code=' + encodeURIComponent(code);
  if (state) url += '&state=' + encodeURIComponent(state);
  res.redirect(302, url);
});

app.post('/oauth/token', (req, res) => {
  const body = req.body || {};
  const { grant_type, code, code_verifier, client_id } = body;
  if (grant_type !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }
  if (!code) return res.status(400).json({ error: 'invalid_request', error_description: 'Missing code' });
  const stored = authCodes[code];
  if (!stored) return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid code' });
  if (stored.code_challenge) {
    if (!code_verifier) return res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier required' });
    const expected = stored.code_challenge_method === 'S256'
      ? crypto.createHash('sha256').update(code_verifier).digest('base64url')
      : code_verifier;
    if (expected !== stored.code_challenge) return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE failed' });
  }
  delete authCodes[code];
  const token = 'tok-' + crypto.randomBytes(24).toString('hex');
  accessTokens[token] = { client_id: client_id || stored.client_id, scope: stored.scope || 'mcp', created_at: Date.now() };
  res.json({ access_token: token, token_type: 'Bearer', expires_in: 86400, scope: stored.scope || 'mcp' });
});

// ─── MCP JSON-RPC handler ─────────────────────────────────────────────────────

async function handleMCP(req, res) {
  const body = req.body || {};
  const { jsonrpc, id, method, params } = body;

  if (jsonrpc !== '2.0') {
    return res.json({ jsonrpc: '2.0', id: id || null, error: { code: -32600, message: 'Invalid Request' } });
  }

  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'dhun-mcp-server', version: '7.0.0' }
      }
    });
  }

  if (method === 'notifications/initialized') return res.status(204).end();
  if (method === 'ping') return res.json({ jsonrpc: '2.0', id, result: {} });

  if (method === 'tools/list') {
    return res.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  }

  if (method === 'tools/call') {
    const toolName = params && params.name;
    const toolArgs = (params && params.arguments) || {};
    console.log('[MCP] tools/call:', toolName, JSON.stringify(toolArgs));
    try {
      const result = await runTool(toolName, toolArgs);
      return res.json({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false }
      });
    } catch (err) {
      console.error('[TOOL ERROR]', toolName, err.message);
      return res.json({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: 'Error: ' + err.message }], isError: true }
      });
    }
  }

  return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
}

app.post('/', handleMCP);
app.post('/mcp', handleMCP);

app.get('/', (req, res) => res.json({ name: 'dhun-mcp-server', version: '7.0.0', status: 'ok' }));
app.get('/health', (req, res) => res.json({ status: 'ok', version: '7.0.0', ts: new Date().toISOString() }));
app.get('/tools', (req, res) => res.json({ tools: TOOLS }));

app.post('/call', async (req, res) => {
  const { name, arguments: args } = req.body || {};
  try {
    res.json({ result: await runTool(name, args || {}) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('[START] dhun-mcp-server v7 on port', PORT);
  console.log('[START] Dhan API:', DHAN_ACCESS_TOKEN ? 'TOKEN SET ✓' : 'TOKEN MISSING ✗');
});
