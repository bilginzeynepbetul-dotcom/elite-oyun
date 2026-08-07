const express = require('express');
const bcrypt = require('bcryptjs');
const stripe = require('stripe')('sk_test_...'); // Kendi anahtarını gir

const app = express();
app.use(express.json());

// Kayıt endpoint'i
app.post('/register', (req, res) => {
  // Kullanıcı kaydı + bcrypt hash
  const { password } = req.body;
  const hashedPassword = bcrypt.hashSync(password, 10);
  res.json({ message: 'Kullanıcı oluşturuldu', hash: hashedPassword });
});

// Ödeme endpoint'i
app.post('/payment', (req, res) => {
  // Stripe ödeme
  res.json({ message: 'Ödeme alındı' });
});

// Sunucuyu başlat
app.listen(3000, () => {
  console.log('🚀 Sunucu http://localhost:3000 adresinde çalışıyor');
});
