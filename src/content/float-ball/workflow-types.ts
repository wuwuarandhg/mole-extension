export type WorkflowEngine = 'skill' | 'site_workflow';
export type WorkflowScope = 'global' | 'domain';
export type WorkflowSource = 'builtin' | 'remote' | 'user';
export type WorkflowParamValue = string | number | boolean;

export interface AvailableWorkflowItem {
  engine: WorkflowEngine;
  workflowId?: string;
  name: string;
  label: string;
  description: string;
  skillName?: string;
  skillLabel?: string;
  scope?: WorkflowScope;
  source?: WorkflowSource;
  parameters: Record<string, unknown>;
  requiredParams: string[];
  hasRequiredParams: boolean;
  isHighRisk?: boolean;
  riskReason?: string;
}

export interface WorkflowRunMeta {
  engine: WorkflowEngine;
  workflowKey: string;
  workflowId?: string;
  workflowName: string;
  workflowLabel: string;
  scope?: WorkflowScope;
  source?: WorkflowSource;
  mode: 'manual' | 'auto';
  params: Record<string, WorkflowParamValue>;
  autoFilledKeys?: string[];
  fallbackReason?: string;
}
