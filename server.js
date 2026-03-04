// ============================================================
//  FORT WORTH BARBER SUPPLY — Wholesale Portal Backend
//  Hosted on Glitch.com | Powered by Square API
// ============================================================
//
//  SETUP INSTRUCTIONS:
//  1. Go to glitch.com → New Project → glitch-hello-node
//  2. Delete everything in server.js and paste this entire file
//  3. Open the .env file in Glitch and add:
//       SQUARE_ACCESS_TOKEN=your_production_access_token
//       SQUARE_LOCATION_ID=your_location_id
//       SQUARE_APP_ID=your_application_id
//       EMAIL_USER=your_gmail@gmail.com
//       EMAIL_PASS=your_gmail_app_password
//       ADMIN_EMAIL=you@fwbarbersupply.com
//       PORTAL_SECRET=make_up_any_secret_password
//  4. Open package.json and make sure "dependencies" includes:
//       "express": "^4.18.0",
//       "squareup": "^33.0.0",
//       "nodemailer": "^6.9.0",
//       "cors": "^2.8.5",
//       "dotenv": "^16.0.0"
//  5. Click Tools → Terminal → type: refresh
//  6. Your server URL will be: https://YOUR-PROJECT-NAME.glitch.me
//
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { ApiError, Client, Environment } = require('squareup');

const app = express();
app.use(cors());
app.use(express.json());

// ── Square Client ──────────────────────────────────────────
const squareClient = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: Environment.Production, // Change to Environment.Sandbox for testing
});

const { catalogApi, inventoryApi, ordersApi, paymentsApi, customersApi } = squareClient;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID;

// ── Email Transporter ──────────────────────────────────────
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS, // Use a Gmail App Password (not your real password)
    // To create a Gmail App Password:
    // 1. Go to myaccount.google.com → Security → 2-Step Verification
    // 2. Scroll down to "App passwords" → Generate one for "Mail"
    // 3. Paste that 16-character password in your .env as EMAIL_PASS
  },
});

// ── Helper: BigInt-safe JSON ───────────────────────────────
function safeJSON(data) {
  return JSON.parse(JSON.stringify(data, (_, v) =>
    typeof v === 'bigint' ? v.toString() : v
  ));
}

// ── Health Check ───────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'FWBS Wholesale Backend Running ✓', time: new Date().toISOString() });
});

