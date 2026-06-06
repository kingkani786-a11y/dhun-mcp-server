const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;
const BASE_URL = 'https://dhun-mcp-server.onrender.com';

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

// RFC 9728 - OAuth Protected Resource Metadata
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  console.log('[PROTECTED-RESOURCE] hit');
  res.json({
    resource: BASE_URL,
    authorization_servers: [BASE_URL],
    bearer_methods_supported: ['header'],
    resource_signing_alg_values_supported: ['RS256']
  });
});

// RFC 8414 - OAuth Authorization Server Metadata
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  console.log('[OAUTH-META] hit');
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

// OpenID Connect Discovery
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

// RFC 7591 - Dynamic Client Registration
app.post('/oauth/register', (req, res) => {
  console.log('[DCR] body:', JSON.stringify(req.body));
  const { client_name, redirect_uris, grant_types, response_types, scope } = req.body || {};
  if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris required' });
  }
  const clientId = 'dhun-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const clientSecret = 'sec-' + crypto.randomBytes(16).toString('hex');
  registeredClients[clientId] = {
    client_id: clientId, client_secret: clientSecret,
    client_name: client_name || 'Claude', redirect_uris: redirect_uris,
    grant_types: grant_types || ['authorization_code'],
    response_types: response_types || ['code'],
    scope: scope || 'mcp', token_endpoint_auth_method: 'none'
  };
  console.log('[DCR] registered:', clientId, 'redirects:', redirect_uris);
  res.status(201).json({
    client_id: clientId, client_secret: clientSecret,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: client_name || 'Claude', redirect_uris: redirect_uris,
    grant_types: grant_types || ['authorization_code'],
    response_types: response_types || ['code'],
    scope: scope || 'mcp', token_endpoint_auth_method: 'none'
  });
});

// OAuth Authorize - auto-approve, redirect with code
app.get('/oauth/authorize', (req, res) => {
  const { redirect_uri, state, code_challenge, code_challenge_method, client_id, scope } = req.query;
  console.log('[AUTHORIZE] client:', client_id, 'redirect:', redirect_uri, 'pkce:', code_challenge_method);
  if (!redirect_uri) return res.status(400).send('Missing redirect_uri');
  const code = 'code-' + crypto.randomBytes(16).toString('hex');
  authCodes[code] = {
    client_id: client_id,
    redirect_uri: redirect_uri,
    code_challenge: code_challenge || null,
    code_challenge_method: code_challenge_method || null,
    scope: scope || 'mcp',
    created_at: Date.now()
  };
  console.log('[AUTHORIZE] issued code:', code.slice(0, 20) + '...');
  let url = redirect_uri + '?code=' + encodeURIComponent(code);
  if (state) url += '&state=' + encodeURIComponent(state);
  res.redirect(302, url);
});

// OAuth Token Exchange
app.post('/oauth/token', (req, res) => {
  const body = req.body || {};
  console.log('[TOKEN] body:', JSON.stringify(body).slice(0, 400));
  const { grant_type, code, code_verifier, client_id } = body;
  if (grant_type !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }
  if (!code) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'Missing code' });
  }
  const stored = authCodes[code];
  if (!stored) {
    console.log('[TOKEN] code not found');
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid code' });
  }
  if (stored.code_challenge) {
    if (!code_verifier) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier required' });
    }
    const expected = stored.code_challenge_method === 'S256'
      ? crypto.createHash('sha256').update(code_verifier).digest('base64url')
      : code_verifier;
    if (expected !== stored.code_challenge) {
      console.log('[TOKEN] PKCE FAILED');
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE failed' });
    }
    console.log('[TOKEN] PKCE OK');
  }
  delete authCodes[code];
  const token = 'tok-' + crypto.randomBytes(24).toString('hex');
  accessTokens[token] = { client_id: client_id || stored.client_id, scope: stored.scope || 'mcp', created_at: Date.now() };
  console.log('[TOKEN] issued for client:', client_id || stored.client_id);
  res.json({ access_token: token, token_type: 'Bearer', expires_in: 86400, scope: stored.scope || 'mcp' });
});

