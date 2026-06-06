const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('Dhun MCP Server LIVE');
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
    });

    app.post('/mcp', (req, res) => {
      res.json({ status: 'working' });
      });

      app.listen(PORT, () => {
        console.log('Server running on port', PORT);
        });
