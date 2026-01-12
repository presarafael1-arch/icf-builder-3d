-- Create storage bucket for DXF uploads
INSERT INTO storage.buckets (id, name, public) 
VALUES ('uploads', 'uploads', false)
ON CONFLICT (id) DO NOTHING;

-- Create RLS policies for uploads bucket
CREATE POLICY "Allow public upload to uploads bucket"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'uploads');

CREATE POLICY "Allow public read from uploads bucket"
ON storage.objects FOR SELECT
USING (bucket_id = 'uploads');

CREATE POLICY "Allow public delete from uploads bucket"
ON storage.objects FOR DELETE
USING (bucket_id = 'uploads');

-- Create uploads tracking table
CREATE TABLE IF NOT EXISTS public.uploads (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  file_type TEXT NOT NULL DEFAULT 'dxf',
  selected_layers TEXT[],
  uploaded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.uploads ENABLE ROW LEVEL SECURITY;

-- Public access policies for MVP
CREATE POLICY "Allow public read access on uploads"
ON public.uploads FOR SELECT
USING (true);

CREATE POLICY "Allow public insert on uploads"
ON public.uploads FOR INSERT
WITH CHECK (true);

CREATE POLICY "Allow public delete on uploads"
ON public.uploads FOR DELETE
USING (true);