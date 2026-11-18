-- Existing forks already have per-login registrations. Keep their keys and shared tokens.
-- Hold previous-release writes until the replacement mirror and backfill are installed.
LOCK TABLE "push_tokens" IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE IF NOT EXISTS "push_registrations" (
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "sessionId" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "tokenDigest" TEXT NOT NULL,
  "presentation" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("userId", "sessionId")
);
ALTER TABLE "push_registrations" ADD COLUMN IF NOT EXISTS "presentation" TEXT;
CREATE INDEX IF NOT EXISTS "push_registrations_tokenDigest_idx"
  ON "push_registrations"("tokenDigest");
INSERT INTO "push_registrations" ("userId", "sessionId", "ciphertext", "tokenDigest", "presentation", "updatedAt")
  SELECT "userId", "sessionId", "ciphertext", "tokenDigest", "presentation", "updatedAt" FROM "push_tokens" WHERE true
  ON CONFLICT ("userId", "sessionId") DO UPDATE
    SET "ciphertext" = EXCLUDED."ciphertext", "tokenDigest" = EXCLUDED."tokenDigest",
      "presentation" = EXCLUDED."presentation", "updatedAt" = EXCLUDED."updatedAt"
    WHERE EXCLUDED."updatedAt" > "push_registrations"."updatedAt"
      OR (EXCLUDED."updatedAt" = "push_registrations"."updatedAt"
        AND "push_registrations"."presentation" IS NULL AND EXCLUDED."presentation" IS NOT NULL);
ALTER TABLE "push_registrations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS push_registrations_system ON "push_registrations";
CREATE POLICY push_registrations_system ON "push_registrations"
  USING ((SELECT app_rls_bypass()));

DROP TRIGGER IF EXISTS push_tokens_sync_rotation ON "push_tokens";
DROP TRIGGER IF EXISTS push_tokens_sync_unregister ON "push_tokens";
DROP FUNCTION IF EXISTS sync_legacy_push_registration();
-- Supersedes the deployed fork's mirror without changing its immutable migrations.
CREATE FUNCTION push_tokens_mirror() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Deferred until commit: an old API's token handover must not revoke a saved account.
    IF NOT EXISTS (SELECT 1 FROM "push_tokens" WHERE "tokenDigest" = OLD."tokenDigest") THEN
      DELETE FROM "push_registrations" WHERE "userId" = OLD."userId"
        AND "sessionId" = OLD."sessionId" AND "tokenDigest" = OLD."tokenDigest";
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."tokenDigest" = NEW."tokenDigest"
      AND OLD."ciphertext" = NEW."ciphertext" THEN
    -- Retarget only the old login. An already-registered replacement login wins.
    UPDATE "push_registrations" r SET "sessionId" = NEW."sessionId",
      "presentation" = NEW."presentation", "updatedAt" = NEW."updatedAt"
      WHERE r."userId" = OLD."userId" AND r."sessionId" = OLD."sessionId"
        AND r."tokenDigest" = OLD."tokenDigest"
        AND (OLD."sessionId" = NEW."sessionId" OR NOT EXISTS (
          SELECT 1 FROM "push_registrations" n
            WHERE n."userId" = NEW."userId" AND n."sessionId" = NEW."sessionId"));
    IF OLD."sessionId" <> NEW."sessionId" THEN
      DELETE FROM "push_registrations" WHERE "userId" = OLD."userId"
        AND "sessionId" = OLD."sessionId" AND "tokenDigest" = OLD."tokenDigest";
    END IF;
    RETURN NEW;
  END IF;
  INSERT INTO "push_registrations" ("userId", "sessionId", "ciphertext", "tokenDigest", "presentation", "updatedAt")
    VALUES (NEW."userId", NEW."sessionId", NEW."ciphertext", NEW."tokenDigest", NEW."presentation", NEW."updatedAt")
    ON CONFLICT ("userId", "sessionId") DO UPDATE
      SET "ciphertext" = EXCLUDED."ciphertext", "tokenDigest" = EXCLUDED."tokenDigest",
        "presentation" = EXCLUDED."presentation", "updatedAt" = EXCLUDED."updatedAt";
  RETURN NEW;
END $$;
CREATE TRIGGER push_tokens_mirror AFTER INSERT OR UPDATE ON "push_tokens"
  FOR EACH ROW EXECUTE FUNCTION push_tokens_mirror();
CREATE CONSTRAINT TRIGGER push_tokens_mirror_unregister AFTER DELETE ON "push_tokens"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION push_tokens_mirror();
