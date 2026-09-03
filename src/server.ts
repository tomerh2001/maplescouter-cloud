import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { CharacterStore } from './store.js';

const config = loadConfig();
const logger = createLogger(config);
const store = await CharacterStore.open(config.dataDir, logger);
const app = await buildApp({ config, store, logger });

let closing = false;
function shutdown(signal: NodeJS.Signals): void {
  if (closing) return;
  closing = true;
  logger.info({ signal }, 'shutting down');
  app.close().then(
    () => process.exit(0),
    (err: unknown) => {
      logger.error({ err }, 'error while closing');
      process.exit(1);
    },
  );
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

try {
  await app.listen({ port: config.port, host: config.host });
  logger.info({ dataDir: config.dataDir, characters: store.size() }, 'maplescouter-cloud ready');
} catch (err) {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
}
