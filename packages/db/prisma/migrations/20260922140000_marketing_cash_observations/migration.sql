CREATE TABLE marketing_cash_observations (
 id TEXT PRIMARY KEY,
 "sourceId" TEXT NOT NULL,
 environment TEXT NOT NULL CHECK (environment IN ('test','live')),
 kind TEXT NOT NULL CHECK (kind IN ('inventory','comparison')),
 "parentId" TEXT REFERENCES marketing_cash_observations(id),
 digest TEXT NOT NULL UNIQUE CHECK (digest ~ '^[0-9a-f]{64}$'),
 body TEXT NOT NULL CHECK (octet_length(body) <= 4194304),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX marketing_cash_observations_source_idx ON marketing_cash_observations ("sourceId", "createdAt");
CREATE FUNCTION preserve_marketing_cash_observation() RETURNS TRIGGER AS $$
BEGIN
 RAISE EXCEPTION 'Cash observations are immutable' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER marketing_cash_observation_immutable BEFORE UPDATE OR DELETE ON marketing_cash_observations
FOR EACH ROW EXECUTE FUNCTION preserve_marketing_cash_observation();
