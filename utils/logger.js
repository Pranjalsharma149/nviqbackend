'use strict';

const { createLogger, format, transports } = require('winston');
require('winston-daily-rotate-file');

const IS_PROD = process.env.NODE_ENV === 'production';

// Custom format for high-scale observability
const customFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.errors({ stack: true }),
  format.splat(),
  format.json()
);

const logger = createLogger({
  level: IS_PROD ? 'info' : 'debug',
  format: customFormat,
  defaultMeta: { service: 'nviq-fleet-backend' },
  transports: [
    // 1. Error Logs: Critical for debugging 20k device pings
    new transports.DailyRotateFile({
      filename: 'logs/error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxFiles: '14d', // 2 weeks is standard for fleet audits
      zippedArchive: true, // Save disk space
    }),
    // 2. Combined Logs: Operational history
    new transports.DailyRotateFile({
      filename: 'logs/combined-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '7d',
      maxSize: '20m', 
      zippedArchive: true,
    }),
  ],
  // CRITICAL: Prevent the app from crashing silently
  exceptionHandlers: [
    new transports.File({ filename: 'logs/exceptions.log' })
  ],
  rejectionHandlers: [
    new transports.File({ filename: 'logs/rejections.log' })
  ]
});

// Dev Mode: Colorful console output
if (!IS_PROD) {
  logger.add(new transports.Console({
    format: format.combine(
      format.colorize(),
      format.printf(({ timestamp, level, message, service, ...rest }) => {
        return `[${timestamp}] ${level}: ${message} ${Object.keys(rest).length ? JSON.stringify(rest) : ''}`;
      })
    ),
  }));
}

module.exports = logger;