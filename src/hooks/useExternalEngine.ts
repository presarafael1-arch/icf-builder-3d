/**
 * Hook for managing external ICF engine state and API calls
 */

import { useState, useCallback } from 'react';
import {
  EngineMode,
  ExternalEngineAnalysis,
  EngineConfig,
  DEFAULT_ENGINE_CONFIG,
} from '@/types/external-engine';

interface UseExternalEngineResult {
  engineMode: EngineMode;
  setEngineMode: (mode: EngineMode) => void;
  analysis: ExternalEngineAnalysis | null;
  isLoading: boolean;
  error: string | null;
  selectedWallId: string | null;
  setSelectedWallId: (id: string | null) => void;
  uploadAndAnalyze: (file: File, config?: Partial<EngineConfig>) => Promise<ExternalEngineAnalysis | null>;
  clearAnalysis: () => void;
  config: EngineConfig;
  setConfig: (config: Partial<EngineConfig>) => void;
}

// Persistence key for localStorage
const ENGINE_MODE_KEY = 'omni-icf-engine-mode';

export function useExternalEngine(): UseExternalEngineResult {
  // Load initial mode from localStorage
  const [engineMode, setEngineModeState] = useState<EngineMode>(() => {
    if (typeof window === 'undefined') return 'external';
    const saved = localStorage.getItem(ENGINE_MODE_KEY);
    return (saved === 'internal' || saved === 'external') ? saved : 'external';
  });

  const [analysis, setAnalysis] = useState<ExternalEngineAnalysis | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedWallId, setSelectedWallId] = useState<string | null>(null);
  const [config, setConfigState] = useState<EngineConfig>(DEFAULT_ENGINE_CONFIG);

  // Persist engine mode
  const setEngineMode = useCallback((mode: EngineMode) => {
    setEngineModeState(mode);
    localStorage.setItem(ENGINE_MODE_KEY, mode);
  }, []);

  // Update config partially
  const setConfig = useCallback((partial: Partial<EngineConfig>) => {
    setConfigState(prev => ({ ...prev, ...partial }));
  }, []);

  // Upload DXF and get analysis from external engine
  const uploadAndAnalyze = useCallback(async (
    file: File,
    configOverride?: Partial<EngineConfig>
  ): Promise<ExternalEngineAnalysis | null> => {
    const finalConfig = { ...config, ...configOverride };
    
    setIsLoading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const params = new URLSearchParams({
        units: finalConfig.units,
        thickness: finalConfig.thickness.toString(),
        wall_height: finalConfig.wallHeight.toString(),
        course_height: finalConfig.courseHeight.toString(),
        offset_even: finalConfig.offsetEven.toString(),
        offset_odd: finalConfig.offsetOdd.toString(),
      });

      const url = `${finalConfig.baseUrl}/project/layout?${params.toString()}`;
      
      console.log('[ExternalEngine] Uploading to:', url);
      
      const response = await fetch(url, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Engine error (${response.status}): ${errorText}`);
      }

      const result: ExternalEngineAnalysis = await response.json();
      
      console.log('[ExternalEngine] Analysis received:', {
        nodesCount: result.graph.nodes.length,
        wallsCount: result.graph.walls.length,
        coursesCount: result.courses.count,
        thickness: result.graph.thickness,
      });

      setAnalysis(result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[ExternalEngine] Error:', message);
      setError(message);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [config]);

  // Clear analysis data
  const clearAnalysis = useCallback(() => {
    setAnalysis(null);
    setSelectedWallId(null);
    setError(null);
  }, []);

  return {
    engineMode,
    setEngineMode,
    analysis,
    isLoading,
    error,
    selectedWallId,
    setSelectedWallId,
    uploadAndAnalyze,
    clearAnalysis,
    config,
    setConfig,
  };
}
