// Imported first by the host scripts that read or write state (user, apikey,
// delegate, policy), so they see the same .env.local the server does: its data
// directory, its Postgres storage, its mail provider. Imports run in order, so
// this runs before server/store.js decides where state lives. Variables
// already set in the shell win, as with the server.
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

dotenv.config({ path: fileURLToPath(new URL("../.env.local", import.meta.url)), quiet: true });
