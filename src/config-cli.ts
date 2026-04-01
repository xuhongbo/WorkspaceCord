import {
  getConfigValue,
  setConfigValue,
  deleteConfigValue,
  getAllConfig,
  getConfigPath,
  validateConfigValue,
  maskSensitive,
  SENSITIVE_KEYS,
  VALID_KEYS,
} from './global-config.ts';

function printHelp(): void {
  console.log(`
\x1b[1mworkspacecord config\x1b[0m — manage global configuration

\x1b[1mUsage:\x1b[0m
  workspacecord config setup            Interactive configuration wizard
  workspacecord config get <key>        Read a configuration value
  workspacecord config set <key> <val>  Write a configuration value
  workspacecord config unset <key>      Remove a configuration value
  workspacecord config list             List all configuration values
  workspacecord config path             Show the config file path

\x1b[1mValid keys:\x1b[0m
  ${Array.from(VALID_KEYS).join(', ')}
`);
}

export async function handleConfig(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case 'setup': {
      const { runSetup } = await import('./setup.ts');
      await runSetup();
      break;
    }

    case 'get': {
      const key = rest[0];
      if (!key) {
        console.error('Usage: workspacecord config get <key>');
        process.exit(1);
      }
      if (!VALID_KEYS.has(key)) {
        console.error(`Unknown config key: ${key}`);
        console.error(`Valid keys: ${Array.from(VALID_KEYS).join(', ')}`);
        process.exit(1);
      }
      const value = getConfigValue(key);
      if (value === undefined) {
        console.log(`(not set)`);
      } else {
        console.log(maskSensitive(key, value));
      }
      break;
    }

    case 'set': {
      const [key, value] = rest;
      if (!key || value === undefined) {
        console.error('Usage: workspacecord config set <key> <value>');
        process.exit(1);
      }
      const err = validateConfigValue(key, value);
      if (err) {
        console.error(err);
        process.exit(1);
      }
      setConfigValue(key, value);
      const display = SENSITIVE_KEYS.has(key) ? maskSensitive(key, value) : value;
      console.log(`\x1b[32m✓\x1b[0m ${key} = ${display}`);
      break;
    }

    case 'unset': {
      const key = rest[0];
      if (!key) {
        console.error('Usage: workspacecord config unset <key>');
        process.exit(1);
      }
      if (!VALID_KEYS.has(key)) {
        console.error(`Unknown config key: ${key}`);
        process.exit(1);
      }
      deleteConfigValue(key);
      console.log(`\x1b[32m✓\x1b[0m ${key} removed`);
      break;
    }

    case 'list': {
      const all = getAllConfig();
      const keys = Object.keys(all);
      if (keys.length === 0) {
        console.log('(no configuration set — run \x1b[36mworkspacecord config setup\x1b[0m)');
      } else {
        for (const key of keys) {
          const value = all[key] as string;
          console.log(`${key}=${maskSensitive(key, value)}`);
        }
      }
      break;
    }

    case 'path': {
      console.log(getConfigPath());
      break;
    }

    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;

    default:
      console.error(`Unknown config subcommand: ${subcommand}`);
      printHelp();
      process.exit(1);
  }
}
