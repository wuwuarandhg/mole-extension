import type { AvailableWorkflowItem, WorkflowParamValue } from './workflow-types';

export const getWorkflowKey = (workflow: Pick<AvailableWorkflowItem, 'engine' | 'workflowId' | 'name'>): string =>
  workflow.engine === 'skill'
    ? String(workflow.workflowId || workflow.name)
    : `legacy:${workflow.name}`;

export const buildWorkflowShortcutQuery = (
  workflow: Pick<AvailableWorkflowItem, 'engine' | 'workflowId' | 'name'>,
  params?: Record<string, WorkflowParamValue>,
): string => {
  const toolName = workflow.engine;
  const target = workflow.engine === 'skill'
    ? String(workflow.workflowId || workflow.name)
    : workflow.name;
  const normalizedParams = params && Object.keys(params).length > 0
    ? JSON.stringify(params)
    : '';
  return normalizedParams ? `${toolName}:${target}|${normalizedParams}` : `${toolName}:${target}`;
};

export const summarizeWorkflowParams = (
  workflow: Pick<AvailableWorkflowItem, 'label'>,
  params: Record<string, WorkflowParamValue>,
): string => {
  const parts = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .slice(0, 3)
    .map(([key, value]) => `${key}=${String(value)}`);
  if (parts.length === 0) return workflow.label;
  return `${workflow.label} · ${parts.join('，')}`;
};

export const normalizeWorkflowParams = (
  params?: Record<string, unknown>,
): Record<string, WorkflowParamValue> => {
  const normalized: Record<string, WorkflowParamValue> = {};
  if (!params || typeof params !== 'object') return normalized;
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      normalized[key] = value;
    }
  }
  return normalized;
};
