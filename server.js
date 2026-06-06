const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

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
                          delta: { type: 'number', description: 'Delta value' },
                          theta: { type: 'number', description: 'Theta value' },
                          iv: { type: 'number', description: 'Implied volatility' }
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
  },
  {
        name: 'health_check',
        description: 'Check server health',
        inputSchema: { type: 'object', properties: {} }
  }
  ];

app.get('/', (req, res) => {
    res.json({ server: 'Dhun MCP Server', status: 'live', version: '2.0' });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/tools', (req, res) => {
    res.json({ tools: TOOLS });
});

app.post('/mcp', (req, res) => {
    const { method, params } = req.body || {};
    if (method === 'tools/list') return res.json({ tools: TOOLS });
    if (method === 'tools/call') {
          const { name, arguments: args } = params || {};
          return res.json(handleTool(name, args));
    }
    res.json({ status: 'ok', received: req.body });
});

app.post('/call', (req, res) => {
    const { name, arguments: args } = req.body || {};
    res.json(handleTool(name, args));
});

function handleTool(name, args) {
    if (name === 'health_check') {
          return { content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }) }] };
    }
    if (name === 'analyze_option') {
          const { strike, optionType, premium, delta, theta, iv } = args || {};
          const signal = (delta || 0) > 0.5 ? 'STRONG_ENTRY' : (delta || 0) > 0.3 ? 'MODERATE' : 'WAIT';
          return {
                  content: [{ type: 'text', text: JSON.stringify({
                            strike, optionType, premium, delta, theta, iv, signal,
                            advice: signal === 'STRONG_ENTRY' ? 'Enter - SL at premium minus 20 percent' : 'Wait for better entry'
                  }) }]
          };
    }
    if (name === 'get_signal') {
          const { niftySpot, trend, vix } = args || {};
          const recommendation = trend === 'bullish' ? 'BUY CE' : trend === 'bearish' ? 'BUY PE' : 'SELL STRADDLE';
          return {
                  content: [{ type: 'text', text: JSON.stringify({
                            niftySpot, trend, vix, recommendation,
                            strike: Math.round((niftySpot || 0) / 50) * 50,
                            riskLevel: (vix || 15) > 20 ? 'HIGH' : 'MODERATE'
                  }) }]
          };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown tool: ' + name }) }] };
}

app.listen(PORT, () => {
    console.log('Dhun MCP Server v2 running on port', PORT);
});
