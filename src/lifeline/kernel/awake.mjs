// Latency is charged from the wall clock, so a host that sleeps mid-decision corrupts the run (P18 lesson).
// On macOS, hold an idle-sleep assertion for the life of this process.
import { spawn } from 'node:child_process';

export function stayAwake({ platform = process.platform, pid = process.pid } = {}) {
  if (platform !== 'darwin') return { held: false, reason: 'not macOS' };
  try {
    spawn('caffeinate', ['-i', '-w', String(pid)], { detached: true, stdio: 'ignore' }).unref();
    return { held: true };
  } catch (error) {
    return { held: false, reason: String(error.message ?? error) };
  }
}
