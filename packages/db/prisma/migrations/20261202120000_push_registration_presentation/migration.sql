ALTER TABLE "push_registrations" ADD COLUMN "presentation" TEXT;

-- Preserve presentation changes made by an overlapping single-account API.
CREATE OR REPLACE FUNCTION sync_legacy_push_registration() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    UPDATE "push_registrations"
      SET "ciphertext" = NEW."ciphertext", "tokenDigest" = NEW."tokenDigest",
          "updatedAt" = NEW."updatedAt", "presentation" = NEW."presentation"
      WHERE "userId" = OLD."userId" AND "sessionId" = OLD."sessionId"
        AND "tokenDigest" = OLD."tokenDigest";
  ELSE
    -- Old registration transfers delete one owner before inserting the next.
    -- Check at commit so that transfer does not revoke another saved account.
    IF NOT EXISTS (SELECT 1 FROM "push_tokens" WHERE "tokenDigest" = OLD."tokenDigest") THEN
      DELETE FROM "push_registrations"
        WHERE "userId" = OLD."userId" AND "sessionId" = OLD."sessionId"
          AND "tokenDigest" = OLD."tokenDigest";
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
