import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const orphan = await pool.query(
  `select o.organization_id, o.name from organizations o
    where not exists (select 1 from organization_memberships m where m.organization_id = o.organization_id)`
);
const users = await pool.query(
  "select count(*)::int as c from users where primary_email like '%@example.test'"
);
console.log(
  JSON.stringify({ orphan: orphan.rows, testUsers: users.rows[0].c })
);
await pool.end();
