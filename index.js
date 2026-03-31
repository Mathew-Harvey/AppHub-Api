require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const appRoutes = require('./routes/apps');
const folderRoutes = require('./routes/folders');
const workspaceRoutes = require('./routes/workspace');
const sandboxRoutes = require('./routes/sandbox');
const subscriptionRoutes = require('./routes/subscription');

const app = express();
const PORT = process.env.PORT || 3001;

// Security headers
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// CORS — exact origin matching (no startsWith to prevent subdomain bypass)
const allowedOrigins = new Set(
  [process.env.CLIENT_URL, 'http://localhost:5173', 'http://localhost:3001'].filter(Boolean)
);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      return callback(null, true);
    }
    callback(null, false);
  },
  credentials: true
}));

app.use(cookieParser());

// Stripe webhook needs the raw body — skip JSON parsing for that route
app.use((req, res, next) => {
  if (req.originalUrl === '/api/subscription/webhook') return next();
  express.json({ limit: '1mb' })(req, res, next);
});

// Rate limiting (skipped in test to avoid flaky tests)
const skipInTest = process.env.NODE_ENV === 'test' ? () => true : () => false;
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  skip: skipInTest,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' }
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  skip: skipInTest,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/apps', apiLimiter, appRoutes);
app.use('/api/folders', apiLimiter, folderRoutes);
app.use('/api/workspace', apiLimiter, workspaceRoutes);
app.use('/api/subscription', apiLimiter, subscriptionRoutes);
app.use('/sandbox', sandboxRoutes);

// Global error handler (catches multer errors, JSON parse errors, etc.)
app.use((err, req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large. Maximum size is 5MB.' });
  }
  if (err.message === 'Only HTML files are accepted' || err.message === 'Only image files are allowed') {
    return res.status(400).json({ error: err.message });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Export app for testing, start server only when run directly
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`AppHub API running on port ${PORT}`);
    console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`  Client URL:  ${process.env.CLIENT_URL || 'not set'}`);
  });
}

module.exports = app;
