require("dotenv").config();
require("express-async-errors");
require("@shopify/shopify-api/adapters/node");

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
const { shopifyApi, LATEST_API_VERSION } = require("@shopify/shopify-api");
const { startExpiryJob } = require("./jobs/expiry.job");
const logger = require("./utils/logger");

const authRoutes = require("./routes/auth.routes");
const webhookRoutes = require("./routes/webhook.routes");
const walletRoutes = require("./routes/wallet.routes");
const adminRoutes = require("./routes/admin.routes");

const app = express();

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SHOPIFY_SCOPES.split(","),
  hostName: process.env.HOST.replace(/https?:\/\//, ""),
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: false,
});

app.set("shopify", shopify);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-shopify-shop-domain']
}));
app.use(morgan("combined", { stream: { write: (msg) => logger.info(msg.trim()) } }));

app.use(
  "/api/webhooks",
  express.raw({ type: "application/json" }),
  webhookRoutes
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/auth", authRoutes(shopify));
app.use("/api/wallet", walletRoutes);
app.use("/api/admin", adminRoutes);

app.get("/health", (req, res) => res.json({ status: "ok", ts: new Date() }));
app.get("/", (req, res) => res.json({ status: "Cashback app running ✓" }));

app.use((err, req, res, _next) => {
  logger.error(err.message, { stack: err.stack });
  const status = err.status || 500;
  res.status(status).json({ error: err.message || "Internal server error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  logger.info(`Cashback app listening on port ${PORT}`);
  startExpiryJob();
});

module.exports = app;
