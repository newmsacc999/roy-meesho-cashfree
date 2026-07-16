const products = require("../products.json");

const ordersUrl = () => process.env.CASHFREE_MODE === "PROD"
  ? "https://api.cashfree.com/pg/orders"
  : "https://sandbox.cashfree.com/pg/orders";

const siteUrl = (req) => process.env.SITE_URL
  ? process.env.SITE_URL.replace(/\/$/, "")
  : `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`;

module.exports = async (req, res) => {
  if (!process.env.CASHFREE_APP_ID || !process.env.CASHFREE_SECRET_KEY) {
    return res.status(500).json({ error: "Cashfree is not configured yet." });
  }

  const headers = {
    "x-client-id": process.env.CASHFREE_APP_ID,
    "x-client-secret": process.env.CASHFREE_SECRET_KEY,
    "x-api-version": "2022-01-01",
    "Content-Type": "application/json",
  };

  try {
    if (req.method === "GET") {
      const orderId = String(req.query.order_id || "");
      if (!orderId) return res.redirect(302, `${siteUrl(req)}/failed.html`);
      const response = await fetch(`${ordersUrl()}/${encodeURIComponent(orderId)}`, { headers });
      const order = await response.json();
      return res.redirect(302, `${siteUrl(req)}/${response.ok && order.order_status === "PAID" ? "success.html" : "failed.html"}`);
    }

    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
    const cart = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!cart.length) return res.status(400).json({ error: "Your cart is empty." });

    const quantities = new Map();
    for (const item of cart) {
      const id = Number(item?.id);
      const qty = Number(item?.qty);
      if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1 || qty > 10) {
        return res.status(400).json({ error: "Invalid cart." });
      }
      quantities.set(id, Math.min(10, (quantities.get(id) || 0) + qty));
    }

    let amount = 0;
    const lines = [];
    for (const [id, qty] of quantities) {
      const product = products.find((entry) => entry.id === id);
      if (!product) return res.status(400).json({ error: "A cart item is unavailable." });
      amount += product.price * qty;
      lines.push(`${product.name} x${qty}`);
    }

    const customer = req.body?.customer || {};
    const phone = String(customer.mobile || "").replace(/\D/g, "");
    if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: "Please enter a valid 10-digit mobile number." });

    const orderId = `ms_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const response = await fetch(ordersUrl(), {
      method: "POST",
      headers,
      body: JSON.stringify({
        order_id: orderId,
        order_amount: Number(amount.toFixed(2)),
        order_currency: "INR",
        customer_details: {
          customer_id: `customer_${phone}`,
          customer_name: String(customer.name || "Customer").slice(0, 100),
          customer_phone: phone,
        },
        order_meta: { return_url: `${siteUrl(req)}/api/create-order?order_id={order_id}` },
        order_note: lines.join(", ").slice(0, 450),
      }),
    });
    const order = await response.json();
    if (!response.ok || !order.payment_link) {
      console.error("Cashfree create-order error", order);
      return res.status(502).json({ error: "Could not start payment. Please try again." });
    }
    return res.status(200).json({ payment_link: order.payment_link });
  } catch (error) {
    console.error("Cashfree error", error);
    return res.status(500).json({ error: "Payment service is temporarily unavailable." });
  }
};
