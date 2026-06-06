const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;
const BASE_URL = 'https://dhun-mcp-server.onrender.com';

// ── Global request logger ─────────────────────────────────────────────────────
app.use((req, res, next) => {
        const ts = new Date().toISOString();
        console.log('[REQ]', ts, req.method, req.path, JSON.stringify(req.query), JSON.stringify(req.body || {}));
        res.on('finish', () => {
                  console.log('[RES]', req.method, req.path, res.statusCode);
        });
        next();
});

// ── In-memory stores ──────────────────────────────────────────────────────────
const registeredClients = {};  // client_id -> client info
const authCodes = {};           // code -> { client_id, redirect_uri, code_challenge, code_challenge_method, scope }
const accessTokens = {};        // token -> { client_id, scope }

// ── RFC 8414 – OAuth 2.0 Authorization Server Metadata ───────────────────────
app.get('/.well-known/oauth-authorization-server', (req, res) => {
        console.log('[OAUTH-META] Discovery endpoint hit');
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

// OpenID Connect Discovery (some clients check this too)
app.get('/.well-known/openid-configuration', (req, res) => {
        console.log('[OIDC] Discovery endpoint hit');
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

// ── RFC 7591 – Dynamic Client Registration ────────────────────────────────────
app.post('/oauth/register', (req, res) => {
        console.log('[DCR] Dynamic client registration body:', JSON.stringify(req.body));
        const { client_name, redirect_uris, grant_types, response_types, scope } = req.body || {};

           if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
                     return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris required' });
           }

           const clientId = 'dhun-client-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        const clientSecret = 'dhun-secret-' + crypto.randomBytes(16).toString('hex');

           registeredClients[clientId] = {
                     client_id: clientId,
                     client_secret: clientSecret,
                     client_name: client_name || 'Claude',
                     redirect_uris: redirect_uris,
                     grant_types: grant_types || ['authorization_code'],
                     response_types: response_types || ['code'],
                     scope: scope || 'mcp',
                     token_endpoint_auth_method: 'none'
           };

           console.log('[DCR] Registered client:', clientId, 'redirects:', redirect_uris);

           res.status(201).json({
                     client_id: clientId,
                     client_secret: clientSecret,
                     client_id_issued_at: Math.floor(Date.now() / 1000),
                     client_name: client_name || 'Claude',
                     redirect_uris: redirect_uris,
                     grant_types: grant_types || ['authorization_code'],
                     response_types: response_types || ['code'],
                     scope: scope || 'mcp',
                     token_endpoint_auth_method: 'none'
           });
});

// ── OAuth Authorization Endpoint ──────────────────────────────────────────────
app.get('/oauth/authorize', (req, res) => {
        const { redirect_uri, state, code_challenge, code_challenge_method, client_id, scope, response_type } = req.query;
        console.log('[AUTHORIZE] client_id:', client_id, 'redirect_uri:', redirect_uri, 'state:', state, 'pkce_method:', code_challenge_method);

          if (!redirect_uri) {
                    return res.status(400).send('Missing redirect_uri');
          }

          // Generate authorization code
          const code = 'dhun-code-' + crypto.randomBytes(16).toString('hex');

          // Store code with PKCE challenge for later verification
          authCodes[code] = {
                    client_id: client_id,
                    redirect_uri: redirect_uri,
                    code_challenge: code_challenge || null,
                    code_challenge_method: code_challenge_method || null,
                    scope: scope || 'mcp',
                    created_at: Date.now()
          };

          console.log('[AUTHORIZE] Issued code:', code.slice(0, 20) + '...');

          // Redirect back to Claude with code
          let url = redirect_uri + '?code=' + encodeURIComponent(code);
        if (state) url += '&state=' + encodeURIComponent(state);

          res.redirect(302, url);
});

// ── OAuth Token Endpoint ──────────────────────────────────────────────────────
app.post('/oauth/token', (req, res) => {
        // Support both JSON body and form-encoded body
           const body = req.body || {};
        console.log('[TOKEN] Request body:', JSON.stringify(body));

           const { grant_type, code, redirect_uri, code_verifier, client_id } = body;

           if (grant_type !== 'authorization_code') {
                     console.log('[TOKEN] Unsupported grant_type:', grant_type);
                     return res.status(400).json({ error: 'unsupported_grant_type' });
           }

           if (!code) {
                     console.log('[TOKEN] Missing code');
                     return res.status(400).json({ error: 'invalid_request', error_description: 'Missing code' });
           }

           const storedCode = authCodes[code];
        if (!storedCode) {
                  console.log('[TOKEN] Invalid/unknown code:', code ? code.slice(0, 20) + '...' : 'none');
                  return res.status(400).json({ error: 'invalid_grant', error_description: 'Code not found or expired' });
        }

           // PKCE verification
           if (storedCode.code_challenge) {
                     if (!code_verifier) {
                                 console.log('[TOKEN] PKCE challenge present but no verifier provided');
                                 return res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier required' });
                     }

          let expectedChallenge;
                     if (storedCode.code_challenge_method === 'S256') {
                                 expectedChallenge = crypto.createHash('sha256').update(code_verifier).digest('base64url');
                     } else {
                                 // plain
                       expectedChallenge = code_verifier;
                     }

          if (expectedChallenge !== storedCode.code_challenge) {
                      console.log('[TOKEN] PKCE verification FAILED. Expected:', storedCode.code_challenge, 'Got:', expectedChallenge);
                      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
          }
                     console.log('[TOKEN] PKCE verification PASSED');
           }

           // Invalidate code (single use)
           delete authCodes[code];

           // Issue access token
           const accessToken = 'dhun-access-' + crypto.randomBytes(24).toString('hex');
        accessTokens[accessToken] = {
                  client_id: client_id || storedCode.client_id,
                  scope: storedCode.scope || 'mcp',
                  created_at: Date.now()
        };

           console.log('[TOKEN] Issued access token for client:', client_id || storedCode.client_id);

           res.json({
                     access_token: accessToken,
                     token_type: 'Bearer',
                     expires_in: 86400,
                     scope: storedCode.scope || 'mcp'
           });
});

// ── MCP Tools definition ──────────────────────────────────────────────────────
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
                                          delta: { type: 'number', description: 'Delta value (-1 to 1)' },
                                          theta: { type: 'number', description: 'Theta (daily decay)' },
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
                                          trend: { type: 'string', enum: ['bullish', 'bearish', 'sideways'], description: 'Market trend' },
                                          vix: { type: 'number', description: 'India VIX value' }
                            },
                            required: ['niftySpot', 'trend']
                }
      }
      ];

