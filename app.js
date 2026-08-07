const bcrypt = require('bcryptjs');
const stripe = require('stripe')('sk_test_...'); // Kendi anahtarını gir

// Versiyonu package.json'dan al
const bcryptVersion = require('./node_modules/bcryptjs/package.json').version;

console.log('✅ Bcrypt sürümü:', bcryptVersion);
console.log('✅ Stripe yüklendi!');

// Bcrypt ile şifre hash'leme örneği
const password = '123456';
const salt = bcrypt.genSaltSync(10);
const hash = bcrypt.hashSync(password, salt);
console.log('🔐 Hashlenmiş şifre:', hash);

// Hash doğrulama
const isMatch = bcrypt.compareSync(password, hash);
console.log('✅ Şifre eşleşiyor mu?', isMatch);
