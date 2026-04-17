require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
app.use(express.json({ limit: '10kb' }));

// Only allow requests from known origins (browser CORS)
// Mobile apps bypass CORS but this blocks browser-based abuse
app.use(cors({ origin: false }));

const API_URL = `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`;

const FIXED_NUMBERS = [
  process.env.FIXED_NUMBER_1,
  process.env.FIXED_NUMBER_2,
  process.env.FIXED_NUMBER_3,
].filter(Boolean);

// ─── API KEY MIDDLEWARE ───────────────────────────────────────────────────────
// Every request to /order-confirmed must include the correct X-API-Key header.
// This prevents anyone who discovers the URL from triggering WhatsApp spam.
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_SECRET_KEY) {
    console.warn(`❌ Unauthorized request from ${req.ip}`);
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
}

// ─── INPUT VALIDATION ─────────────────────────────────────────────────────────
function validateOrderInput(req, res, next) {
  const { customerName, customerPhone, orderId, totalAmount } = req.body;

  if (!customerName || !customerPhone || !orderId || !totalAmount) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }

  // Normalize phone — strip non-digits, remove leading 91 if 12 digits, must end up 10 digits
  let phone = String(customerPhone).replace(/\D/g, '');
  if (phone.length === 12 && phone.startsWith('91')) phone = phone.slice(2);
  if (phone.length === 13 && phone.startsWith('091')) phone = phone.slice(3);
  if (phone.length !== 10) {
    return res.status(400).json({ success: false, message: 'Invalid phone number' });
  }
  req.body.customerPhone = phone; // use normalized 10-digit value

  // orderId must be alphanumeric
  if (!/^[A-Za-z0-9\-_]+$/.test(String(orderId))) {
    return res.status(400).json({ success: false, message: 'Invalid order ID' });
  }

  next();
}

async function sendWhatsApp(to, templateName, parameters) {
  try {
    await axios.post(API_URL, {
      messaging_product: "whatsapp",
      to: to,
      type: "template",
      template: {
        name: templateName,
        language: { code: "en" },
        components: [{
          type: "body",
          parameters: parameters.map(p => ({ type: "text", text: String(p) }))
        }]
      }
    }, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    });
    console.log(`✅ Sent to ${to}`);
    return { success: true, to };
  } catch (error) {
    // Log full error server-side, return minimal info to client
    console.error(`❌ Failed ${to}:`, error.response?.data || error.message);
    return { success: false, to };
  }
}

app.post('/order-confirmed', requireApiKey, validateOrderInput, async (req, res) => {
  const { customerName, customerPhone, orderId,
          totalAmount, itemsSummary, paymentMethod } = req.body;

  const results = [];

  // Template 1 → Customer
  results.push(await sendWhatsApp(
    `91${customerPhone}`,
    process.env.ORDER_TEMPLATE_NAME,
    [customerName, orderId, itemsSummary || 'Spare Parts',
     totalAmount, paymentMethod || 'Online']
  ));

  // Template 2 → 3 Staff numbers
  for (const number of FIXED_NUMBERS) {
    results.push(await sendWhatsApp(
      number,
      process.env.INTERNAL_TEMPLATE_NAME,
      [orderId, customerName, customerPhone,
       itemsSummary || 'Spare Parts', totalAmount, paymentMethod || 'Online']
    ));
  }

  res.json({
    success: results.every(r => r.success),
    messagesSent: results.filter(r => r.success).length,
    total: results.length
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'NCM WhatsApp Server running ✅' });
});

// Block all other routes
app.use((req, res) => {
  res.status(404).json({ message: 'Not found' });
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Server on port ${process.env.PORT || 3000}`);
});
