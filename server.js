require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
app.use(express.json());
app.use(cors());

const API_URL = `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`;

const FIXED_NUMBERS = [
  process.env.FIXED_NUMBER_1,
  process.env.FIXED_NUMBER_2,
  process.env.FIXED_NUMBER_3,
].filter(Boolean);

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
    console.error(`❌ Failed ${to}:`, error.response?.data || error.message);
    return { success: false, to, error: error.response?.data };
  }
}

app.post('/order-confirmed', async (req, res) => {
  const { customerName, customerPhone, orderId,
          totalAmount, itemsSummary, paymentMethod } = req.body;

  if (!customerName || !customerPhone || !orderId || !totalAmount) {
    return res.status(400).json({ success: false, message: "Missing fields" });
  }

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
    total: results.length,
    details: results
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'NCM WhatsApp Server running ✅' });
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Server on port ${process.env.PORT || 3000}`);
});
