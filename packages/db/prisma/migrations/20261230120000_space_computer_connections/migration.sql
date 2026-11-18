CREATE TABLE "computer_connections" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "provider" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "spendingApprovedBy" TEXT,
  "spendingApprovedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "computer_connections_id_spaceId_key" ON "computer_connections"("id", "spaceId");
CREATE INDEX "computer_connections_spaceId_idx" ON "computer_connections"("spaceId");
ALTER TABLE "spaces" ADD COLUMN "computerConnectionId" TEXT;
ALTER TABLE "computers" ADD COLUMN "providerConnectionId" TEXT;
-- Existing computers retain their prior routing until explicitly reset.
ALTER TABLE "computers" ADD COLUMN "providerConnectionPinned" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_computerConnectionId_fkey" FOREIGN KEY ("computerConnectionId") REFERENCES "computer_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_computer_connection_tenant_fkey" FOREIGN KEY ("computerConnectionId", "id") REFERENCES "computer_connections"("id", "spaceId");
ALTER TABLE "computers" ADD CONSTRAINT "computers_providerConnectionId_fkey" FOREIGN KEY ("providerConnectionId") REFERENCES "computer_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "computers" ADD CONSTRAINT "computers_provider_connection_tenant_fkey" FOREIGN KEY ("providerConnectionId", "spaceId") REFERENCES "computer_connections"("id", "spaceId");
ALTER TABLE "computer_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "computer_connections" FORCE ROW LEVEL SECURITY;
CREATE POLICY computer_connections_system ON "computer_connections" USING ((SELECT app_rls_bypass()));
CREATE POLICY computer_connections_tenant ON "computer_connections"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));

-- Older workers cannot route these computers. Fence their reads and claims, including system
-- contexts, before they can replace a cloud reference with their deployment default.
CREATE POLICY computers_connection_version ON "computers" AS RESTRICTIVE
  USING ("providerConnectionId" IS NULL
    OR current_setting('app.computer_connection_version', true) = '1');

-- Some self-hosted deployments use a privileged database login. Its writes bypass RLS,
-- so also reject an unsupported worker's boot claim or activation at the table boundary.
CREATE FUNCTION app_guard_computer_connection_version() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    IF (OLD."providerConnectionId" IS NOT NULL
        OR (TG_OP = 'UPDATE' AND NEW."providerConnectionId" IS NOT NULL))
      AND current_setting('app.computer_connection_version', true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'Computer connections require an updated server'
        USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END;
  $$;
CREATE TRIGGER computers_connection_write_version
  BEFORE UPDATE OR DELETE ON "computers"
  FOR EACH ROW EXECUTE FUNCTION app_guard_computer_connection_version();

-- Referential cascades bypass RLS. An older Space/account deletion must retain the credentials
-- until updated deletion code has confirmed that machines and their cleanup jobs are gone.
CREATE FUNCTION app_require_computer_connection_version() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    IF current_setting('app.computer_connection_version', true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'Computer connections require an updated server'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END;
  $$;
CREATE TRIGGER computer_connections_delete_version
  BEFORE DELETE ON "computer_connections"
  FOR EACH ROW EXECUTE FUNCTION app_require_computer_connection_version();
