const logger = require('../utils/logger');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err.isApiError) {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
      details: err.details || undefined,
    });
  }

  // Postgres unique violation
  if (err.code === '23505') {
    return res.status(409).json({ success: false, message: 'A record with these details already exists.' });
  }
  // Postgres foreign key violation
  if (err.code === '23503') {
    return res.status(400).json({ success: false, message: 'Related record not found.' });
  }

  logger.error(err);
  return res.status(500).json({
    success: false,
    message: 'Something went wrong. Please try again shortly.',
  });
}

function notFoundHandler(req, res) {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
}

module.exports = { errorHandler, notFoundHandler };
