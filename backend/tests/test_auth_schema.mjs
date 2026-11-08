// Offline PostgreSQL-compatible SQL execution using PGlite (disposable memory DB).
// Optional dev-only runner: install @electric-sql/pglite outside application deps,
// then set PGLITE_MODULE to its dist/index.js and run node --test this file.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE).href : '@electric-sql/pglite');
const sql = await readFile(new URL('../migrations/001_google_identity_bootstrap_admin.sql', import.meta.url), 'utf8');

test('auth migration enforces identity and permanent-admin invariants', async (t) => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE public.users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL,
        google_subject text, active boolean NOT NULL DEFAULT true,
        created_at timestamptz DEFAULT now(), display_name text
      );
      CREATE TABLE public.role_assignments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
        role text NOT NULL, trainer_id uuid, revoked_at timestamptz
      );
      INSERT INTO users(email) VALUES ('aryapat1234@gmail.com');
      INSERT INTO role_assignments(user_id,role) SELECT id,'owner' FROM users;
    `);
    await db.exec(sql);

    await t.test('verified subject may be bound exactly once', async () => {
      const result = await db.query("UPDATE users SET google_subject=$1 WHERE email=$2 AND google_subject IS NULL RETURNING id", ['fixture-verified-subject', 'aryapat1234@gmail.com']);
      assert.equal(result.rows.length,1);
      const second = await db.query("UPDATE users SET google_subject=$1 WHERE email=$2 AND google_subject IS NULL RETURNING id", ['fixture-verified-subject','aryapat1234@gmail.com']);
      assert.equal(second.rows.length,0);
      await assert.rejects(db.query("UPDATE users SET google_subject='replacement' WHERE email='aryapat1234@gmail.com'"), /cannot be replaced/);
      await assert.rejects(db.query("UPDATE users SET google_subject=NULL WHERE email='aryapat1234@gmail.com'"), /cannot be replaced/);
    });
    await t.test('duplicate Google subjects are rejected by the database', async () => {
      await assert.rejects(db.query("INSERT INTO users(email,google_subject) VALUES ($1,$2)",['other@example.com','fixture-verified-subject']), /idx_users_google_subject/);
    });
    await t.test('bootstrap duplicate accounts and email case variants are rejected', async () => {
      await assert.rejects(db.query("INSERT INTO users(email) VALUES ('ARYAPAT1234@GMAIL.COM')"), /idx_users_normalized_email/);
    });
    await t.test('multiple unbound authorized users remain valid', async () => {
      await db.query("INSERT INTO users(email) VALUES ('pending1@example.com'),('pending2@example.com')");
    });
    await t.test('bootstrap cannot be deactivated, deleted or renamed', async () => {
      await assert.rejects(db.query("UPDATE users SET active=false WHERE email='aryapat1234@gmail.com'"), /cannot be deactivated/);
      await assert.rejects(db.query("DELETE FROM users WHERE email='aryapat1234@gmail.com'"), /cannot be deleted/);
      await assert.rejects(db.query("UPDATE users SET email='renamed@example.com' WHERE email='aryapat1234@gmail.com'"), /cannot be changed/);
    });
    await t.test('bootstrap ordinary grants cannot be demoted or revoked', async () => {
      await assert.rejects(db.query("UPDATE role_assignments SET role='admin'"), /cannot be changed/);
      await assert.rejects(db.query("UPDATE role_assignments SET revoked_at=now()"), /cannot be changed/);
      await assert.rejects(db.query("DELETE FROM role_assignments"), /cannot be changed/);
      await assert.rejects(db.query("INSERT INTO role_assignments(user_id,role) SELECT id,'trainer' FROM users WHERE email='aryapat1234@gmail.com'"), /does not use ordinary/);
    });
    await t.test('normal account role assignments remain editable', async () => {
      const id=randomUUID();
      await db.query('INSERT INTO users(id,email) VALUES ($1,$2)',[id,'normal@example.com']);
      await db.query("INSERT INTO role_assignments(user_id,role) VALUES ($1,'admin')",[id]);
      await db.query('UPDATE role_assignments SET revoked_at=now() WHERE user_id=$1',[id]);
    });
  } finally { await db.close(); }
});
