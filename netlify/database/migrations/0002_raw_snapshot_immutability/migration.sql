-- Raw snapshots are evidence records. They may be appended but never changed
-- or deleted by application code once recorded.
CREATE OR REPLACE FUNCTION prevent_raw_snapshot_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'raw_snapshots are append-only evidence records';
END;
$$;

DROP TRIGGER IF EXISTS raw_snapshots_prevent_mutation ON raw_snapshots;

CREATE TRIGGER raw_snapshots_prevent_mutation
BEFORE UPDATE OR DELETE ON raw_snapshots
FOR EACH ROW
EXECUTE FUNCTION prevent_raw_snapshot_mutation();
