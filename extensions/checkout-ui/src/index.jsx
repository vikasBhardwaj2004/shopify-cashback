// extensions/checkout-ui/src/index.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Shopify Checkout UI Extension
// Shows cashback wallet balance and "Apply cashback" checkbox at checkout.
//
// To register this extension:
//   shopify app generate extension --type=checkout_ui_extension
//   then replace src/Checkout.jsx with this file.
//
// Docs: https://shopify.dev/docs/api/checkout-ui-extensions
// ─────────────────────────────────────────────────────────────────────────────

import {
  reactExtension,
  useApi,
  useCustomer,
  useCartLines,
  useTotalAmount,
  BlockStack,
  InlineStack,
  Text,
  Checkbox,
  Banner,
  Divider,
  useApplyCartLinesChange,
  useAttributeValues,
  useApplyAttributeChange,
} from "@shopify/ui-extensions-react/checkout";
import { useState, useEffect } from "react";

export default reactExtension("purchase.checkout.payment-method-list.render-before", () => (
  <CashbackWidget />
));

const APP_URL = "https://your-app-domain.com"; // Replace with your app URL

function CashbackWidget() {
  const { shop } = useApi();
  const customer = useCustomer();
  const totalAmount = useTotalAmount();
  const cartLines = useCartLines();
  const applyAttributeChange = useApplyAttributeChange();

  const [walletBalance, setWalletBalance] = useState(null);
  const [walletUsable, setWalletUsable] = useState(0);
  const [isApplied, setIsApplied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Read attribute to restore state on page reload
  const [appliedAttr] = useAttributeValues(["cashback_applied", "cashback_amount"]);

  useEffect(() => {
    if (!customer?.id) return;
    loadWalletData();
  }, [customer?.id]);

  async function loadWalletData() {
    try {
      setLoading(true);
      const customerId = customer.id; // already in GID format
      const mrpTotal = cartLines.reduce((sum, line) => {
        const compareAt = parseFloat(line.merchandise?.compareAtPrice?.amount || line.cost.totalAmount.amount);
        return sum + compareAt * line.quantity;
      }, 0);

      const res = await fetch(
        `${APP_URL}/api/wallet/${encodeURIComponent(customerId)}/calculate?mrpTotal=${mrpTotal}`,
        { headers: { "x-shopify-shop-domain": shop.myshopifyDomain } }
      );
      const data = await res.json();

      setWalletBalance(data.wallet.currentBalance);
      setWalletUsable(data.wallet.walletUsable);
      setIsApplied(appliedAttr?.cashback_applied === "true");
    } catch (e) {
      setError("Could not load wallet");
    } finally {
      setLoading(false);
    }
  }

  async function handleToggle(checked) {
    setIsApplied(checked);

    // Store intent as checkout attribute — your app reads this in the orders/paid webhook
    await applyAttributeChange({
      type: "updateAttribute",
      key: "cashback_applied",
      value: checked ? "true" : "false",
    });
    await applyAttributeChange({
      type: "updateAttribute",
      key: "cashback_amount",
      value: checked ? String(walletUsable) : "0",
    });
  }

  if (!customer?.id) return null;
  if (loading) return <Text>Loading wallet...</Text>;
  if (error) return null;
  if (walletBalance <= 0) return null;

  const fmt = (n) =>
    new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n);

  return (
    <BlockStack spacing="base">
      <Divider />
      <Text size="medium" emphasis="bold">
        Cashback Wallet
      </Text>

      {walletBalance > 0 && (
        <Banner status="success">
          <Text>
            You have {fmt(walletBalance)} in your wallet.{" "}
            {walletUsable > 0
              ? `You can apply up to ${fmt(walletUsable)} on this order.`
              : "Not enough balance to apply on this order."}
          </Text>
        </Banner>
      )}

      {walletUsable > 0 && (
        <Checkbox checked={isApplied} onChange={handleToggle}>
          <InlineStack spacing="tight">
            <Text>Apply {fmt(walletUsable)} cashback</Text>
            {isApplied && (
              <Text appearance="success" size="small">
                ✓ Applied — you save {fmt(walletUsable)}!
              </Text>
            )}
          </InlineStack>
        </Checkbox>
      )}

      <Text size="small" appearance="subdued">
        Cashback is valid for 30 days. Unused cashback expires automatically.
      </Text>
    </BlockStack>
  );
}