// ── Tool execution logic ──────────────────────────────────────────────────────
function executeTool(name, args) {
        if (name === 'analyze_option') {
                  const { strike, optionType, premium, delta, theta, iv } = args;
                  const signal = delta && Math.abs(delta) > 0.4 ? 'STRONG' : 'MODERATE';
                  const risk = theta && Math.abs(theta) > 10 ? 'HIGH_DECAY' : 'NORMAL';
                  return {
                              strike,
                              optionType,
                              premium,
                              signal: signal + '_' + (optionType === 'CE' ? 'BUY' : 'BUY'),
                              risk,
                              analysis: optionType + ' at ' + strike + ', premium ' + premium + ', delta ' + (delta || 'N/A') + ', IV ' + (iv || 'N/A') + '%. Signal: ' + signal
                  };
        }
        if (name === 'get_signal') {
                  const { niftySpot, trend, vix } = args;
                  const highVix = vix && vix > 20;
                  const signal = trend === 'bullish' ? 'BUY_CE' : trend === 'bearish' ? 'BUY_PE' : 'WAIT';
                  return {
                              niftySpot,
                              trend,
                              vix: vix || 'N/A',
                              signal,
                              recommendation: highVix ? 'Reduce position size - high VIX ' + vix : 'Normal sizing ok',
                              entry: signal !== 'WAIT' ? 'ATM or 1 strike OTM ' + (trend === 'bullish' ? 'CE' : 'PE') : 'Wait for trend clarity'
                  };
        }
        throw new Error('Unknown tool: ' + name);
}

