/**
 * Hook for managing external ICF engine state and API calls
 * 
 * External Engine is the "source of truth" - no fallback to internal rendering.
 */

import { useState, useCallback, useEffect } from 'react';
import {
  EngineMode,
  ExternalEngineAnalysis,
  NormalizedExternalAnalysis,
  EngineConfig,
  DEFAULT_ENGINE_CONFIG,
  normalizeExternalAnalysis,
} from '@/types/external-engine';

interface UseExternalEngineResult {
  engineMode: EngineMode;
  setEngineMode: (mode: EngineMode) => void;
  analysis: ExternalEngineAnalysis | null;
  normalizedAnalysis: NormalizedExternalAnalysis;
  isLoading: boolean;
  error: string | null;
  selectedWallId: string | null;
  setSelectedWallId: (id: string | null) => void;
  uploadAndAnalyze: (file: File, config?: Partial<EngineConfig>) => Promise<ExternalEngineAnalysis | null>;
  clearAnalysis: () => void;
  config: EngineConfig;
  setConfig: (config: Partial<EngineConfig>) => void;
  testConnection: () => Promise<boolean>;
  connectionStatus: 'idle' | 'testing' | 'connected' | 'error';
}

// Persistence keys for localStorage
const ENGINE_MODE_KEY = 'omni-icf-engine-mode';
const ENGINE_CONFIG_KEY = 'omni-icf-engine-config';

// Empty normalized analysis (safe defaults)
const EMPTY_NORMALIZED: NormalizedExternalAnalysis = {
  nodes: [],
  walls: [],
  courses: [],
  wallHeight: 0,
  courseHeight: 0,
  thickness: 0,
};

// Load config from localStorage or use defaults
function loadPersistedConfig(): EngineConfig {
  if (typeof window === 'undefined') return DEFAULT_ENGINE_CONFIG;
  try {
    const saved = localStorage.getItem(ENGINE_CONFIG_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return { ...DEFAULT_ENGINE_CONFIG, ...parsed };
    }
  } catch {
    // ignore parse errors
  }
  return DEFAULT_ENGINE_CONFIG;
}

export function useExternalEngine(): UseExternalEngineResult {
  // Load initial mode from localStorage (default: external ON)
  const [engineMode, setEngineModeState] = useState<EngineMode>(() => {
    if (typeof window === 'undefined') return 'external';
    const saved = localStorage.getItem(ENGINE_MODE_KEY);
    return (saved === 'internal' || saved === 'external') ? saved : 'external';
  });

  const [analysis, setAnalysis] = useState<ExternalEngineAnalysis | null>(null);
  const [normalizedAnalysis, setNormalizedAnalysis] = useState<NormalizedExternalAnalysis>(EMPTY_NORMALIZED);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedWallId, setSelectedWallId] = useState<string | null>(null);
  const [config, setConfigState] = useState<EngineConfig>(loadPersistedConfig);
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'testing' | 'connected' | 'error'>('idle');

  // Clear analysis when switching to external mode (no fallback to old data)
  useEffect(() => {
    if (engineMode === 'external') {
      // When switching to external mode, clear any stale analysis to force fresh import
      console.log('[ExternalEngine] Mode changed to external, ensuring clean state');
    }
  }, [engineMode]);

  // Persist engine mode
  const setEngineMode = useCallback((mode: EngineMode) => {
    setEngineModeState(mode);
    localStorage.setItem(ENGINE_MODE_KEY, mode);
  }, []);

  // Update config partially and persist
  const setConfig = useCallback((partial: Partial<EngineConfig>) => {
    setConfigState(prev => {
      const updated = { ...prev, ...partial };
      localStorage.setItem(ENGINE_CONFIG_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  // Test connection to external engine
  const testConnection = useCallback(async (): Promise<boolean> => {
    setConnectionStatus('testing');
    setError(null);
    
    try {
      const baseUrl = config.baseUrl.replace(/\/+$/, '');
      const url = `${baseUrl}/health`;
      
      console.log('[ExternalEngine] Testing connection:', url);
      
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json();
      
      if (data.status === 'ok') {
        setConnectionStatus('connected');
        console.log('[ExternalEngine] Connection successful');
        return true;
      } else {
        throw new Error('Resposta inesperada do servidor');
      }
    } catch (err) {
      let message: string;
      if (err instanceof TypeError && err.message.includes('fetch')) {
        message = `Falha na ligação: verifique se o motor está acessível em ${config.baseUrl}`;
      } else if (err instanceof Error) {
        message = err.message;
      } else {
        message = 'Erro desconhecido';
      }
      console.error('[ExternalEngine] Connection test failed:', message);
      setError(message);
      setConnectionStatus('error');
      return false;
    }
  }, [config.baseUrl]);

  // Upload DXF and get analysis from external engine
  // Config values are in mm, API expects meters - we convert here
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

      // Convert mm to m for API (divide by 1000)
      const thicknessM = finalConfig.thickness / 1000;
      const wallHeightM = finalConfig.wallHeight / 1000;
      const courseHeightM = finalConfig.courseHeight / 1000;
      const offsetEvenM = finalConfig.offsetEven / 1000;
      const offsetOddM = finalConfig.offsetOdd / 1000;

      const params = new URLSearchParams({
        units: 'm',
        thickness: thicknessM.toString(),
        wall_height: wallHeightM.toString(),
        course_height: courseHeightM.toString(),
        offset_even: offsetEvenM.toString(),
        offset_odd: offsetOddM.toString(),
      });

      // Ensure baseUrl doesn't have trailing slash
      const baseUrl = finalConfig.baseUrl.replace(/\/+$/, '');
      const url = `${baseUrl}/project/layout?${params.toString()}`;
      
      console.log('[ExternalEngine] Uploading to:', url);
      console.log('[ExternalEngine] Params (m):', {
        thickness: thicknessM,
        wall_height: wallHeightM,
        course_height: courseHeightM,
        offset_even: offsetEvenM,
        offset_odd: offsetOddM,
      });
      
      const response = await fetch(url, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        let errorText = '';
        try {
          errorText = await response.text();
        } catch {
          errorText = 'Não foi possível ler a resposta do servidor';
        }
        throw new Error(`Erro do motor (${response.status}): ${errorText}`);
      }

      const rawData = await response.json();
      
      // Normalize the response using the wrapper structure: data.analysis.graph/courses
      const normalized = normalizeExternalAnalysis(rawData);
      
      console.log('[ExternalEngine] Analysis received (normalized):', {
        nodesCount: normalized.nodes.length,
        wallsCount: normalized.walls.length,
        coursesCount: normalized.courses.length,
        wallHeight: normalized.wallHeight,
        thickness: normalized.thickness,
      });

      // Store both raw and normalized
      const result: ExternalEngineAnalysis = rawData.analysis || rawData;
      setAnalysis(result);
      setNormalizedAnalysis(normalized);
      return result;
    } catch (err) {
      let message: string;
      if (err instanceof TypeError && err.message.includes('fetch')) {
        message = `Falha na ligação: verifique se o motor está a correr em ${config.baseUrl}`;
      } else if (err instanceof Error) {
        message = err.message;
      } else {
        message = 'Erro desconhecido';
      }
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
    setNormalizedAnalysis(EMPTY_NORMALIZED);
    setSelectedWallId(null);
    setError(null);
  }, []);

  return {
    engineMode,
    setEngineMode,
    analysis,
    normalizedAnalysis,
    isLoading,
    error,
    selectedWallId,
    setSelectedWallId,
    uploadAndAnalyze,
    clearAnalysis,
    config,
    setConfig,
    testConnection,
    connectionStatus,
  };
}
