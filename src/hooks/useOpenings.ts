// Hook for managing openings in a project with localStorage fallback
import { useState, useCallback, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { OpeningData, generateOpeningLabel } from '@/types/openings';
import { useToast } from '@/hooks/use-toast';

const STORAGE_KEY_PREFIX = 'omni-icf-openings-';

function getStorageKey(projectId: string): string {
  return `${STORAGE_KEY_PREFIX}${projectId}`;
}

function loadFromStorage(projectId: string): OpeningData[] {
  try {
    const stored = localStorage.getItem(getStorageKey(projectId));
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.warn('Failed to load openings from localStorage:', e);
  }
  return [];
}

function saveToStorage(projectId: string, openings: OpeningData[]): void {
  try {
    localStorage.setItem(getStorageKey(projectId), JSON.stringify(openings));
  } catch (e) {
    console.warn('Failed to save openings to localStorage:', e);
  }
}

export function useOpenings(projectId: string | undefined) {
  const [openings, setOpenings] = useState<OpeningData[]>([]);
  const [loading, setLoading] = useState(false);
  const [useLocalStorage, setUseLocalStorage] = useState(false);
  const { toast } = useToast();

  // Load openings - try Supabase first, fallback to localStorage
  const fetchOpenings = useCallback(async () => {
    if (!projectId) return;
    
    setLoading(true);
    
    // First, try to load from localStorage as initial state
    const localOpenings = loadFromStorage(projectId);
    if (localOpenings.length > 0) {
      setOpenings(localOpenings);
    }
    
    try {
      // Try to fetch from Supabase using wall_id (which represents chainId for now)
      // Note: The openings table links to walls, not directly to projects
      // For MVP, we use localStorage primarily
      
      // Check if we can connect to Supabase
      const { data: wallsData, error: wallsError } = await supabase
        .from('walls')
        .select('id')
        .eq('project_id', projectId)
        .limit(1);
      
      if (wallsError) {
        console.log('Using localStorage for openings (Supabase unavailable)');
        setUseLocalStorage(true);
        setLoading(false);
        return;
      }
      
      // If we have walls, we can try to load openings associated with them
      if (wallsData && wallsData.length > 0) {
        // For now, localStorage is primary source - Supabase schema needs adjustment
        setUseLocalStorage(true);
      } else {
        setUseLocalStorage(true);
      }
      
    } catch (error) {
      console.log('Using localStorage for openings (error):', error);
      setUseLocalStorage(true);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchOpenings();
  }, [fetchOpenings]);

  // Save to storage whenever openings change (including empty array to persist deletions)
  useEffect(() => {
    if (projectId) {
      saveToStorage(projectId, openings);
    }
  }, [projectId, openings]);

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
    const newId = `opening-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const newOpening: OpeningData = {
      id: newId,
      projectId,
      chainId,
      kind,
      label,
      widthMm,
      heightMm,
      sillMm,
      offsetMm,
    };
    
    setOpenings(prev => {
      const updated = [...prev, newOpening];
      saveToStorage(projectId, updated);
      return updated;
    });
    
    toast({
      title: 'Abertura adicionada',
      description: `${kind === 'door' ? 'Porta' : 'Janela'} ${label} (${widthMm}×${heightMm}mm)`,
    });
    
    return newOpening;
  }, [projectId, openings, toast]);

  // Update an opening
  const updateOpening = useCallback(async (
    id: string,
    updates: Partial<Pick<OpeningData, 'widthMm' | 'heightMm' | 'sillMm' | 'offsetMm' | 'label'>>
  ): Promise<boolean> => {
    if (!projectId) return false;
    
    setOpenings(prev => {
      const updated = prev.map(o => o.id === id ? { ...o, ...updates } : o);
      saveToStorage(projectId, updated);
      return updated;
    });
    
    return true;
  }, [projectId]);

  // Delete an opening
  const deleteOpening = useCallback(async (id: string): Promise<boolean> => {
    if (!projectId) return false;
    
    setOpenings(prev => {
      const updated = prev.filter(o => o.id !== id);
      saveToStorage(projectId, updated);
      return updated;
    });
    
    toast({
      title: 'Abertura eliminada',
    });
    
    return true;
  }, [projectId, toast]);

  // Clear all openings for project
  const clearOpenings = useCallback(async (): Promise<boolean> => {
    if (!projectId) return true;
    
    setOpenings([]);
    localStorage.removeItem(getStorageKey(projectId));
    
    toast({
      title: 'Aberturas limpas',
    });
    
    return true;
  }, [projectId, toast]);

  return {
    openings,
    loading,
    useLocalStorage,
    addOpening,
    updateOpening,
    deleteOpening,
    clearOpenings,
    fetchOpenings,
    setOpenings,
  };
}
