import pg from 'pg';
import { settings } from './config.js';
export const pool = new pg.Pool({ connectionString: settings.database, max: 10 });
