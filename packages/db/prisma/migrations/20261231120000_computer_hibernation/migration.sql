ALTER TABLE "spaces" ADD COLUMN "computerIdlePolicy" TEXT NOT NULL DEFAULT 'keep-vm';
CREATE TABLE "computer_disk_snapshots" (
  "marker" TEXT NOT NULL PRIMARY KEY,
  "computerId" TEXT NOT NULL REFERENCES "computers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "sourceId" TEXT NOT NULL,
  "snapshotId" TEXT,
  "snapshotSeen" BOOLEAN NOT NULL DEFAULT false,
  "phase" TEXT NOT NULL,
  "restorePending" BOOLEAN NOT NULL DEFAULT false,
  "restoreId" TEXT
);
CREATE INDEX "computer_disk_snapshots_computerId_idx" ON "computer_disk_snapshots"("computerId");
ALTER TABLE "computer_disk_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "computer_disk_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY computer_disk_snapshots_system ON "computer_disk_snapshots"
  USING ((SELECT app_rls_bypass()));

-- An older worker cannot boot, reset, or delete a computer after it acquires a snapshot receipt.
ALTER TABLE "computers" ADD COLUMN "hibernationProtected" BOOLEAN NOT NULL DEFAULT false;
CREATE POLICY computers_hibernation_version ON "computers" AS RESTRICTIVE
  USING (NOT "hibernationProtected" OR current_setting('app.computer_hibernation_version', true) = '1');
CREATE FUNCTION app_guard_computer_hibernation_version() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (OLD."hibernationProtected" OR (TG_OP = 'UPDATE' AND NEW."hibernationProtected"))
    AND current_setting('app.computer_hibernation_version', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'Computer hibernation requires an updated server' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER computers_hibernation_write_version
  BEFORE UPDATE OR DELETE ON "computers"
  FOR EACH ROW EXECUTE FUNCTION app_guard_computer_hibernation_version();

ALTER TABLE "computer_disk_snapshots" ADD CONSTRAINT "computer_disk_snapshots_phase_check"
  CHECK ("phase" IN ('capturing', 'releasing', 'released', 'retired'));
CREATE UNIQUE INDEX "computer_disk_snapshots_one_active"
  ON "computer_disk_snapshots"("computerId") WHERE "phase" <> 'retired';