// MCP Tools
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
  }
];

function runTool(name, args) {
  if (name === 'analyze_option') {
    const { strike, optionType, premium, delta, theta, iv } = args;
    const sig = delta && Math.abs(delta) > 0.4 ? 'STRONG' : 'MODERATE';
    return {
      strike: strike, optionType: optionType, premium: premium,
      signal: sig + '_BUY_' + optionType,
      delta: delta || 'N/A', iv: iv || 'N/A',
      analysis: optionType + ' strike ' + strike + ' premium ' + premium + ' | Signal: ' + sig
    };
  }
  if (name === 'get_signal') {
    const { niftySpot, trend, vix } = args;
    const sig = trend === 'bullish' ? 'BUY_CE' : trend === 'bearish' ? 'BUY_PE' : 'WAIT';
    return {
      niftySpot: niftySpot, trend: trend, vix: vix || 'N/A', signal: sig,
      entry: sig !== 'WAIT' ? 'ATM or 1-strike OTM ' + (trend === 'bullish' ? 'CE' : 'PE') : 'Wait for trend clarity'
    };
  }
  throw new Error('Unknown tool: ' + name);
}

// MCP JSON-RPC handler
function handleMCP(req, res) {
  const auth = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const body = req.body || {};
  const jsonrpc = body.jsonrpc;
  const id = body.id;
  const method = body.method;
  const params = body.params;
  console.log('[MCP] method:', method, 'auth:', auth ? 'present' : 'NONE');

  if (jsonrpc !== '2.0') {
    return res.json({ jsonrpc: '2.0', id: id || null, error: { code: -32600, message: 'Invalid Request' } });
  }

  if (method === 'initialize') {
    console.log('[MCP] initialize - client:', JSON.stringify(params && params.clientInfo));
    return res.json({
      jsonrpc: '2.0', id: id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'dhun-mcp-server', version: '6.0.0' }
      }
    });
  }

  if (method === 'notifications/initialized') {
    return res.status(204).end();
  }

  if (method === 'ping') {
    return res.json({ jsonrpc: '2.0', id: id, result: {} });
  }

  if (method === 'tools/list') {
    console.log('[MCP] tools/list');
    return res.json({ jsonrpc: '2.0', id: id, result: { tools: TOOLS } });
  }

  if (method === 'tools/call') {
    const toolName = params && params.name;
    const toolArgs = (params && params.arguments) || {};
    console.log('[MCP] tools/call:', toolName, JSON.stringify(toolArgs));
    try {
      const result = runTool(toolName, toolArgs);
      return res.json({
        jsonrpc: '2.0', id: id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false }
      });
    } catch (err) {
      return res.json({
        jsonrpc: '2.0', id: id,
        result: { content: [{ type: 'text', text: 'Error: ' + err.message }], isError: true }
      });
    }
  }

  console.log('[MCP] unknown method:', method);
  return res.json({ jsonrpc: '2.0', id: id, error: { code: -32601, message: 'Method not found: ' + method } });
}

// Claude posts JSON-RPC to base URL (root /) AND /mcp
app.post('/', handleMCP);
app.post('/mcp', handleMCP);

// GET routes
app.get('/', (req, res) => {
  res.json({ name: 'dhun-mcp-server', version: '6.0.0', status: 'ok' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '6.0.0', ts: new Date().toISOString() });
});

app.get('/tools', (req, res) => {
  res.json({ tools: TOOLS });
});

app.post('/call', (req, res) => {
  const { name, arguments: args } = req.body || {};
  try {
    res.json({ result: runTool(name, args || {}) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('[START] dhun-mcp-server v6 on port', PORT);
  console.log('[START] MCP at root POST /');
  console.log('[START] OAuth discovery: /.well-known/oauth-authorization-server');
  console.log('[START] Protected resource: /.well-known/oauth-protected-resource');
});
