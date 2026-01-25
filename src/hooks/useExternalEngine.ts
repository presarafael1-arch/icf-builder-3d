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
  testConnection: () => Promise<boolean>;
  connectionStatus: 'idle' | 'testing' | 'connected' | 'error';
}

// Persistence keys for localStorage
const ENGINE_MODE_KEY = 'omni-icf-engine-mode';
const ENGINE_CONFIG_KEY = 'omni-icf-engine-config';

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
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedWallId, setSelectedWallId] = useState<string | null>(null);
  const [config, setConfigState] = useState<EngineConfig>(loadPersistedConfig);
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'testing' | 'connected' | 'error'>('idle');

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
    testConnection,
    connectionStatus,
  };
}
