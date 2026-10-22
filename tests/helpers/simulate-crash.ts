/** Intentionally exits without calling Store.close() to model a hard process crash. */
import { Store } from '../../apps/operator/src/store.js';
const filename = process.argv[2];
if (!filename) process.exit(2);
const store = new Store(filename);
store.enqueueOutbox({
  id: 'event:crash-recovery',
  sessionId: 'ses_crash_recovery',
  kind: 'EVENT',
  path: '/peer/sessions/ses_crash_recovery/events',
  body: { signedEvent: 'test-only-fixture' }
});
store.markOutboxAttempt('event:crash-recovery', 'CONNECTION_LOST_AFTER_DURABLE_WRITE');
// Deliberately leave .lock on disk; reopening must establish the PID is dead.
process.exit(23);
