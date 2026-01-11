#!/usr/bin/env node

/**
 * CLI entry point for playwriter-nat-relay
 * Handles command-line execution only.
 */

const CLI = require('../lib/cli');

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  process.exit(1);
});

// Start CLI
CLI.main();
