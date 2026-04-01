const { startBot } = await import('./bot.ts');

console.log('workspacecord starting...');
startBot().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