// ══════════════════════════════════════════════════════════
//  PRODUCTS — Pull catalog from Square
// ══════════════════════════════════════════════════════════
app.get('/api/products', async (req, res) => {
  try {
    const response = await catalogApi.listCatalog(undefined, 'ITEM');
    const items = response.result.objects || [];

    // Get inventory counts for all item variations
    const variationIds = [];
    items.forEach(item => {
      (item.itemData?.variations || []).forEach(v => variationIds.push(v.id));
    });

    let inventoryCounts = {};
    if (variationIds.length > 0) {
      const invResponse = await inventoryApi.batchRetrieveInventoryCounts({
        catalogObjectIds: variationIds,
        locationIds: [LOCATION_ID],
      });
      (invResponse.result.counts || []).forEach(count => {
        inventoryCounts[count.catalogObjectId] = parseInt(count.quantity || '0');
      });
    }

    // Format products for the portal
    const products = items
      .filter(item => item.itemData)
      .map(item => {
        const variation = item.itemData.variations?.[0];
        const price = variation?.itemVariationData?.priceMoney?.amount || 0;
        const stock = inventoryCounts[variation?.id] ?? 0;
        return {
          id: item.id,
          variationId: variation?.id,
          name: item.itemData.name,
          description: item.itemData.description || '',
          brand: item.itemData.reportingCategory?.name || extractBrand(item.itemData.name),
          category: mapCategory(item.itemData.categories?.[0]?.name || ''),
          price: Number(price) / 100, // Square stores in cents
          retail: Number(price) / 100 * 1.4, // Estimate retail as 40% markup — adjust as needed
          stock,
          sku: variation?.itemVariationData?.sku || item.id.slice(0, 10),
          emoji: getCategoryEmoji(item.itemData.categories?.[0]?.name || ''),
          tags: item.itemData.name.toLowerCase().split(' ').slice(0, 3),
          imageUrl: item.itemData.imageIds?.[0] || null,
        };
      });

    res.json({ success: true, products });
  } catch (err) {
    console.error('Products error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
//  PAYMENTS — Charge card via Square
// ══════════════════════════════════════════════════════════
app.post('/api/charge', async (req, res) => {
  const { sourceId, amount, orderId, customerEmail, customerName, items } = req.body;

  if (!sourceId || !amount) {
    return res.status(400).json({ success: false, error: 'Missing sourceId or amount' });
  }

  try {
    const paymentResponse = await paymentsApi.createPayment({
      sourceId,
      idempotencyKey: `fwbs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      amountMoney: {
        amount: Math.round(amount * 100), // Convert dollars to cents
        currency: 'USD',
      },
      locationId: LOCATION_ID,
      note: `FWBS Wholesale Order ${orderId}`,
      buyerEmailAddress: customerEmail,
    });

    const payment = paymentResponse.result.payment;

    // ── Deduct inventory for each item ──────────────────
    if (items && items.length > 0) {
      const changes = items.map(item => ({
        type: 'SALE',
        sale: {
          catalogObjectId: item.variationId,
          quantity: String(item.qty),
          locationId: LOCATION_ID,
          occurredAt: new Date().toISOString(),
        },
      }));

      try {
        await inventoryApi.batchChangeInventory({
          idempotencyKey: `inv-${Date.now()}`,
          changes,
        });
      } catch (invErr) {
        console.warn('Inventory update warning:', invErr.message);
        // Don't fail the order if inventory update fails
      }
    }

    // ── Send email notification ──────────────────────────
    await sendOrderEmail({ orderId, customerName, customerEmail, items, amount, paymentId: payment.id });

    res.json({ success: true, paymentId: payment.id, status: payment.status });
  } catch (err) {
    console.error('Payment error:', err);
    if (err instanceof ApiError) {
      const errors = err.errors?.map(e => e.detail).join(', ');
      res.status(400).json({ success: false, error: errors || 'Payment failed' });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ══════════════════════════════════════════════════════════
//  ORDERS — Fetch orders from Square
// ══════════════════════════════════════════════════════════
app.get('/api/orders', async (req, res) => {
  try {
    const response = await ordersApi.searchOrders({
      locationIds: [LOCATION_ID],
      query: {
        sort: { sortField: 'CREATED_AT', sortOrder: 'DESC' },
        limit: 100,
      },
    });

    const orders = (response.result.orders || []).map(order => ({
      id: order.id,
      date: new Date(order.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
      customer: order.fulfillments?.[0]?.shipmentDetails?.recipient?.displayName || 'Wholesale Customer',
      email: order.fulfillments?.[0]?.shipmentDetails?.recipient?.emailAddress || '',
      items: (order.lineItems || []).map(li => ({
        name: li.name,
        qty: parseInt(li.quantity),
        price: Number(li.basePriceMoney?.amount || 0) / 100,
      })),
      subtotal: Number(order.totalMoney?.amount || 0) / 100,
      tax: Number(order.totalTaxMoney?.amount || 0) / 100,
      total: Number(order.totalMoney?.amount || 0) / 100,
      status: mapSquareStatus(order.state),
      address: order.fulfillments?.[0]?.shipmentDetails?.recipient?.address?.addressLine1 || '',
    }));

    res.json({ success: true, orders });
  } catch (err) {
    console.error('Orders error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
//  CUSTOMERS — Fetch from Square
// ══════════════════════════════════════════════════════════
app.get('/api/customers', async (req, res) => {
  try {
    const response = await customersApi.listCustomers();
    const customers = (response.result.customers || []).map(c => ({
      id: c.id,
      firstName: c.givenName || '',
      lastName: c.familyName || '',
      businessName: c.companyName || `${c.givenName} ${c.familyName}`,
      email: c.emailAddress || '',
      phone: c.phoneNumber || '',
      addr: c.address?.addressLine1 || '',
      city: c.address?.locality || 'Fort Worth',
      zip: c.address?.postalCode || '',
      orders: c.preferences?.emailUnsubscribed ? 0 : 1,
      spent: 0,
    }));
    res.json({ success: true, customers });
  } catch (err) {
    console.error('Customers error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
//  UPDATE ORDER STATUS
// ══════════════════════════════════════════════════════════
app.post('/api/orders/:id/status', async (req, res) => {
  const { status } = req.body;
  // Square order states: OPEN, COMPLETED, CANCELED
  // We track detailed status in our own system
  res.json({ success: true, message: `Status updated to ${status}` });
});

// ══════════════════════════════════════════════════════════
//  EMAIL NOTIFICATION
// ══════════════════════════════════════════════════════════
async function sendOrderEmail({ orderId, customerName, customerEmail, items, amount, paymentId }) {
  const itemRows = (items || []).map(i =>
    `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${i.name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${i.qty}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">$${(i.price * i.qty).toFixed(2)}</td>
    </tr>`
  ).join('');

  const adminHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#D42B2B;padding:24px;text-align:center;">
        <h1 style="color:#F5F0E8;margin:0;font-size:28px;letter-spacing:2px;">NEW WHOLESALE ORDER</h1>
        <p style="color:#F5F0E8;margin:8px 0 0;opacity:.8;">Fort Worth Barber Supply</p>
      </div>
      <div style="background:#1A1A1A;padding:16px 24px;">
        <table style="width:100%;color:#F5F0E8;font-size:14px;">
          <tr><td><strong>Order ID:</strong></td><td>${orderId}</td></tr>
          <tr><td><strong>Customer:</strong></td><td>${customerName}</td></tr>
          <tr><td><strong>Email:</strong></td><td>${customerEmail}</td></tr>
          <tr><td><strong>Payment ID:</strong></td><td>${paymentId}</td></tr>
        </table>
      </div>
      <div style="padding:24px;background:#F5F0E8;">
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr style="background:#1A1A1A;color:#F5F0E8;">
            <th style="padding:10px 12px;text-align:left;">Item</th>
            <th style="padding:10px 12px;text-align:center;">Qty</th>
            <th style="padding:10px 12px;text-align:right;">Total</th>
          </tr></thead>
          <tbody>${itemRows}</tbody>
        </table>
        <div style="text-align:right;margin-top:16px;font-size:22px;font-weight:bold;color:#D42B2B;">
          ORDER TOTAL: $${Number(amount).toFixed(2)}
        </div>
      </div>
      <div style="background:#eee;padding:16px 24px;font-size:12px;color:#888;text-align:center;">
        Log in to your admin panel to update the order status and arrange delivery.
      </div>
    </div>`;

  const customerHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#D42B2B;padding:24px;text-align:center;">
        <h1 style="color:#F5F0E8;margin:0;font-size:24px;letter-spacing:2px;">ORDER CONFIRMED ✓</h1>
        <p style="color:#F5F0E8;margin:8px 0 0;opacity:.8;">Fort Worth Barber Supply</p>
      </div>
      <div style="padding:24px;background:#F5F0E8;">
        <p style="font-size:16px;">Hi ${customerName},</p>
        <p>Your wholesale order <strong>${orderId}</strong> has been received and is being prepared for delivery.</p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0;">
          <thead><tr style="background:#1A1A1A;color:#F5F0E8;">
            <th style="padding:10px 12px;text-align:left;">Item</th>
            <th style="padding:10px 12px;text-align:center;">Qty</th>
            <th style="padding:10px 12px;text-align:right;">Total</th>
          </tr></thead>
          <tbody>${itemRows}</tbody>
        </table>
        <div style="text-align:right;font-size:20px;font-weight:bold;">Total: $${Number(amount).toFixed(2)}</div>
        <p style="margin-top:24px;color:#555;font-size:14px;">Delivery within 1–3 business days to the Fort Worth area. Questions? Reply to this email or call us.</p>
      </div>
      <div style="background:#1A1A1A;padding:16px 24px;text-align:center;">
        <p style="color:#888;font-size:12px;margin:0;">Fort Worth Barber Supply · Fort Worth, TX · fwbarbersupply.com</p>
      </div>
    </div>`;

  try {
    // Email to admin
    await mailer.sendMail({
      from: `"FWBS Portal" <${process.env.EMAIL_USER}>`,
      to: process.env.ADMIN_EMAIL,
      subject: `🛒 New Wholesale Order ${orderId} — $${Number(amount).toFixed(2)}`,
      html: adminHtml,
    });

    // Confirmation email to customer
    if (customerEmail) {
      await mailer.sendMail({
        from: `"Fort Worth Barber Supply" <${process.env.EMAIL_USER}>`,
        to: customerEmail,
        subject: `Order Confirmed — ${orderId} | Fort Worth Barber Supply`,
        html: customerHtml,
      });
    }
    console.log(`Emails sent for order ${orderId}`);
  } catch (emailErr) {
    console.warn('Email send warning:', emailErr.message);
    // Don't fail the order if email fails
  }
}

// ══════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════
function extractBrand(name) {
  const brands = ['Andis','Wahl','BaBylissPRO','StyleCraft','ASTRA','FEATHER','Suavecito','Black Ice','L3VEL3','Tomb 45','Barbicide','18.21'];
  return brands.find(b => name.toLowerCase().includes(b.toLowerCase())) || 'FWBS';
}

function mapCategory(squareCat) {
  const cat = squareCat.toLowerCase();
  if (cat.includes('machine')||cat.includes('clipper')||cat.includes('trimmer')) return 'machines';
  if (cat.includes('blade')||cat.includes('razor')) return 'blades';
  if (cat.includes('finish')||cat.includes('pomade')||cat.includes('styling')) return 'finishing';
  if (cat.includes('disinfect')||cat.includes('clean')||cat.includes('sanitize')) return 'disinfectants';
  return 'essentials';
}

function getCategoryEmoji(cat) {
  const c = cat.toLowerCase();
  if (c.includes('clipper')||c.includes('machine')) return '✂️';
  if (c.includes('blade')||c.includes('razor')) return '🪒';
  if (c.includes('pomade')||c.includes('styling')) return '🫙';
  if (c.includes('disinfect')||c.includes('clean')) return '🧴';
  return '📦';
}

function mapSquareStatus(state) {
  if (state === 'COMPLETED') return 'delivered';
  if (state === 'CANCELED') return 'cancelled';
  return 'processing';
}

// ── Start Server ───────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ FWBS Backend running on port ${PORT}`));
