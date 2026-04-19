require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(cors({ origin: false }));

const TWILIO_URL = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`;

const FIXED_NUMBERS = [
  process.env.FIXED_NUMBER_1,
  process.env.FIXED_NUMBER_2,
  process.env.FIXED_NUMBER_3,
].filter(Boolean);

// ─── API KEY MIDDLEWARE ───────────────────────────────────────────────────────
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

  let phone = String(customerPhone).replace(/\D/g, '');
  if (phone.length === 12 && phone.startsWith('91')) phone = phone.slice(2);
  if (phone.length === 13 && phone.startsWith('091')) phone = phone.slice(3);
  if (phone.length !== 10) {
    return res.status(400).json({ success: false, message: 'Invalid phone number' });
  }
  req.body.customerPhone = phone;

  if (!/^[A-Za-z0-9\-_]+$/.test(String(orderId))) {
    return res.status(400).json({ success: false, message: 'Invalid order ID' });
  }

  next();
}

// ─── TWILIO WHATSAPP SENDER ───────────────────────────────────────────────────
async function sendWhatsApp(to, message) {
  try {
    const params = new URLSearchParams();
    params.append('From', `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`);
    params.append('To',   `whatsapp:+${to}`);
    params.append('Body', message);

    const response = await axios.post(TWILIO_URL, params, {
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    console.log(`✅ Sent to ${to} | sid: ${response.data.sid} | status: ${response.data.status}`);
    return { success: true, to };
  } catch (error) {
    const twilioError = error.response?.data;
    console.error(`❌ Failed ${to}:`, JSON.stringify(twilioError) || error.message);
    if (twilioError?.code) {
      console.error(`   Twilio code ${twilioError.code}: ${twilioError.message}`);
      console.error(`   More info: ${twilioError.more_info}`);
    }
    return { success: false, to, error: twilioError?.message || error.message };
  }
}

// ─── MESSAGE BUILDERS ─────────────────────────────────────────────────────────
function customerMessage(customerName, orderId, itemsSummary, totalAmount, paymentMethod) {
  return `Hello ${customerName},

✅ Your order has been confirmed!

🧾 Order ID     : ${orderId}
📦 Items        : ${itemsSummary}
💰 Amount Paid  : ₹${totalAmount}
💳 Payment Via  : ${paymentMethod}

Thank you for choosing NCM Spare Parts. We will notify you once your order is dispatched.`;
}

function staffMessage(orderId, customerName, customerPhone, itemsSummary, totalAmount, paymentMethod) {
  return `🔔 New Order — NCM Spare Parts

📋 Order ID  : ${orderId}
👤 Customer  : ${customerName}
📞 Phone     : ${customerPhone}
📦 Items     : ${itemsSummary}
💰 Amount    : ₹${totalAmount}
💳 Payment   : ${paymentMethod}

Please process this order at the earliest.`;
}

// ─── ORDER CONFIRMED ENDPOINT ─────────────────────────────────────────────────
app.post('/order-confirmed', requireApiKey, validateOrderInput, async (req, res) => {
  const { customerName, customerPhone, orderId,
          totalAmount, itemsSummary, paymentMethod } = req.body;

  const results = [];

  // Message 1 → Customer
  results.push(await sendWhatsApp(
    `91${customerPhone}`,
    customerMessage(customerName, orderId,
      itemsSummary || 'Spare Parts', totalAmount, paymentMethod || 'Online')
  ));

  // Message 2 → 3 Staff numbers
  for (const number of FIXED_NUMBERS) {
    results.push(await sendWhatsApp(
      number,
      staffMessage(orderId, customerName, customerPhone,
        itemsSummary || 'Spare Parts', totalAmount, paymentMethod || 'Online')
    ));
  }

  const failures = results.filter(r => !r.success);
  res.json({
    success: results.every(r => r.success),
    messagesSent: results.filter(r => r.success).length,
    total: results.length,
    ...(failures.length > 0 && {
      errors: failures.map(r => ({ to: r.to, error: r.error }))
    })
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'NCM WhatsApp Server running ✅', provider: 'Twilio' });
});

// Block all other routes
app.use((req, res) => {
  res.status(404).json({ message: 'Not found' });
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Server on port ${process.env.PORT || 3000}`);
});