// ── JSON-RPC 2.0 MCP Endpoint ────────────────────────────────────────────────
app.post('/mcp', (req, res) => {
        const auth = req.headers['authorization'] || '';
        const token = auth.replace(/^Bearer\s+/i, '');
        console.log('[MCP] Request method:', req.body && req.body.method, 'auth present:', !!token);

           const { jsonrpc, id, method, params } = req.body || {};

           if (jsonrpc !== '2.0') {
                     return res.json({ jsonrpc: '2.0', id: id || null, error: { code: -32600, message: 'Invalid Request' } });
           }

           // Handle MCP methods
           if (method === 'initialize') {
                     console.log('[MCP] initialize - client:', JSON.stringify(params && params.clientInfo));
                     return res.json({
                                 jsonrpc: '2.0',
                                 id,
                                 result: {
                                               protocolVersion: '2024-11-05',
                                               capabilities: { tools: { listChanged: false } },
                                               serverInfo: { name: 'dhun-mcp-server', version: '5.0.0' }
                                 }
                     });
           }

           if (method === 'notifications/initialized') {
                     return res.json({ jsonrpc: '2.0', id: id || null, result: {} });
           }

           if (method === 'tools/list') {
                     console.log('[MCP] tools/list request');
                     return res.json({
                                 jsonrpc: '2.0',
                                 id,
                                 result: { tools: TOOLS }
                     });
           }

           if (method === 'tools/call') {
                     const toolName = params && params.name;
                     const toolArgs = params && params.arguments || {};
                     console.log('[MCP] tools/call:', toolName, JSON.stringify(toolArgs));

          try {
                      const result = executeTool(toolName, toolArgs);
                      return res.json({
                                    jsonrpc: '2.0',
                                    id,
                                    result: {
                                                    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                                                    isError: false
                                    }
                      });
          } catch (err) {
                      console.log('[MCP] tool error:', err.message);
                      return res.json({
                                    jsonrpc: '2.0',
                                    id,
                                    result: {
                                                    content: [{ type: 'text', text: 'Error: ' + err.message }],
                                                    isError: true
                                    }
                      });
          }
           }

           // Unknown method
           console.log('[MCP] Unknown method:', method);
        return res.json({
                  jsonrpc: '2.0',
                  id,
                  error: { code: -32601, message: 'Method not found: ' + method }
        });
});

// ── Simple REST endpoints (legacy + health) ───────────────────────────────────
app.get('/', (req, res) => {
        res.json({ name: 'dhun-mcp-server', version: '5.0.0', status: 'ok', mcp: BASE_URL + '/mcp' });
});

app.get('/health', (req, res) => {
        res.json({ status: 'ok', version: '5.0.0', ts: new Date().toISOString() });
});

app.get('/tools', (req, res) => {
        res.json({ tools: TOOLS });
});

app.post('/call', (req, res) => {
        const { name, arguments: args } = req.body || {};
        console.log('[CALL] tool:', name, 'args:', JSON.stringify(args));
        try {
                  const result = executeTool(name, args || {});
                  res.json({ result });
        } catch (err) {
                  res.status(400).json({ error: err.message });
        }
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
        console.log('[START] dhun-mcp-server v5 listening on port', PORT);
        console.log('[START] Base URL:', BASE_URL);
        console.log('[START] MCP endpoint:', BASE_URL + '/mcp');
        console.log('[START] OAuth discovery:', BASE_URL + '/.well-known/oauth-authorization-server');
});
