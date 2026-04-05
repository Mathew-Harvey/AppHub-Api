/**
 * In-memory ring buffer for capturing server logs.
 * Intercepts console.log, console.warn, console.error and stores
 * recent entries for the super admin log viewer.
 */

const MAX_LOGS = 2000;

class LogBuffer {
  constructor(maxSize = MAX_LOGS) {
    this.maxSize = maxSize;
    this.logs = [];
  }

  add(level, message) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message: typeof message === 'string' ? message : JSON.stringify(message),
    };
    this.logs.push(entry);
    if (this.logs.length > this.maxSize) {
      this.logs.shift();
    }
  }

  getLogs() {
    return this.logs;
  }

  clear() {
    this.logs = [];
  }
}

const logBuffer = new LogBuffer();

// Store original console methods
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

function formatArgs(args) {
  return args
    .map(a => {
      if (a instanceof Error) return `${a.message}\n${a.stack || ''}`;
      if (typeof a === 'object') {
        try { return JSON.stringify(a); } catch { return String(a); }
      }
      return String(a);
    })
    .join(' ');
}

function install() {
  console.log = (...args) => {
    originalLog.apply(console, args);
    logBuffer.add('info', formatArgs(args));
  };

  console.warn = (...args) => {
    originalWarn.apply(console, args);
    logBuffer.add('warn', formatArgs(args));
  };

  console.error = (...args) => {
    originalError.apply(console, args);
    logBuffer.add('error', formatArgs(args));
  };
}

/**
 * Morgan stream that also captures HTTP request logs.
 */
const morganStream = {
  write(message) {
    const trimmed = message.trim();
    logBuffer.add('http', trimmed);
    originalLog(trimmed);
  },
};

module.exports = { logBuffer, install, morganStream };
