import { randomUUID } from 'node:crypto';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
export function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write = (name, fields) => {
    if (LEVELS[name] < threshold) return;
    const record = { ts: new Date().toISOString(), level: name, ...fields };
    const line = JSON.stringify(record, (_key, value) => {
      if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
      return value;
    });
    if (name === 'error' || name === 'warn') console.error(line); else console.log(line);
  };
  return {
    debug: fields => write('debug', fields),
    info: fields => write('info', fields),
    warn: fields => write('warn', fields),
    error: fields => write('error', fields),
    child: base => ({
      debug: fields => write('debug', { ...base, ...fields }),
      info: fields => write('info', { ...base, ...fields }),
      warn: fields => write('warn', { ...base, ...fields }),
      error: fields => write('error', { ...base, ...fields }),
    }),
  };
}
export function requestId() { return randomUUID(); }
