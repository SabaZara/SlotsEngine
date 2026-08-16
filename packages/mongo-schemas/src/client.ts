import { MongoClient, type Db } from "mongodb";

export interface MongoConnection {
  client: MongoClient;
  db: Db;
}

/**
 * Connects to Mongo and hands back both the client and the database.
 *
 * The client is returned alongside the database because the money path
 * needs it directly: transactions are started from the client, and the
 * whole debit/evaluate/credit/insert sequence depends on being able to open
 * one.
 *
 * `ignoreUndefined` matters more than it looks — without it, an optional
 * field left `undefined` is stored as an explicit null, and a round read
 * back would no longer match the round that was written.
 */
export async function connectMongo(uri = process.env.MONGO_URI, dbName = process.env.MONGO_DB ?? "slots_engine"): Promise<MongoConnection> {
  if (!uri) {
    throw new Error("MONGO_URI is not set — required to connect to the database.");
  }
  const client = new MongoClient(uri, { ignoreUndefined: true });
  await client.connect();
  return { client, db: client.db(dbName) };
}
