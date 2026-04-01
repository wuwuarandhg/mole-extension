import React, { useCallback, useEffect, useState } from 'react';
import Channel from '../../../lib/channel';
import { useMole } from '../context/useMole';
import { submitNewTask } from '../task-submit';
import type { AvailableWorkflowItem, WorkflowParamValue } from '../workflow-types';
import { buildWorkflowShortcutQuery, getWorkflowKey, normalizeWorkflowParams, summarizeWorkflowParams } from '../workflow-utils';
import {
  getAutomationPreferences,
  getWorkflowAutomationMemory,
  type WorkflowAutomationMemory,
  type WorkflowAutomationStats,
} from '../../../preferences/automation';

type WorkflowFormValue = WorkflowParamValue | '';

interface AutofillResult {
  values: Record<string, WorkflowFormValue>;
  autoFilledKeys: string[];
  missingRequired: string[];
}

interface PageInputCandidate {
  value: string;
  hint: string;
}

interface PageAutofillContext {
  href: string;
  host: string;
  title: string;
  selectedText: string;
  searchParams: URLSearchParams;
  inputs: PageInputCandidate[];
}

const normalizeWorkflow = (item: any): AvailableWorkflowItem | null => {
  const label = String(item?.label || item?.name || '').trim();
  const name = String(item?.name || '').trim();
  if (!label || !name) return null;
  return {
    engine: item?.engine === 'site_workflow' ? 'site_workflow' : 'skill',
    workflowId: typeof item?.workflowId === 'string' ? item.workflowId : undefined,
    name,
    label,
    description: String(item?.description || '').trim(),
    skillName: typeof item?.skillName === 'string' ? item.skillName : undefined,
    skillLabel: typeof item?.skillLabel === 'string' ? item.skillLabel : undefined,
    scope: item?.scope === 'global' ? 'global' : 'domain',
    source: item?.source === 'user' || item?.source === 'remote' ? item.source : 'builtin',
    parameters: item?.parameters && typeof item.parameters === 'object'
      ? item.parameters as Record<string, unknown>
      : { type: 'object', properties: {} },
    requiredParams: Array.isArray(item?.requiredParams)
      ? item.requiredParams.map((entry: unknown) => String(entry || '').trim()).filter(Boolean)
      : [],
    hasRequiredParams: item?.hasRequiredParams === true,
    isHighRisk: item?.isHighRisk === true,
    riskReason: typeof item?.riskReason === 'string' ? item.riskReason : undefined,
  };
};

const getProperties = (workflow: AvailableWorkflowItem): Record<string, Record<string, unknown>> => {
  const properties = workflow.parameters?.properties;
  if (!properties || typeof properties !== 'object') return {};
  return properties as Record<string, Record<string, unknown>>;
};

const getPrimitiveDefault = (schema: Record<string, unknown>): WorkflowParamValue | undefined => {
  const value = schema.default;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return undefined;
};

