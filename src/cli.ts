export { runCli } from './cli-framework.ts';
export { startBot } from './cli-framework.ts';

// Backwards compatibility: direct execution
void (async () => {
  const { runCli } = await import('./cli-framework.ts');
  await runCli();
})().catch((err) => {
  console.error('Fatal CLI error:', err);
  process.exitCode = 1;
});
