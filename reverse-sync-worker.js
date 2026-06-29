const { reconcileDeletedCalendarEvents } = require('./reverse-sync');
require('dotenv').config();

const intervalMs = Number(process.env.REVERSE_SYNC_INTERVAL_MS || 30000);
let syncInProgress = false;

async function run() {
  if (syncInProgress) {
    console.log('REVERSE SYNC WORKER SKIPPED: sync already running');
    return;
  }

  syncInProgress = true;

  try {
    await reconcileDeletedCalendarEvents();
  } catch (error) {
    console.log('REVERSE SYNC WORKER ERROR:', error.response?.data || error.message);
  } finally {
    syncInProgress = false;
  }
}

console.log('Reverse sync worker started', { intervalMs });

run();
setInterval(run, intervalMs);