const collectPageAutofillContext = (): PageAutofillContext => {
  const selectedText = window.getSelection?.()?.toString().trim() || '';
  const inputs = Array.from(document.querySelectorAll<HTMLElement>('input, textarea, [contenteditable="true"]'))
    .map((element) => {
      if (element instanceof HTMLInputElement) {
        if (['hidden', 'password', 'checkbox', 'radio', 'button', 'submit'].includes(element.type)) return null;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const rawValue = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value
        : element.textContent;
      const value = String(rawValue || '').trim();
      if (!value) return null;
      const hint = [
        element.getAttribute('name'),
        element.getAttribute('id'),
        element.getAttribute('placeholder'),
        element.getAttribute('aria-label'),
      ].filter(Boolean).join(' ').toLowerCase();
      return { value, hint };
    })
    .filter((item): item is PageInputCandidate => Boolean(item))
    .slice(0, 8);

  return {
    href: window.location.href,
    host: window.location.hostname,
    title: document.title,
    selectedText,
    searchParams: new URL(window.location.href).searchParams,
    inputs,
  };
};

const getMemoryStats = (
  memory: WorkflowAutomationMemory | null,
  workflow: AvailableWorkflowItem,
): WorkflowAutomationStats | null => {
  if (!memory) return null;
  return memory.workflowStats[getWorkflowKey(workflow)] || null;
};

const resolveTypedValue = (
  rawValue: unknown,
  schema: Record<string, unknown>,
): WorkflowFormValue | undefined => {
  const type = String(schema.type || 'string').trim().toLowerCase();
  if (type === 'boolean') {
    if (typeof rawValue === 'boolean') return rawValue;
    if (typeof rawValue === 'string') {
      const normalized = rawValue.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
      if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
    }
    return undefined;
  }
  if (type === 'number' || type === 'integer') {
    const numeric = typeof rawValue === 'number' ? rawValue : Number(String(rawValue || '').trim());
    if (!Number.isFinite(numeric)) return undefined;
    return type === 'integer' ? Math.trunc(numeric) : numeric;
  }
  if (typeof rawValue === 'string') {
    const text = rawValue.trim();
    return text ? text : undefined;
  }
  return undefined;
};

const inferParamValue = (
  paramKey: string,
  schema: Record<string, unknown>,
  context: PageAutofillContext,
  lastParams: Record<string, unknown>,
  isSingleStringRequired: boolean,
): WorkflowFormValue | undefined => {
  const normalizedKey = paramKey.trim().toLowerCase();
  const memoryValue = resolveTypedValue(lastParams[paramKey], schema);
  const defaultValue = getPrimitiveDefault(schema);
  const exactUrlParam = resolveTypedValue(context.searchParams.get(paramKey), schema);

  if (exactUrlParam !== undefined) return exactUrlParam;

  if (/url|href|link/.test(normalizedKey)) return resolveTypedValue(context.href, schema) ?? memoryValue ?? defaultValue;
  if (/host|hostname|domain/.test(normalizedKey)) return resolveTypedValue(context.host, schema) ?? memoryValue ?? defaultValue;
  if (/title|subject/.test(normalizedKey)) return resolveTypedValue(context.title, schema) ?? memoryValue ?? defaultValue;

  if (/keyword|query|search|wd|term/.test(normalizedKey)) {
    const candidate = context.selectedText
      || context.searchParams.get('q')
      || context.searchParams.get('query')
      || context.searchParams.get('keyword')
      || context.searchParams.get('wd')
      || context.inputs.find(item => /search|keyword|query|关键词|搜索/.test(item.hint))?.value
      || context.inputs[0]?.value
      || '';
    return resolveTypedValue(candidate, schema) ?? memoryValue ?? defaultValue;
  }

  if (/text|content|message|prompt|desc|description|name/.test(normalizedKey)) {
    const candidate = context.selectedText || context.inputs[0]?.value || '';
    return resolveTypedValue(candidate, schema) ?? memoryValue ?? defaultValue;
  }

  if (isSingleStringRequired && String(schema.type || 'string') === 'string') {
    const candidate = context.selectedText || context.inputs[0]?.value || '';
    return resolveTypedValue(candidate, schema) ?? memoryValue ?? defaultValue;
  }

  return memoryValue ?? defaultValue;
};

const buildAutofillResult = (
  workflow: AvailableWorkflowItem,
  memory: WorkflowAutomationMemory | null,
): AutofillResult => {
  const properties = getProperties(workflow);
  const required = new Set(workflow.requiredParams);
  const stats = getMemoryStats(memory, workflow);
  const lastParams = stats?.lastParams && typeof stats.lastParams === 'object'
    ? stats.lastParams as Record<string, unknown>
    : {};
  const context = collectPageAutofillContext();
  const singleStringRequiredKeys = workflow.requiredParams.filter((key) => {
    const schema = properties[key];
    return schema && String(schema.type || 'string') === 'string';
  });

  const values: Record<string, WorkflowFormValue> = {};
  const autoFilledKeys: string[] = [];
  const missingRequired: string[] = [];

  for (const [key, schema] of Object.entries(properties)) {
    const value = inferParamValue(
      key,
      schema,
      context,
      lastParams,
      singleStringRequiredKeys.length === 1 && singleStringRequiredKeys[0] === key,
    );
    if (value !== undefined) {
      values[key] = value;
      autoFilledKeys.push(key);
      continue;
    }
    if (required.has(key)) {
      values[key] = '';
      missingRequired.push(key);
    }
  }

  return { values, autoFilledKeys, missingRequired };
};

const collectWorkflowParams = (
  workflow: AvailableWorkflowItem,
  formValues: Record<string, WorkflowFormValue>,
): { params: Record<string, WorkflowParamValue>; missingRequired: string[]; error?: string } => {
  const properties = getProperties(workflow);
  const required = new Set(workflow.requiredParams);
  const params: Record<string, WorkflowParamValue> = {};
  const missingRequired: string[] = [];

  for (const [key, schema] of Object.entries(properties)) {
    const value = formValues[key];
    if (String(schema.type || 'string') === 'boolean') {
      if (typeof value === 'boolean') params[key] = value;
      else if (required.has(key)) params[key] = false;
      continue;
    }

    if (value === '' || value === undefined || value === null) {
      if (required.has(key)) missingRequired.push(key);
      continue;
    }

    const typedValue = resolveTypedValue(value, schema);
    if (typedValue === undefined) {
      return { params, missingRequired, error: `参数 ${key} 格式不正确` };
    }
    params[key] = typedValue;
  }

  return { params, missingRequired };
};

const getWorkflowRank = (
  workflow: AvailableWorkflowItem,
  memory: WorkflowAutomationMemory | null,
  host: string,
): number => {
  const workflowKey = getWorkflowKey(workflow);
  const stats = memory?.workflowStats[workflowKey];
  const lastWorkflowScore = memory?.lastWorkflowByHost[host] === workflowKey ? 1000 : 0;
  const sourceScore = workflow.source === 'user' ? 300 : workflow.source === 'remote' ? 200 : 100;
  const scopeScore = workflow.scope === 'domain' ? 60 : 20;
  const successScore = Math.min(120, Math.max(0, Number(stats?.successCount) || 0) * 12);
  const riskScore = workflow.isHighRisk ? -240 : 20;
  return lastWorkflowScore + sourceScore + scopeScore + successScore + riskScore;
};

const summarizeFallbackReason = (
  workflow: AvailableWorkflowItem,
  missingRequired: string[],
): string | undefined => {
  if (workflow.isHighRisk) return workflow.riskReason || '该流程包含高风险动作，需要人工确认后再运行';
  if (missingRequired.length > 0) return `还缺少参数：${missingRequired.join('，')}`;
  return undefined;
};

export const WorkflowPanel: React.FC = () => {
  const { state, dispatch } = useMole();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [memory, setMemory] = useState<WorkflowAutomationMemory | null>(null);
  const [workflows, setWorkflows] = useState<AvailableWorkflowItem[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, WorkflowFormValue>>({});
  const [autoFilledKeys, setAutoFilledKeys] = useState<string[]>([]);
  const [panelMessage, setPanelMessage] = useState('');
  const active = state.isOpen && !state.currentTask;
  const host = window.location.hostname;

  const selectedWorkflow = selectedKey
    ? workflows.find(item => getWorkflowKey(item) === selectedKey) || null
    : null;

  const sortedWorkflows = [...workflows].sort((a, b) => {
    return getWorkflowRank(b, memory, host) - getWorkflowRank(a, memory, host);
  });

  const recommendedWorkflow = (() => {
    let best: { workflow: AvailableWorkflowItem; score: number } | null = null;
    for (const workflow of sortedWorkflows) {
      const autofill = buildAutofillResult(workflow, memory);
      const score = getWorkflowRank(workflow, memory, host)
        + (autofill.missingRequired.length === 0 ? 80 : -40 * autofill.missingRequired.length)
        + (workflow.hasRequiredParams ? 0 : 20);
      if (!best || score > best.score) {
        best = { workflow, score };
      }
    }
    return best?.workflow || null;
  })();

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setLoadError('');

    void Promise.all([
      getAutomationPreferences(),
      getWorkflowAutomationMemory(),
      new Promise<any>((resolve) => {
        Channel.send('__site_workflows_match', { url: window.location.href }, resolve);
      }),
    ]).then(([preferences, workflowMemory, response]) => {
      if (cancelled) return;
      const nextWorkflows = response?.success && Array.isArray(response.workflows)
        ? response.workflows.map(normalizeWorkflow).filter((item): item is AvailableWorkflowItem => Boolean(item))
        : [];
      setAutoEnabled(preferences.autoCompleteWorkflowOnClick === true);
      setMemory(workflowMemory);
      setWorkflows(nextWorkflows);
      setSelectedKey(null);
      setFormValues({});
      setAutoFilledKeys([]);
      setPanelMessage('');
    }).catch((error: any) => {
      if (cancelled) return;
      setLoadError(error?.message || '读取工作流失败');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [active]);

  const runWorkflow = useCallback((
    workflow: AvailableWorkflowItem,
    rawParams: Record<string, unknown>,
    mode: 'manual' | 'auto',
    filledKeys: string[] = [],
    fallbackReason?: string,
  ) => {
    const params = normalizeWorkflowParams(rawParams);
    submitNewTask(dispatch, {
      actualQuery: buildWorkflowShortcutQuery(workflow, params),
      displayQuery: summarizeWorkflowParams(workflow, params),
      displayTitle: workflow.label,
      taskKind: 'workflow',
      workflowRun: {
        engine: workflow.engine,
        workflowKey: getWorkflowKey(workflow),
        workflowId: workflow.workflowId,
        workflowName: workflow.name,
        workflowLabel: workflow.label,
        scope: workflow.scope,
        source: workflow.source,
        mode,
        params,
        autoFilledKeys: filledKeys,
        ...(fallbackReason ? { fallbackReason } : {}),
      },
      historyValue: false,
    });
  }, [dispatch]);

  const openWorkflowForm = useCallback((
    workflow: AvailableWorkflowItem,
    autofill: AutofillResult,
    message?: string,
  ) => {
    setSelectedKey(getWorkflowKey(workflow));
    setFormValues(autofill.values);
    setAutoFilledKeys(autofill.autoFilledKeys);
    setPanelMessage(message || summarizeFallbackReason(workflow, autofill.missingRequired) || '');
  }, []);

  const handleAutoAttempt = useCallback((workflow: AvailableWorkflowItem): boolean => {
    const autofill = buildAutofillResult(workflow, memory);
    const collected = collectWorkflowParams(workflow, autofill.values);
    if (collected.error) {
      openWorkflowForm(workflow, autofill, collected.error);
      return false;
    }
    if (workflow.isHighRisk || collected.missingRequired.length > 0) {
      openWorkflowForm(workflow, autofill, summarizeFallbackReason(workflow, collected.missingRequired));
      return false;
    }
    runWorkflow(
      workflow,
      collected.params,
      'auto',
      autofill.autoFilledKeys,
    );
    return true;
  }, [memory, openWorkflowForm, runWorkflow]);

  const handleWorkflowClick = useCallback((workflow: AvailableWorkflowItem) => {
    if (autoEnabled) {
      handleAutoAttempt(workflow);
      return;
    }
    if (!workflow.hasRequiredParams) {
      runWorkflow(workflow, {}, 'manual');
      return;
    }
    openWorkflowForm(workflow, buildAutofillResult(workflow, memory));
  }, [autoEnabled, handleAutoAttempt, memory, openWorkflowForm, runWorkflow]);

  const handleAutoSelect = useCallback(() => {
    if (!recommendedWorkflow) {
      setPanelMessage('当前页面没有可自动执行的工作流');
      return;
    }
    handleAutoAttempt(recommendedWorkflow);
  }, [handleAutoAttempt, recommendedWorkflow]);

  const handleRunSelected = useCallback(() => {
    if (!selectedWorkflow) return;
    const collected = collectWorkflowParams(selectedWorkflow, formValues);
    if (collected.error) {
      setPanelMessage(collected.error);
      return;
    }
    if (collected.missingRequired.length > 0) {
      setPanelMessage(`还缺少参数：${collected.missingRequired.join('，')}`);
      return;
    }
    runWorkflow(
      selectedWorkflow,
      collected.params,
      'manual',
      autoFilledKeys,
      panelMessage || undefined,
    );
  }, [autoFilledKeys, formValues, panelMessage, runWorkflow, selectedWorkflow]);

  if (!active) return null;

  return (
    <div className="mole-result visible">
      <div className="mole-workflow-hints">
        <div className="mole-workflow-hints-head">
          <div className="mole-workflow-panel-headline">
            <div className="mole-workflow-hints-title">当前页可用工作流</div>
            <div className="mole-workflow-panel-subtitle">
              {autoEnabled ? '点击流程会先补参数并自动执行' : '点击流程后可手动选择或填写参数'}
            </div>
          </div>
          <div className="mole-workflow-hints-count">{sortedWorkflows.length} 个</div>
        </div>

        {!selectedWorkflow && (
          <div className="mole-workflow-automation-row">
            <button
              type="button"
              className="mole-workflow-auto-btn"
              onClick={handleAutoSelect}
              disabled={loading || !recommendedWorkflow}
            >
              {recommendedWorkflow ? `系统自动选择并完成 · ${recommendedWorkflow.label}` : '系统自动选择并完成'}
            </button>
            <span className={`mole-workflow-pill${autoEnabled ? ' ready' : ''}`}>
              点击自动完成 {autoEnabled ? '已开启' : '未开启'}
            </span>
          </div>
        )}

        {panelMessage && (
          <div className="mole-workflow-auto-note">{panelMessage}</div>
        )}

        {loading && (
          <div className="mole-workflow-form-empty">正在读取当前页面工作流…</div>
        )}

        {!loading && loadError && (
          <div className="mole-workflow-form-empty">{loadError}</div>
        )}

        {!loading && !loadError && !selectedWorkflow && sortedWorkflows.length === 0 && (
          <div className="mole-workflow-form-empty">当前页面还没有可匹配的工作流。</div>
        )}

        {!loading && !loadError && !selectedWorkflow && sortedWorkflows.length > 0 && (
          <div className="mole-workflow-list">
            {sortedWorkflows.map((workflow) => {
              const workflowKey = getWorkflowKey(workflow);
              const metaParts = [
                workflow.skillLabel || '',
                workflow.scope === 'global' ? '通用' : '当前站点',
                workflow.source === 'user' ? '我的流程' : workflow.source === 'remote' ? '同步流程' : '内置流程',
              ].filter(Boolean);
              let badgeText = workflow.hasRequiredParams ? '需参数' : '可直接运行';
              let badgeClass = 'mole-workflow-pill';
              if (workflow.isHighRisk) {
                badgeText = '需确认';
              } else if (!workflow.hasRequiredParams) {
                badgeClass = 'mole-workflow-pill ready';
              }
              if (recommendedWorkflow && getWorkflowKey(recommendedWorkflow) === workflowKey && !workflow.isHighRisk) {
                metaParts.unshift('推荐');
              }
              return (
                <button
                  key={workflowKey}
                  type="button"
                  className="mole-workflow-item"
                  onClick={() => handleWorkflowClick(workflow)}
                >
                  <span className="mole-workflow-item-head">
                    <span className="mole-workflow-item-label">{workflow.label}</span>
                    <span className={badgeClass}>{badgeText}</span>
                  </span>
                  <span className="mole-workflow-item-desc">
                    {workflow.description || '预定义流程'}
                  </span>
                  <span className="mole-workflow-item-meta">{metaParts.join(' · ')}</span>
                </button>
              );
            })}
          </div>
        )}

        {selectedWorkflow && (
          <>
            <div className="mole-workflow-form-head">
              <button
                type="button"
                className="mole-workflow-back-btn"
                onClick={() => {
                  setSelectedKey(null);
                  setPanelMessage('');
                }}
              >
                返回
              </button>
              <div className="mole-workflow-form-title">{selectedWorkflow.label}</div>
            </div>
            <div className="mole-workflow-form-desc">
              {selectedWorkflow.description || '填写参数后运行工作流'}
            </div>
            <div className="mole-workflow-form-fields">
              {Object.entries(getProperties(selectedWorkflow)).length > 0 ? Object.entries(getProperties(selectedWorkflow)).map(([key, schema]) => {
                const type = String(schema.type || 'string');
                const description = String(schema.description || '').trim();
                const required = selectedWorkflow.requiredParams.includes(key);
                const value = formValues[key];
                if (type === 'boolean') {
                  return (
                    <label className="mole-workflow-field" key={key}>
                      <span className="mole-workflow-field-label">
                        {key}
                        {required && <span className="mole-workflow-field-required">必填</span>}
                      </span>
                      <span className="mole-workflow-field-desc">{description || '开关参数'}</span>
                      <label className="mole-workflow-checkbox">
                        <input
                          type="checkbox"
                          checked={value === true}
                          onChange={(event) => {
                            setFormValues(prev => ({ ...prev, [key]: event.target.checked }));
                          }}
                        />
                        <span>启用</span>
                      </label>
                    </label>
                  );
                }
                const inputType = type === 'number' || type === 'integer' ? 'number' : 'text';
                return (
                  <label className="mole-workflow-field" key={key}>
                    <span className="mole-workflow-field-label">
                      {key}
                      {required && <span className="mole-workflow-field-required">必填</span>}
                      {autoFilledKeys.includes(key) && <span className="mole-workflow-pill ready">已补全</span>}
                    </span>
                    <span className="mole-workflow-field-desc">{description || '参数'}</span>
                    <input
                      className="mole-workflow-field-input"
                      type={inputType}
                      value={value === undefined ? '' : String(value)}
                      onChange={(event) => {
                        const rawValue = event.target.value;
                        setFormValues(prev => ({
                          ...prev,
                          [key]: inputType === 'number' ? rawValue : rawValue,
                        }));
                      }}
                    />
                  </label>
                );
              }) : (
                <div className="mole-workflow-form-empty">这个流程没有额外参数。</div>
              )}
            </div>
            <div className="mole-workflow-form-actions">
              <button
                type="button"
                className="mole-workflow-run-btn"
                onClick={handleRunSelected}
              >
                运行流程
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
