import('./dist/prod.mjs').catch((err) => {
  console.error('[server.cjs] failed to start dist/prod.mjs:', err);
  process.exit(1);
});
