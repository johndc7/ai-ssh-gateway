#!/usr/bin/env node
import { runCli } from '../src/server.js';

runCli().catch((err) => {
  console.error('Fatal error starting AI SSH Gateway:', err);
  process.exit(1);
});
