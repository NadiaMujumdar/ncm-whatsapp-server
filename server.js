require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const nodemailer = require('nodemailer');
const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(cors({ origin: false }));

const META_API_URL = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

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

// ─── META WHATSAPP SENDER ─────────────────────────────────────────────────────
// Sends a pre-approved template message via Meta Cloud API.
// `to`         — phone in E.164 without '+' (e.g. "919876543210")
// `template`   — template name string
// `parameters` — array of { type: "text", text: "value" } in template slot order
async function sendWhatsApp(to, template, parameters) {
  try {
    const response = await axios.post(
      META_API_URL,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: template,
          language: { code: 'en' },
          components: [
            {
              type: 'body',
              parameters,
            },
          ],
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const msgId = response.data?.messages?.[0]?.id;
    console.log(`✅ Sent to ${to} | template: ${template} | id: ${msgId}`);
    return { success: true, to };
  } catch (error) {
    const metaError = error.response?.data?.error;
    console.error(`❌ Failed ${to}:`, JSON.stringify(metaError) || error.message);
    return { success: false, to, error: metaError?.message || error.message };
  }
}

// ─── ORDER CONFIRMED ENDPOINT ─────────────────────────────────────────────────
app.post('/order-confirmed', requireApiKey, validateOrderInput, async (req, res) => {
  const { customerName, customerPhone, orderId,
          totalAmount, itemsSummary, paymentMethod } = req.body;

  const items   = itemsSummary  || 'Spare Parts';
  const payment = paymentMethod || 'Online';

  const results = [];

  // Message 1 → Customer (template: template_1__for_customer)
  // Slots: {{1}} Order Status, {{2}} Customer Name, {{3}} Order ID,
  //        {{4}} Items Summary, {{5}} Total Amount, {{6}} Payment Method
  results.push(await sendWhatsApp(
    `91${customerPhone}`,
    'template_1__for_customer',
    [
      { type: 'text', text: 'Confirmed' },
      { type: 'text', text: customerName },
      { type: 'text', text: orderId },
      { type: 'text', text: items },
      { type: 'text', text: String(totalAmount) },
      { type: 'text', text: payment },
    ]
  ));

  // Message 2 → Staff numbers (template: internal_order_alert)
  // Slots: {{1}} Order Status, {{2}} Order ID, {{3}} Customer Name,
  //        {{4}} Customer Phone, {{5}} Items Summary, {{6}} Total Amount, {{7}} Payment Method
  for (const number of FIXED_NUMBERS) {
    results.push(await sendWhatsApp(
      number,
      'internal_order_alert',
      [
        { type: 'text', text: 'New Order' },
        { type: 'text', text: orderId },
        { type: 'text', text: customerName },
        { type: 'text', text: customerPhone },
        { type: 'text', text: items },
        { type: 'text', text: String(totalAmount) },
        { type: 'text', text: payment },
      ]
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

// ─── GMAIL TRANSPORTER ───────────────────────────────────────────────────────
const gmailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// ─── DISPATCH EMAIL ENDPOINT ─────────────────────────────────────────────────
app.post('/send-dispatch-email', requireApiKey, async (req, res) => {
  const {
    orderId, customerName, machineNumber, model, place,
    contactPerson, phone, address,
    partsList, totalAmount, awbNumber, transporterAgency, dispatchedAt
  } = req.body;

  if (!orderId || !awbNumber) {
    return res.status(400).json({ success: false, message: 'orderId and awbNumber are required' });
  }

  const recipients = (process.env.DISPATCH_EMAIL_TO || '').split(',').map(e => e.trim()).filter(Boolean);
  if (recipients.length === 0) {
    return res.status(500).json({ success: false, message: 'No dispatch email recipients configured' });
  }

  const partsHtml = (partsList || []).map(p =>
    `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${p.name || '-'}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center;">${p.qty || 0}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">Rs. ${Number(p.unitPrice||0).toLocaleString('en-IN',{maximumFractionDigits:0})}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:700;">Rs. ${Number(p.total||0).toLocaleString('en-IN',{maximumFractionDigits:0})}</td>
    </tr>`
  ).join('');

  const html = `
    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:640px;margin:auto;color:#222;">
      <div style="background:#1a237e;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0;">
        <h2 style="margin:0;font-size:20px;">NCM Parts — Order Dispatched</h2>
        <p style="margin:4px 0 0;opacity:.8;font-size:13px;">Order ID: <b>${orderId}</b></p>
      </div>
      <div style="background:#e8f5e9;border:1px solid #a5d6a7;padding:12px 24px;">
        <p style="margin:0;color:#2e7d32;font-size:14px;">
          ✈ <b>AWB No: ${awbNumber}</b> &nbsp;|&nbsp; 🚛 Transporter: <b>${transporterAgency || '-'}</b><br/>
          Dispatched at: ${dispatchedAt || new Date().toLocaleString('en-IN')}
        </p>
      </div>
      <div style="background:#fff;border:1px solid #e0e0e0;border-top:none;padding:20px 24px;">
        <h3 style="font-size:13px;color:#1a237e;text-transform:uppercase;letter-spacing:.4px;margin:0 0 10px;">Customer Details</h3>
        <table style="width:100%;font-size:13px;border-collapse:collapse;">
          <tr><td style="color:#888;width:40%;padding:3px 0;">Name</td><td><b>${customerName||'-'}</b></td></tr>
          <tr><td style="color:#888;padding:3px 0;">Machine No.</td><td>${machineNumber||'-'}</td></tr>
          <tr><td style="color:#888;padding:3px 0;">Model</td><td>${model||'-'}</td></tr>
          <tr><td style="color:#888;padding:3px 0;">Place</td><td>${place||'-'}</td></tr>
          <tr><td style="color:#888;padding:3px 0;">Contact</td><td>${contactPerson||'-'} | ${phone||'-'}</td></tr>
          <tr><td style="color:#888;padding:3px 0;">Address</td><td>${address||'-'}</td></tr>
        </table>

        <h3 style="font-size:13px;color:#1a237e;text-transform:uppercase;letter-spacing:.4px;margin:18px 0 10px;">Parts Ordered</h3>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="background:#e8eaf6;">
              <th style="padding:8px 10px;text-align:left;color:#1a237e;">Part</th>
              <th style="padding:8px 10px;text-align:center;color:#1a237e;">Qty</th>
              <th style="padding:8px 10px;text-align:right;color:#1a237e;">Unit Price</th>
              <th style="padding:8px 10px;text-align:right;color:#1a237e;">Total</th>
            </tr>
          </thead>
          <tbody>${partsHtml}</tbody>
        </table>
        <p style="text-align:right;font-size:16px;font-weight:700;color:#1a237e;margin:12px 0 0;">
          Grand Total: Rs. ${Number(totalAmount||0).toLocaleString('en-IN',{maximumFractionDigits:0})}
        </p>
      </div>
      <div style="background:#f5f5f5;border:1px solid #e0e0e0;border-top:none;padding:10px 24px;border-radius:0 0 8px 8px;">
        <p style="margin:0;font-size:11px;color:#888;">NCM Parts — VSI Spare Parts Portal | Confidential</p>
      </div>
    </div>`;

  try {
    await gmailTransporter.sendMail({
      from: `"NCM Parts" <${process.env.GMAIL_USER}>`,
      to: recipients.join(', '),
      subject: `Order Dispatched: ${orderId} — AWB ${awbNumber}`,
      html,
    });
    console.log(`✅ Dispatch email sent for ${orderId} to ${recipients.join(', ')}`);
    res.json({ success: true, sentTo: recipients });
  } catch (err) {
    console.error('❌ Dispatch email failed:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'NCM WhatsApp Server running ✅', provider: 'Meta Cloud API' });
});

// Block all other routes
app.use((req, res) => {
  res.status(404).json({ message: 'Not found' });
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Server on port ${process.env.PORT || 3000}`);
});
