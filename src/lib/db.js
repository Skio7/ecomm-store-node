import { MongoClient } from 'mongodb';

const DEFAULT_DB = 'deploykar_shop';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Connects to MongoDB, retrying for ~30s so the service survives the database
 * starting after it. The database name comes from MONGODB_DB, else the URI path,
 * else `deploykar_shop`.
 */
export async function connectDb(config, logger) {
  const client = new MongoClient(config.MONGODB_URI, { appName: config.SERVICE_NAME, serverSelectionTimeoutMS: 5000 });
  for (let attempt = 1; ; attempt++) {
    try {
      await client.connect();
      break;
    } catch (err) {
      if (attempt >= 6) throw new Error(`Could not connect to MongoDB: ${err.message}`);
      logger.warn({ attempt, err: err.message }, 'MongoDB connection failed; retrying');
      await sleep(attempt * 1000);
    }
  }
  const fromUri = client.options.dbName;
  const db = client.db(config.MONGODB_DB ?? (fromUri && fromUri !== 'test' ? fromUri : DEFAULT_DB));
  logger.info({ database: db.databaseName }, 'Connected to MongoDB');
  return { client, db, ping: () => db.command({ ping: 1 }) };
}

/** Documents are stored with `_id` = our string id; the API exposes it as `id`. */
export function out(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

export const isDuplicateKey = (err) => err?.code === 11000;
