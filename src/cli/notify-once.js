#!/usr/bin/env node
const { findAlerts, sendAlertsForWatchers } = require('../services/notify');

(async () => {
  const alerts = findAlerts();
  console.log(`Found ${alerts.length} alert(s).`);
  await sendAlertsForWatchers(alerts);
  process.exit(0);
})();
