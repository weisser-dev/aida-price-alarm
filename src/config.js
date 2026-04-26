require('dotenv').config();
const path = require('path');

const bool = (v, d = false) => {
  if (v === undefined || v === null || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  baseUrl: process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
  databasePath: path.resolve(process.env.DATABASE_PATH || './data/aida.db'),
  scrape: {
    cron: process.env.SCRAPE_CRON || '15 6 * * *',
    useMock: bool(process.env.USE_MOCK, true),
    apiUrl: process.env.AIDA_API_URL || '',
    userAgent:
      process.env.AIDA_USER_AGENT ||
      'Mozilla/5.0 (compatible; AidaPriceTracker/1.0)',
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'AIDA Preisalarm <noreply@example.com>',
  },
};

module.exports = config;
