const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const env = require('./config/env');
const { apiLimiter } = require('./middleware/rateLimiter');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const app = express();

app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors({
  origin: env.frontendUrl === '*' ? true : env.frontendUrl.split(','),
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));
app.use('/api', apiLimiter);

// Fallback static file serving for uploads — only ever used when Cloudinary
// isn't configured (see src/services/storage.service.js). On Railway this
// directory does not survive a redeploy, so CLOUDINARY_* env vars must be set
// in production; this route exists purely for local development without
// cloud credentials.
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/health', (req, res) => res.json({ success: true, service: env.appName, status: 'ok', time: new Date().toISOString() }));

app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/users', require('./routes/user.routes'));
app.use('/api/wallet', require('./routes/wallet.routes'));
app.use('/api/transactions', require('./routes/transaction.routes'));
app.use('/api/vtu', require('./routes/vtu.routes'));
app.use('/api/cards', require('./routes/card.routes'));
app.use('/api/ads', require('./routes/ads.routes'));
app.use('/api/devices', require('./routes/device.routes'));
app.use('/api/transfers/offline', require('./routes/offlineTransfer.routes'));
app.use('/api/rewards', require('./routes/rewards.routes'));
app.use('/api/loans', require('./routes/loan.routes'));
app.use('/api/wealth', require('./routes/wealth.routes'));
app.use('/api/banks', require('./routes/bank.routes'));
app.use('/api/support', require('./routes/support.routes'));
app.use('/api/webhooks', require('./routes/webhook.routes'));
app.use('/api/admin', require('./routes/admin.routes'));

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
