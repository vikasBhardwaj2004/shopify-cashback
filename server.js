const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const app = express();

const GST_RATE = 0.18;
const CASHBACK_DAYS = 30;
const STORE = process.env.SHOPIFY_STORE_URL;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const WEBHOOK_SECRET = process.env.SHOPIFY_API_SECRET;

app.use('/webhooks', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/', (req, res) => res.send('Cashback app running ✓'));

app.post('/webhooks/orders-create', async (req, res) => {
  res.sendStatus(200);
});

app.get('/cron/expire', (req, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Cashback server on port ' + PORT);
});
