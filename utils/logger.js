// utils/logger.js
'use strict';

const IS_PROD = process.env.NODE_ENV === 'production';

const logger = {
  info:  (...a) => console.log ('[INFO] ', new Date().toISOString(), ...a),
  warn:  (...a) => console.warn ('[WARN] ', new Date().toISOString(), ...a),
  error: (...a) => console.error('[ERROR]', new Date().toISOString(), ...a),
  debug: (...a) => { if (!IS_PROD) console.log('[DEBUG]', new Date().toISOString(), ...a); },
};

module.exports = logger;