import { createStoreService } from './app.js';
import { runService } from './lib/server.js';

await runService(createStoreService);
