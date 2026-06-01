const express  = require('express');
const crypto   = require('crypto');
const axios    = require('axios');
const app      = express();

const GST_RATE        = 0.18;
const CASHBACK_DAYS   = 30;
const STORE           = process.env.SHOPIFY_STORE_URL;
const ACCESS_TOKEN    = process.env.SHOPIFY_ACCESS_TOKEN;
const WEBHOOK_SECRET  = process.env.SHOPIFY_API_SECRET;

app.use('/webhooks', express.raw({ type: 'application/json' }));
app.use(express.json());

async function gql(query, variables = {}) {
  const res = await axios.post(
    `https://${STORE}/admin/api/2024-01/graphql.json`,
    { query, variables },
    { headers: {
        'X-Shopify-Access-Token': ACCESS_TOKEN,
        'Content-Type': 'application/json'
    }}
  );
  if (res.data.errors) throw new Error(JSON.stringify(res.data.errors));
  return res.data.data;
}

function verifyHmac(rawBody, hmacHeader) {
  const hash = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');
  return hash === hmacHeader;
}

async function getCustomerMeta(customerId) {
  const data = await gql(`{
    customer(id: "gid://shopify/Customer/${customerId}") {
      orderCount:    metafield(namespace: "cashback", key: "order_count")    { id value }
      walletBalance: metafield(namespace: "cashback", key: "wallet_balance") { id value }
      totalEarned:   metafield(namespace: "cashback", key: "total_earned")   { id value }
      batches:       metafield(namespace: "cashback", key: "batches")        { id value }
      history:       metafield(namespace: "cashback", key: "history")        { id value }
    }
  }`);
  const c = data.customer;
  return {
    orderCount:    parseInt(c.orderCount?.value    || '0', 10),
    walletBalance: parseFloat(c.walletBalance?.value || '0'),
    totalEarned:   parseFloat(c.totalEarned?.value   || '0'),
    batches:       JSON.parse(c.batches?.value       || '[]'),
    history:       JSON.parse(c.history?.value       || '[]'),
  };
}

async function saveCustomerMeta(customerId, { orderCount, walletBalance, totalEarned, batches, history }) {
  await gql(`
    mutation UpdateMeta($input: CustomerInput!) {
      customerUpdate(input: $input) {
        userErrors { field message }
      }
    }
  `, {
    input: {
      id: `gid://shopify/Customer/${customerId}`,
      metafields: [
        { namespace: 'cashback', key: 'order_count',    value: String(orderCount),             type: 'number_integer' },
        { namespace: 'cashback', key: 'wallet_balance', value: walletBalance.toFixed(2),        type: 'number_decimal' },
        { namespace: 'cashback', key: 'total_earned',   value: totalEarned.toFixed(2),          type: 'number_decimal' },
        { namespace: 'cashback', key: 'batches',        value: JSON.stringify(batches),         type: 'json'           },
        { namespace: 'cashback', key: 'history',        value: JSON.stringify(history),         type: 'json'           },
      ]
    }
  });
}

app.post('/webhooks/orders-create', async (req, res) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!verifyHmac(req.body, hmac)) return res.status(401).send('Unauthorized');

  const order      = JSON.parse(req.body);
  const customerId = order.customer?.id;
  if (!customerId) return res.sendStatus(200);

  try {
    const meta = await getCustomerMeta(customerId);
    const { orderCount, walletBalance, totalEarned, batches, history } = meta;

    const subtotal    = parseFloat(order.subtotal_price);
    const priceExGST  = subtotal / (1 + GST_RATE);
    const cashbackAmt = parseFloat(priceExGST.toFixed(2));

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + CASHBACK_DAYS);

    const attrs           = order.note_attributes || [];
    const useCashback     = attrs.find(a => a.name === 'use_cashback')?.value === 'yes';
    const requestedDeduct = parseFloat(attrs.find(a => a.name === 'cashback_to_apply')?.value || '0');
    let   walletDeducted  = 0;

    if (orderCount > 0 && useCashback && requestedDeduct > 0) {
      walletDeducted = Math.min(requestedDeduct, walletBalance);
      let remaining = walletDeducted;
      for (const batch of batches) {
        if (remaining <= 0) break;
        const deduct     = Math.min(batch.remaining, remaining);
        batch.remaining -= deduct;
        remaining       -= deduct;
      }
      history.push({ type: 'used', amount: walletDeducted, order_name: order.name, date: new Date().toISOString(), status: 'used', expires_at: null });
    }

    batches.push({ order_name: order.name, order_id: order.id, earned: cashbackAmt, remaining: cashbackAmt, credited_at: new Date().toISOString(), expires_at: expiresAt.toISOString() });
    history.push({ type: 'credit', amount: cashbackAmt, order_name: order.name, date: new Date().toISOString(), status: 'active', expires_at: expiresAt.toISOString() });

    const activeBatches = batches.filter(b => b.remaining > 0 && new Date(b.expires_at) > new Date());
    const newBalance    = Math.max(0, walletBalance - walletDeducted + cashbackAmt);

    await saveCustomerMeta(customerId, { orderCount: orderCount + 1, walletBalance: newBalance, totalEarned: totalEarned + cashbackAmt, batches: activeBatches, history });
    console.log(`[ORDER ${order.name}] Credited ₹${cashbackAmt} | Deducted ₹${walletDeducted} | Balance ₹${newBalance}`);
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).send(err.message);
  }
});

app.get('/cron/expire', async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET) return res.status(401).send('Unauthorized');
  res.json({ ok: true });
});

app.get('/', (req, res) => res.send('Cashback app running ✓'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Cashback server on port ${PORT}`));
