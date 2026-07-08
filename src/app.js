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

// Serve uploaded passport photos (in production, point this at S3/Cloudinary instead)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/health', (req, res) => res.json({ success: true, service: env.appName, status: 'ok', time: new Date().toISOString() }));
app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'OffPay Backend is running',
  });
});
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/users', require('./routes/user.routes'));
app.use('/api/wallet', require('./routes/wallet.routes'));
app.use('/api/transactions', require('./routes/transaction.routes'));
app.use('/api/banks', require('./routes/bank.routes'));
app.use('/api/support', require('./routes/support.routes'));
app.use('/api/webhooks', require('./routes/webhook.routes'));
app.use('/api/admin', require('./routes/admin.routes'));

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
