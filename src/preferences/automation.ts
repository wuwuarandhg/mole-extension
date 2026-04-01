export const AUTOMATION_PREFERENCES_KEY = 'mole_automation_preferences_v1';
export const WORKFLOW_AUTOMATION_MEMORY_KEY = 'mole_workflow_automation_memory_v1';

export interface AutomationPreferences {
  autoCompleteWorkflowOnClick: boolean;
}

export interface WorkflowAutomationStats {
  successCount: number;
  lastSuccessAt: number;
  lastParams?: Record<string, unknown>;
  workflowLabel?: string;
}

export interface WorkflowAutomationMemory {
  version: 1;
  updatedAt: number;
  lastWorkflowByHost: Record<string, string>;
  workflowStats: Record<string, WorkflowAutomationStats>;
}

export const DEFAULT_AUTOMATION_PREFERENCES: AutomationPreferences = {
  autoCompleteWorkflowOnClick: false,
};

const hasChromeStorage = (): boolean =>
  typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);

const storageGet = async <T>(key: string): Promise<T | null> => {
  if (!hasChromeStorage()) return null;
  const result = await new Promise<Record<string, unknown>>(resolve => {
    chrome.storage.local.get(key, resolve);
  });
  return (result[key] as T) ?? null;
};

const storageSet = async (key: string, value: unknown): Promise<void> => {
  if (!hasChromeStorage()) return;
  await new Promise<void>(resolve => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
};

export const getAutomationPreferences = async (): Promise<AutomationPreferences> => {
  const raw = await storageGet<Partial<AutomationPreferences>>(AUTOMATION_PREFERENCES_KEY);
  return {
    ...DEFAULT_AUTOMATION_PREFERENCES,
    ...(raw && typeof raw === 'object' ? raw : {}),
  };
};

export const saveAutomationPreferences = async (
  patch: Partial<AutomationPreferences>,
): Promise<AutomationPreferences> => {
  const current = await getAutomationPreferences();
  const next: AutomationPreferences = {
    ...current,
    ...patch,
  };
  await storageSet(AUTOMATION_PREFERENCES_KEY, next);
  return next;
};

export const getWorkflowAutomationMemory = async (): Promise<WorkflowAutomationMemory> => {
  const raw = await storageGet<Partial<WorkflowAutomationMemory>>(WORKFLOW_AUTOMATION_MEMORY_KEY);
  return {
    version: 1,
    updatedAt: Number(raw?.updatedAt) || 0,
    lastWorkflowByHost: raw?.lastWorkflowByHost && typeof raw.lastWorkflowByHost === 'object'
      ? raw.lastWorkflowByHost as Record<string, string>
      : {},
    workflowStats: raw?.workflowStats && typeof raw.workflowStats === 'object'
      ? raw.workflowStats as Record<string, WorkflowAutomationStats>
      : {},
  };
};

export const recordWorkflowAutomationSuccess = async (
  host: string,
  workflowKey: string,
  workflowLabel: string,
  params?: Record<string, unknown>,
): Promise<WorkflowAutomationMemory> => {
  const memory = await getWorkflowAutomationMemory();
  const previous = memory.workflowStats[workflowKey];
  const next: WorkflowAutomationMemory = {
    ...memory,
    updatedAt: Date.now(),
    lastWorkflowByHost: {
      ...memory.lastWorkflowByHost,
      ...(host ? { [host]: workflowKey } : {}),
    },
    workflowStats: {
      ...memory.workflowStats,
      [workflowKey]: {
        successCount: Math.max(0, Number(previous?.successCount) || 0) + 1,
        lastSuccessAt: Date.now(),
        lastParams: params && Object.keys(params).length > 0 ? params : previous?.lastParams,
        workflowLabel: workflowLabel || previous?.workflowLabel,
      },
    },
  };
  await storageSet(WORKFLOW_AUTOMATION_MEMORY_KEY, next);
  return next;
};
