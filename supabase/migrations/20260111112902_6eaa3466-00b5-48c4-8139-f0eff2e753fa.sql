-- Create enum for corner modes
CREATE TYPE public.corner_mode AS ENUM ('overlap_cut', 'topo');

-- Create enum for concrete core thickness
CREATE TYPE public.concrete_thickness AS ENUM ('150', '200');

-- Create projects table
CREATE TABLE public.projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    concrete_thickness concrete_thickness NOT NULL DEFAULT '150',
    wall_height_mm INTEGER NOT NULL DEFAULT 2800,
    rebar_spacing_cm INTEGER NOT NULL DEFAULT 20,
    corner_mode corner_mode NOT NULL DEFAULT 'overlap_cut',
    dxf_file_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create walls table (segments from DXF/editor)
CREATE TABLE public.walls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE NOT NULL,
    start_x NUMERIC NOT NULL,
    start_y NUMERIC NOT NULL,
    end_x NUMERIC NOT NULL,
    end_y NUMERIC NOT NULL,
    layer_name TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create openings table (doors and windows)
CREATE TABLE public.openings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wall_id UUID REFERENCES public.walls(id) ON DELETE CASCADE NOT NULL,
    opening_type TEXT NOT NULL CHECK (opening_type IN ('door', 'window')),
    width_mm INTEGER NOT NULL,
    height_mm INTEGER NOT NULL,
    sill_height_mm INTEGER DEFAULT 0,
    position_mm INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create BOM results table (cached calculations)
CREATE TABLE public.bom_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE NOT NULL UNIQUE,
    panels_count INTEGER NOT NULL DEFAULT 0,
    tarugos_base INTEGER NOT NULL DEFAULT 0,
    tarugos_adjustments INTEGER NOT NULL DEFAULT 0,
    tarugos_total INTEGER NOT NULL DEFAULT 0,
    tarugos_injection INTEGER NOT NULL DEFAULT 0,
    topos_units INTEGER NOT NULL DEFAULT 0,
    topos_meters NUMERIC NOT NULL DEFAULT 0,
    webs_total INTEGER NOT NULL DEFAULT 0,
    webs_per_row INTEGER NOT NULL DEFAULT 0,
    cuts_count INTEGER NOT NULL DEFAULT 0,
    cuts_length_mm NUMERIC NOT NULL DEFAULT 0,
    calculated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.walls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.openings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bom_results ENABLE ROW LEVEL SECURITY;

-- Create policies (public access for MVP - no auth required initially)
CREATE POLICY "Allow public read access on projects" ON public.projects FOR SELECT USING (true);
CREATE POLICY "Allow public insert on projects" ON public.projects FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update on projects" ON public.projects FOR UPDATE USING (true);
CREATE POLICY "Allow public delete on projects" ON public.projects FOR DELETE USING (true);

CREATE POLICY "Allow public read access on walls" ON public.walls FOR SELECT USING (true);
CREATE POLICY "Allow public insert on walls" ON public.walls FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update on walls" ON public.walls FOR UPDATE USING (true);
CREATE POLICY "Allow public delete on walls" ON public.walls FOR DELETE USING (true);

CREATE POLICY "Allow public read access on openings" ON public.openings FOR SELECT USING (true);
CREATE POLICY "Allow public insert on openings" ON public.openings FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update on openings" ON public.openings FOR UPDATE USING (true);
CREATE POLICY "Allow public delete on openings" ON public.openings FOR DELETE USING (true);

CREATE POLICY "Allow public read access on bom_results" ON public.bom_results FOR SELECT USING (true);
CREATE POLICY "Allow public insert on bom_results" ON public.bom_results FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update on bom_results" ON public.bom_results FOR UPDATE USING (true);
CREATE POLICY "Allow public delete on bom_results" ON public.bom_results FOR DELETE USING (true);

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Create trigger for projects
CREATE TRIGGER update_projects_updated_at
    BEFORE UPDATE ON public.projects
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();