-- Migration: Create ai_analysis_logs table
-- Purpose: Store AI context and recommendations for vehicles

CREATE TABLE IF NOT EXISTS ai_analysis_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vehicle_plate TEXT NOT NULL,
    context JSONB NOT NULL DEFAULT '{}',
    recommendation TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE ai_analysis_logs ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Allow all read access to ai_analysis_logs" ON ai_analysis_logs FOR SELECT USING (true);
CREATE POLICY "Allow all insert access to ai_analysis_logs" ON ai_analysis_logs FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow all update access to ai_analysis_logs" ON ai_analysis_logs FOR UPDATE USING (true);

-- Add comments
COMMENT ON TABLE ai_analysis_logs IS 'Stores AI recommendations and context for vehicles';
