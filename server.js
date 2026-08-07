const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
const { createAuthRouter } = require('./routes/authRoutes');
const adminAntiCheatRoutes = require('./adminAntiCheatRoutes');

// Ana route'lar
app.use('/api/auth', createAuthRouter());
app.use('/api/admin/anti-cheat', adminAntiCheatRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint bulunamadı' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Sunucu hatası' });
});

// Başlat
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server ${PORT} portunda çalışıyor`);
});
