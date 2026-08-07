-- Speed up paginated lead lists / pipeline
CREATE INDEX IF NOT EXISTS leads_updated_at_idx ON leads (updated_at DESC);
CREATE INDEX IF NOT EXISTS leads_assigned_stage_updated_idx
  ON leads (assigned_to, stage, updated_at DESC);
