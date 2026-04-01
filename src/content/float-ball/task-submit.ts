import type { Dispatch } from 'react';
import Channel from '../../lib/channel';
import { buildTaskTitle } from './text-utils';
import type { MoleAction, TaskItem } from './context/types';
import type { WorkflowRunMeta } from './workflow-types';

interface SubmitNewTaskOptions {
  actualQuery: string;
  displayQuery?: string;
  displayTitle?: string;
  taskKind?: string;
  workflowRun?: WorkflowRunMeta;
  historyValue?: string | false;
}

const createNewTask = ({
  actualQuery,
  displayQuery,
  displayTitle,
  taskKind,
  workflowRun,
}: SubmitNewTaskOptions, id?: string): TaskItem => {
  const visibleQuery = String(displayQuery || actualQuery).trim();
  return {
    id: id || Date.now().toString(),
    query: visibleQuery,
    title: buildTaskTitle(displayTitle || visibleQuery),
    status: 'running',
    resultHtml: '',
    callStack: [],
    errorMsg: '',
    lastAIText: '',
    agentPhase: 'plan',
    agentRound: 0,
    failureCode: '',
    startedAt: Date.now(),
    endedAt: null,
    durationMs: null,
    taskKind: taskKind || 'regular',
    workflowRun,
  };
};

export const submitNewTask = (
  dispatch: Dispatch<MoleAction>,
  options: SubmitNewTaskOptions,
): void => {
  const tempTask = createNewTask(options);
  dispatch({ type: 'SET_TASK', payload: tempTask });

  if (options.historyValue && options.historyValue.trim()) {
    dispatch({ type: 'PUSH_INPUT_HISTORY', payload: options.historyValue.trim() });
  }

  Channel.send('__session_create', { query: options.actualQuery }, (response: any) => {
    if (response?.sessionId) {
      dispatch({
        type: 'UPDATE_TASK',
        payload: {
          id: response.sessionId,
          ...(response.summary ? { title: buildTaskTitle(response.summary) } : {}),
        },
      });
      return;
    }
    if (response?.accepted === false) {
      const message = response?.message?.trim() || '创建会话失败';
      dispatch({
        type: 'UPDATE_TASK',
        payload: {
          status: 'error',
          errorMsg: message,
          failureCode: response?.code || '',
        },
      });
    }
  });
};
