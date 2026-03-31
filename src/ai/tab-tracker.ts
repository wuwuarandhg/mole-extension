/**
 * 标签页生命周期追踪器
 * 记录 AI 在任务执行过程中打开的标签页，任务结束时自动批量关闭。
 * keep_alive 标记的标签页不会被自动清理。
 */

import _console from '../lib/console';

export class TabTracker {
  /** 待清理的标签页 ID */
  private cleanupIds = new Set<number>();

  /** 记录打开的标签页 */
  trackOpened(tabId: number, keepAlive: boolean): void {
    if (keepAlive) return;
    this.cleanupIds.add(tabId);
  }

  /** 记录已关闭的标签页（避免二次关闭） */
  trackClosed(tabId: number): void {
    this.cleanupIds.delete(tabId);
  }

  /** 任务结束时批量关闭所有追踪的标签页 */
  async closeAll(): Promise<number> {
    if (this.cleanupIds.size === 0) return 0;

    let closed = 0;
    for (const id of this.cleanupIds) {
      try {
        await chrome.tabs.remove(id);
        closed++;
      } catch {
        // 标签页可能已被用户手动关闭，忽略
      }
    }

    if (closed > 0) {
      _console.log(`[TabTracker] 任务结束，自动关闭 ${closed} 个标签页`);
    }
    this.cleanupIds.clear();
    return closed;
  }
}
