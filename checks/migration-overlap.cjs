const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { PostgreSqlContainer } = require(path.join(process.cwd(), 'packages/testkit/node_modules/@testcontainers/postgresql'));
const { Client } = require(path.join(process.cwd(), 'packages/db/node_modules/pg'));

const migrationPath = 'packages/db/prisma/migrations/20261115120100_multi_account_push/migration.sql';
const oldSql = execFileSync('git', ['show', `fb91575ccd802e00abfc9891e9bcf1edf1eb9e07:${migrationPath}`], { encoding: 'utf8' });
const newSql = readFileSync(migrationPath, 'utf8');

async function waitFor(predicate) {
  const until = Date.now() + 10000;
  while (!(await predicate())) {
    if (Date.now() > until) throw new Error('Timed out waiting for the controlled database barrier');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

(async () => {
  const postgres = await new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('migration_fixture').withUsername('fixture').withPassword('fixture-password').start();
  try {
    let index = 0;
    for (const [version, sql, operation] of [
      ['before', oldSql, 'unregister'],
      ['before', oldSql, 'rotate'],
      ['after', newSql, 'unregister'],
      ['after', newSql, 'rotate'],
      ['after', newSql, 'register'],
      ['after', newSql, 'transfer'],
    ]) {
      const schema = `fixture_${++index}`;
      const gate = 42000 + index;
      const clients = [0, 1, 2].map(() => new Client({ connectionString: postgres.getConnectionUri() }));
      await Promise.all(clients.map(client => client.connect()));
      const [controller, migrator, legacy] = clients;
      let migrating;
      let writing;
      try {
        await controller.query(`CREATE SCHEMA ${schema}`);
        await Promise.all(clients.map(client => client.query(`SET search_path TO ${schema}`)));
        await controller.query(`
          CREATE TABLE "user" (id TEXT PRIMARY KEY);
          INSERT INTO "user" VALUES ('family'), ('work');
          CREATE TABLE push_tokens (
            "userId" TEXT PRIMARY KEY REFERENCES "user"(id),
            "sessionId" TEXT NOT NULL, ciphertext TEXT NOT NULL,
            "tokenDigest" TEXT NOT NULL UNIQUE, "updatedAt" TIMESTAMP(3) NOT NULL
          );
          INSERT INTO push_tokens VALUES ('family', 'family-session', 'fixture-sealed', 'original', CURRENT_TIMESTAMP);
          CREATE FUNCTION app_rls_bypass() RETURNS BOOLEAN LANGUAGE sql AS 'SELECT true';
        `);
        const migratorPid = (await migrator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const legacyPid = (await legacy.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await controller.query('SELECT pg_advisory_lock($1)', [gate]);
        const pausedSql = sql.replace('FROM "push_tokens";', `FROM "push_tokens";\nSELECT pg_advisory_xact_lock(${gate});`);
        assert.notEqual(pausedSql, sql);
        migrating = migrator.query(pausedSql);
        migrating.catch(() => undefined);
        await waitFor(async () => (await controller.query(
          "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) AS waiting", [migratorPid]
        )).rows[0].waiting);
        const operations = {
          unregister: `DELETE FROM push_tokens WHERE "userId"='family'`,
          rotate: `UPDATE push_tokens SET "tokenDigest"='rotated', ciphertext='rotated-sealed', "updatedAt"=CURRENT_TIMESTAMP WHERE "userId"='family'`,
          register: `INSERT INTO push_tokens VALUES ('work','work-session','work-sealed','work-device',CURRENT_TIMESTAMP)`,
          transfer: `BEGIN; DELETE FROM push_tokens WHERE "userId"='family'; INSERT INTO push_tokens VALUES ('work','work-session','work-sealed','original',CURRENT_TIMESTAMP); COMMIT;`,
        };
        writing = legacy.query(operations[operation]);
        writing.catch(() => undefined);
        if (version === 'before') {
          await writing;
        } else {
          await waitFor(async () => (await controller.query(
            "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [legacyPid]
          )).rows[0]?.waiting);
        }
        await controller.query('SELECT pg_advisory_unlock($1)', [gate]);
        await Promise.all([migrating, writing]);
        const rows = (await controller.query('SELECT "userId", "tokenDigest" FROM push_registrations ORDER BY "userId"')).rows;
        if (version === 'before') {
          assert.deepEqual(rows, [{ userId: 'family', tokenDigest: 'original' }]);
          console.log(`Reproduced pre-fix ${operation} race at the backfill/trigger boundary.`);
        } else if (operation === 'unregister') {
          assert.deepEqual(rows, []);
          console.log('Verified concurrent unregister waits for atomic migration and removes the copied row.');
        } else if (operation === 'rotate') {
          assert.deepEqual(rows, [{ userId: 'family', tokenDigest: 'rotated' }]);
          console.log('Verified concurrent rotation waits for atomic migration and updates the copied row.');
        } else if (operation === 'register') {
          assert.equal((await controller.query("SELECT count(*)::int AS count FROM push_tokens WHERE \"userId\"='work'")).rows[0].count, 1);
          assert.deepEqual(rows, [{ userId: 'family', tokenDigest: 'original' }]);
          console.log('Verified concurrent legacy registration waits and remains available through the legacy fallback.');
        } else {
          assert.deepEqual(rows, [{ userId: 'family', tokenDigest: 'original' }]);
          assert.equal((await controller.query("SELECT \"userId\" FROM push_tokens WHERE \"tokenDigest\"='original'")).rows[0].userId, 'work');
          console.log('Verified concurrent legacy token transfer preserves the other saved account.');
        }
      } finally {
        await controller.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
        await Promise.all(clients.map(client => client.end().catch(() => undefined)));
        await Promise.allSettled([migrating, writing].filter(Boolean));
      }
    }
  } finally {
    await postgres.stop();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
