// Hook for managing openings in a project
import { useState, useCallback, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { OpeningData, generateOpeningLabel } from '@/types/openings';
import { useToast } from '@/hooks/use-toast';

export function useOpenings(projectId: string | undefined) {
  const [openings, setOpenings] = useState<OpeningData[]>([]);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  // Fetch openings from database
  const fetchOpenings = useCallback(async () => {
    if (!projectId) return;
    
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('openings')
        .select('*')
        .eq('wall_id', projectId); // Note: we'll need to adjust schema or use project_id
      
      if (error) throw error;
      
      // Map database format to our format
      const mappedOpenings: OpeningData[] = (data || []).map((o: any) => ({
        id: o.id,
        projectId: projectId,
        chainId: o.wall_id, // Using wall_id as chain_id for now
        kind: o.opening_type as 'door' | 'window',
        label: `${o.opening_type === 'door' ? 'P' : 'J'}${o.id.slice(0, 2)}`,
        widthMm: o.width_mm,
        heightMm: o.height_mm,
        sillMm: o.sill_height_mm || 0,
        offsetMm: o.position_mm,
      }));
      
      setOpenings(mappedOpenings);
    } catch (error) {
      console.error('Error fetching openings:', error);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchOpenings();
  }, [fetchOpenings]);

  // Add a new opening
  const addOpening = useCallback(async (
    chainId: string,
    kind: 'door' | 'window',
    widthMm: number,
    heightMm: number,
    sillMm: number,
    offsetMm: number,
    customLabel?: string
  ): Promise<OpeningData | null> => {
    if (!projectId) return null;

    const label = customLabel || generateOpeningLabel(kind, openings);
    
    try {
      const { data, error } = await supabase
        .from('openings')
        .insert({
          wall_id: chainId, // Using wall_id as chain reference
          opening_type: kind,
          width_mm: widthMm,
          height_mm: heightMm,
          sill_height_mm: sillMm,
          position_mm: offsetMm,
        })
        .select()
        .single();
      
      if (error) throw error;
      
      const newOpening: OpeningData = {
        id: data.id,
        projectId,
        chainId: data.wall_id,
        kind: data.opening_type as 'door' | 'window',
        label,
        widthMm: data.width_mm,
        heightMm: data.height_mm,
        sillMm: data.sill_height_mm || 0,
        offsetMm: data.position_mm,
      };
      
      setOpenings(prev => [...prev, newOpening]);
      
      toast({
        title: 'Abertura adicionada',
        description: `${kind === 'door' ? 'Porta' : 'Janela'} ${label} (${widthMm}×${heightMm}mm)`,
      });
      
      return newOpening;
    } catch (error) {
      console.error('Error adding opening:', error);
      toast({
        title: 'Erro',
        description: 'Não foi possível adicionar a abertura.',
        variant: 'destructive',
      });
      return null;
    }
  }, [projectId, openings, toast]);

  // Update an opening
  const updateOpening = useCallback(async (
    id: string,
    updates: Partial<Pick<OpeningData, 'widthMm' | 'heightMm' | 'sillMm' | 'offsetMm' | 'label'>>
  ): Promise<boolean> => {
    try {
      const dbUpdates: any = {};
      if (updates.widthMm !== undefined) dbUpdates.width_mm = updates.widthMm;
      if (updates.heightMm !== undefined) dbUpdates.height_mm = updates.heightMm;
      if (updates.sillMm !== undefined) dbUpdates.sill_height_mm = updates.sillMm;
      if (updates.offsetMm !== undefined) dbUpdates.position_mm = updates.offsetMm;

      const { error } = await supabase
        .from('openings')
        .update(dbUpdates)
        .eq('id', id);
      
      if (error) throw error;
      
      setOpenings(prev => prev.map(o => 
        o.id === id ? { ...o, ...updates } : o
      ));
      
      return true;
    } catch (error) {
      console.error('Error updating opening:', error);
      toast({
        title: 'Erro',
        description: 'Não foi possível atualizar a abertura.',
        variant: 'destructive',
      });
      return false;
    }
  }, [toast]);

  // Delete an opening
  const deleteOpening = useCallback(async (id: string): Promise<boolean> => {
    try {
      const { error } = await supabase
        .from('openings')
        .delete()
        .eq('id', id);
      
      if (error) throw error;
      
      setOpenings(prev => prev.filter(o => o.id !== id));
      
      toast({
        title: 'Abertura eliminada',
      });
      
      return true;
    } catch (error) {
      console.error('Error deleting opening:', error);
      toast({
        title: 'Erro',
        description: 'Não foi possível eliminar a abertura.',
        variant: 'destructive',
      });
      return false;
    }
  }, [toast]);

  // Clear all openings for project
  const clearOpenings = useCallback(async (): Promise<boolean> => {
    if (!projectId || openings.length === 0) return true;
    
    try {
      // Delete all openings that belong to walls in this project
      for (const opening of openings) {
        await supabase.from('openings').delete().eq('id', opening.id);
      }
      
      setOpenings([]);
      
      toast({
        title: 'Aberturas limpas',
      });
      
      return true;
    } catch (error) {
      console.error('Error clearing openings:', error);
      return false;
    }
  }, [projectId, openings, toast]);

  return {
    openings,
    loading,
    addOpening,
    updateOpening,
    deleteOpening,
    clearOpenings,
    fetchOpenings,
    setOpenings, // For local state management without DB
  };
}
