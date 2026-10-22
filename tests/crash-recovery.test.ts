import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Store } from '../apps/operator/src/store.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

describe('hard-crash durable outbox recovery', () => {
  it('recovers exactly one pending record after the owning process exited without cleanup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eventmesh-crash-'));
    try {
      const statePath = join(dir, 'state.json');
      const crashed = spawnSync(process.execPath, ['--import', 'tsx', join(here, 'helpers/simulate-crash.ts'), statePath], {
        cwd: root, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, NODE_ENV: 'test' }
      });
      expect(crashed.error).toBeUndefined();
      expect(crashed.status, crashed.stderr).toBe(23);
      const recovered = new Store(statePath);
      const pending = recovered.listOutbox('PENDING');
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        id: 'event:crash-recovery',
        attempts: 1,
        status: 'PENDING',
        lastError: 'CONNECTION_LOST_AFTER_DURABLE_WRITE'
      });
      recovered.markOutboxDelivered('event:crash-recovery');
      recovered.close();
      const next = new Store(statePath);
      expect(next.listOutbox('PENDING')).toHaveLength(0);
      expect(next.listOutbox('DELIVERED')).toHaveLength(1);
      next.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
