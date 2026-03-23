/**
 * Todo 工具 — 任务规划与进度追踪
 *
 * 工厂函数模式：接收 TodoManager 实例引用（由 orchestrator 注入）。
 * 不通过 MCP Server 全局注册，在 agenticLoop 中本地拦截执行。
 *
 * action:
 *   create — 批量创建初始计划
 *   update — 推进某项状态（单焦点约束）
 *   add    — 追加新步骤
 *   remove — 删除待办项（仅 pending 可删）
 *   list   — 查看当前进度
 */

import type { FunctionDefinition, FunctionResult } from './types';
import type { TodoManager } from '../ai/todo-manager';

/** 创建 todo 工具的工厂函数 */
export const createTodoFunction = (getTodoManager: () => TodoManager): FunctionDefinition => ({
  name: 'todo',
  description: '任务规划与进度追踪。多步任务中，先用 create 制定计划，执行每步前用 update 标记 in_progress，完成后标记 completed。同一时间只能有一个任务进行中。最多 20 项。',
  supportsParallel: false,
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'update', 'add', 'remove', 'list'],
        description: 'create: 批量创建初始计划（传 items）；update: 更新状态（传 id + status）；add: 追加新项（传 title）；remove: 删除待办项（传 id）；list: 查看进度',
      },
      items: {
        type: 'array',
        items: { type: 'string' },
        description: 'action=create 时使用：任务标题列表，按执行顺序排列',
      },
      id: {
        type: 'number',
        description: 'action=update/remove 时使用：目标任务的 ID 编号',
      },
      status: {
        type: 'string',
        enum: ['in_progress', 'completed'],
        description: 'action=update 时使用：新状态',
      },
      title: {
        type: 'string',
        description: 'action=add 时使用：新任务的标题',
      },
      result: {
        type: 'string',
        description: 'action=update 且 status=completed 时可选：简要记录此步产出',
      },
    },
    required: ['action'],
  },

  validate: (params: any) => {
    const action = String(params.action || '');
    if (action === 'create' && (!Array.isArray(params.items) || params.items.length === 0)) {
      return 'create 操作需要提供非空的 items 数组';
    }
    if (action === 'update' && (params.id == null || !params.status)) {
      return 'update 操作需要提供 id 和 status';
    }
    if (action === 'add' && !params.title) {
      return 'add 操作需要提供 title';
    }
    if (action === 'remove' && params.id == null) {
      return 'remove 操作需要提供 id';
    }
    return null;
  },

  execute: async (params: {
    action: string;
    items?: string[];
    id?: number;
    status?: string;
    title?: string;
    result?: string;
  }): Promise<FunctionResult> => {
    const mgr = getTodoManager();
    const { action } = params;

    switch (action) {
      case 'create': {
        const titles = params.items || [];
        if (mgr.active) {
          return { success: false, error: '已有任务计划存在。用 add 追加新项，或先完成/删除现有项' };
        }
        const created = mgr.addBatch(titles);
        if (created.length < titles.length) {
          return {
            success: true,
            data: {
              message: `已创建 ${created.length} 项（达到上限 20，丢弃 ${titles.length - created.length} 项）`,
              items: mgr.all,
              stats: mgr.stats,
            },
          };
        }
        return {
          success: true,
          data: {
            message: `已创建 ${created.length} 项任务计划`,
            items: mgr.all,
            stats: mgr.stats,
          },
        };
      }

      case 'update': {
        const id = Number(params.id);
        const status = params.status as 'in_progress' | 'completed';
        const updated = mgr.update(id, status, params.result);
        if (!updated) {
          const item = mgr.all.find(i => i.id === id);
          if (!item) return { success: false, error: `ID #${id} 不存在` };
          if (item.status === 'completed') return { success: false, error: `#${id} 已完成，不能修改` };
          if (status === 'in_progress' && mgr.current) {
            return { success: false, error: `不能同时进行多个任务。当前进行中：#${mgr.current.id} ${mgr.current.title}。请先完成它` };
          }
          return { success: false, error: '状态转换不合法' };
        }
        return {
          success: true,
          data: {
            message: `#${id} 已更新为 ${status}`,
            current: mgr.current,
            stats: mgr.stats,
          },
        };
      }

      case 'add': {
        const item = mgr.add(params.title!);
        if (!item) {
          return { success: false, error: '已达上限 20 项' };
        }
        return {
          success: true,
          data: {
            message: `已追加 #${item.id}: ${item.title}`,
            item,
            stats: mgr.stats,
          },
        };
      }

      case 'remove': {
        const removed = mgr.remove(Number(params.id));
        if (!removed) {
          return { success: false, error: `无法删除 #${params.id}（不存在或非 pending 状态）` };
        }
        return {
          success: true,
          data: {
            message: `已删除 #${params.id}`,
            stats: mgr.stats,
          },
        };
      }

      case 'list': {
        if (!mgr.active) {
          return { success: true, data: { message: '当前没有任务计划', items: [], stats: mgr.stats } };
        }
        return {
          success: true,
          data: {
            items: mgr.all,
            stats: mgr.stats,
            statusText: mgr.toStatusText(),
          },
        };
      }

      default:
        return { success: false, error: `不支持的操作: ${action}` };
    }
  },
});
