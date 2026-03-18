/**
 * Skill 注册表
 * 职责：全局 Skill 加载 + 域级 Skill 同步/存储 + 增删改查
 *
 * 两层结构：
 *   全局 Skill → 源码打包（public/skills/global/manifest.json），只读
 *   域级 Skill → chrome.storage.local + 远端 manifest 同步 + 用户创建
 *
 * 存储隔离：全局和域级分开缓存，远端同步不会覆盖全局
 */

import type { SkillSpec, WorkflowEntry, SkillManifestSource } from './skill-types';
import { matchSkills } from './skill-matcher';

// ============ 常量 ============

const DOMAIN_STORAGE_KEY = 'mole_skills_v2';
const SOURCES_KEY = 'mole_skill_sources_v2';
const MIGRATION_FLAG_KEY = 'mole_skill_migrated_v1';
const SYNC_ALARM_NAME = 'mole_skill_sync';
const SYNC_INTERVAL_HOURS = 6;

/** 旧 site-workflow 存储键（用于迁移） */
const OLD_WORKFLOW_STORAGE_KEY = 'mole_site_workflows_v1';

/** 全局 Skill manifest URL（源码打包） */
const getGlobalManifestUrl = (): string => {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    return chrome.runtime.getURL('skills/global/manifest.json');
  }
  return '';
};

/** 域级 Skill 种子 manifest URL（源码打包） */
const getDomainSeedUrl = (): string => {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    return chrome.runtime.getURL('skills/domains/manifest.json');
  }
  return '';
};

// ============ 内存缓存 ============

/** 全局 Skill（源码打包，不可变） */
const globalSkillCache = new Map<string, SkillSpec>();
/** 域级 Skill（动态：远端同步 + 用户创建） */
const domainSkillCache = new Map<string, SkillSpec>();

let registryReadyPromise: Promise<void> | null = null;
let syncAlarmRegistered = false;

// ============ Chrome API 检测 ============

const hasChromeStorage = (): boolean =>
  typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);

const hasChromeAlarms = (): boolean =>
  typeof chrome !== 'undefined' && Boolean(chrome.alarms);

// ============ 存储操作 ============

interface DomainStoreShape {
  version: 2;
  updatedAt: number;
  skills: SkillSpec[];
}

interface SourcesStoreShape {
  version: 1;
  updatedAt: number;
  sources: SkillManifestSource[];
}

const chromeStorageGet = async (key: string): Promise<any> => {
  if (!hasChromeStorage()) return null;
  const result = await new Promise<Record<string, unknown>>(resolve => {
    chrome.storage.local.get(key, resolve);
  });
  return result[key] ?? null;
};

const chromeStorageSet = async (key: string, value: unknown): Promise<void> => {
  if (!hasChromeStorage()) return;
  await new Promise<void>(resolve => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
};

const readDomainStore = async (): Promise<DomainStoreShape | null> => {
  const raw = await chromeStorageGet(DOMAIN_STORAGE_KEY);
  if (!raw || typeof raw !== 'object') return null;
  const payload = raw as DomainStoreShape;
  if (!Array.isArray(payload.skills)) return null;
  return payload;
};

const persistDomainStore = async (): Promise<void> => {
  const skills = Array.from(domainSkillCache.values())
    .sort((a, b) => a.name.localeCompare(b.name));
  const payload: DomainStoreShape = {
    version: 2,
    updatedAt: Date.now(),
    skills,
  };
  await chromeStorageSet(DOMAIN_STORAGE_KEY, payload);
};

const readSources = async (): Promise<SkillManifestSource[]> => {
  const raw = await chromeStorageGet(SOURCES_KEY);
  if (!raw || typeof raw !== 'object') return [];
  const payload = raw as SourcesStoreShape;
  return Array.isArray(payload.sources) ? payload.sources : [];
};

const persistSources = async (sources: SkillManifestSource[]): Promise<void> => {
  const payload: SourcesStoreShape = {
    version: 1,
    updatedAt: Date.now(),
    sources,
  };
  await chromeStorageSet(SOURCES_KEY, payload);
};

// ============ 校验 ============

/** 校验单个 workflow 条目 */
const validateWorkflow = (raw: unknown): WorkflowEntry | null => {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;

  const name = String(src.name || '').trim();
  if (!name) return null;

  const label = String(src.label || '').trim();
  if (!label) return null;

  const description = String(src.description || '').trim();

  const plan = src.plan;
  if (!plan || typeof plan !== 'object') return null;
  const planObj = plan as Record<string, unknown>;
  if (!Array.isArray(planObj.steps) || planObj.steps.length === 0) return null;

  const parameters = src.parameters && typeof src.parameters === 'object'
    ? src.parameters as Record<string, any>
    : { type: 'object', properties: {} };

  return { name, label, description, parameters, plan: plan as Record<string, any> };
};

/** 校验 Skill 定义 */
const validateSkillSpec = (raw: unknown): SkillSpec | null => {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;

  const name = String(src.name || '').trim();
  if (!name || name.length > 64) return null;

  const label = String(src.label || '').trim();
  if (!label) return null;

  const description = String(src.description || '').trim();
  const scope = src.scope === 'global' ? 'global' : 'domain';

  const urlPatterns = Array.isArray(src.url_patterns)
    ? (src.url_patterns as unknown[]).map((p: unknown) => String(p || '').trim()).filter(Boolean)
    : [];

  // 域级 Skill 必须有 url_patterns
  if (scope === 'domain' && urlPatterns.length === 0) return null;

  const guide = String(src.guide || '').trim();

  // 校验 workflows
  const rawWorkflows = Array.isArray(src.workflows) ? src.workflows : [];
  const workflows: WorkflowEntry[] = [];
  for (const rawWf of rawWorkflows) {
    const wf = validateWorkflow(rawWf);
    if (wf) workflows.push(wf);
  }

  const source = (['builtin', 'remote', 'user'] as const).includes(src.source as any)
    ? src.source as 'builtin' | 'remote' | 'user'
    : 'remote';

  return {
    name,
    label,
    description,
    scope,
    url_patterns: urlPatterns,
    guide,
    workflows,
    enabled: src.enabled !== false,
    source,
    manifestUrl: typeof src.manifestUrl === 'string' ? src.manifestUrl : undefined,
    version: Math.max(1, Math.floor(Number(src.version) || 1)),
    createdAt: Number(src.createdAt) || Date.now(),
    updatedAt: Number(src.updatedAt) || Date.now(),
  };
};

// ============ Manifest 同步（域级） ============

/** 从远端 URL 拉取并合并域级 Skill */
const syncFromManifestUrl = async (manifestUrl: string): Promise<{
  imported: number;
  skipped: number;
  removed: number;
  error?: string;
}> => {
  try {
    const response = await fetch(manifestUrl, { cache: 'no-store' });
    if (!response.ok) {
      return { imported: 0, skipped: 0, removed: 0, error: `HTTP ${response.status}` };
    }
    const payload = await response.json();

    // 兼容新旧 manifest 格式
    let rawSkills: unknown[] = [];
    if (Array.isArray(payload?.skills)) {
      rawSkills = payload.skills;
    } else if (Array.isArray(payload?.workflows)) {
      // 旧格式：workflows[] → 逐个包装为单 workflow 的 Skill
      rawSkills = (payload.workflows as unknown[]).map((w: any) => ({
        name: `migrated-wf-${String(w?.name || '').trim().replace(/\s+/g, '-')}`,
        label: w?.label || w?.name || '',
        description: w?.description || '',
        scope: 'domain',
        url_patterns: w?.url_patterns || ['*://*/*'],
        guide: '',
        workflows: [w],
        enabled: w?.enabled !== false,
        source: 'remote',
        version: w?.version || 1,
      }));
    }

    const incomingNames = new Set<string>();
    let imported = 0;
    let skipped = 0;

    for (const raw of rawSkills) {
      const spec = validateSkillSpec(raw);
      if (!spec) { skipped++; continue; }

      spec.manifestUrl = manifestUrl;
      spec.scope = 'domain'; // 远端同步只产生域级 Skill
      incomingNames.add(spec.name);

      // 合并策略：user 来源的永远不覆盖
      const existing = domainSkillCache.get(spec.name);
      if (existing?.source === 'user') { skipped++; continue; }
      // remote/builtin 来源：只有版本更大才覆盖
      if (existing && existing.version >= spec.version) { skipped++; continue; }
      // 保留已有时间戳
      if (existing) spec.createdAt = existing.createdAt;

      spec.source = 'remote';
      domainSkillCache.set(spec.name, spec);
      imported++;
    }

    // 清理：来自同一 manifestUrl 但已不在最新 manifest 中的 remote Skill
    let removed = 0;
    for (const [name, cached] of Array.from(domainSkillCache.entries())) {
      if (cached.source !== 'remote') continue;
      if (cached.manifestUrl !== manifestUrl) continue;
      if (incomingNames.has(name)) continue;
      domainSkillCache.delete(name);
      removed++;
    }

    return { imported, skipped, removed };
  } catch (err: any) {
    return { imported: 0, skipped: 0, removed: 0, error: err?.message || '拉取失败' };
  }
};

/** 从所有已配置的 Manifest 源同步 */
export const syncAllSkillManifests = async (): Promise<{
  totalImported: number;
  totalSkipped: number;
  errors: string[];
}> => {
  const sources = await readSources();
  const enabledSources = sources.filter(s => s.enabled && s.url);

  let totalImported = 0;
  let totalSkipped = 0;
  const errors: string[] = [];

  for (const src of enabledSources) {
    const result = await syncFromManifestUrl(src.url);
    totalImported += result.imported;
    totalSkipped += result.skipped;
    src.lastSyncAt = Date.now();
    src.lastSyncError = result.error;
    if (result.error) {
      errors.push(`${src.url}: ${result.error}`);
    }
  }

  if (enabledSources.length > 0) {
    await persistSources(sources);
  }
  if (totalImported > 0) {
    await persistDomainStore();
  }

  return { totalImported, totalSkipped, errors };
};

// ============ 定时同步 ============

const registerSyncAlarm = (): void => {
  if (syncAlarmRegistered || !hasChromeAlarms()) return;
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name !== SYNC_ALARM_NAME) return;
    void syncAllSkillManifests();
  });
  chrome.alarms.create(SYNC_ALARM_NAME, {
    delayInMinutes: SYNC_INTERVAL_HOURS * 60,
    periodInMinutes: SYNC_INTERVAL_HOURS * 60,
  });
  syncAlarmRegistered = true;
};

// ============ 旧数据迁移 ============

/** 将旧 site-workflow 中 user 来源的数据迁移到 Skill 体系 */
const migrateFromSiteWorkflows = async (): Promise<void> => {
  const migrated = await chromeStorageGet(MIGRATION_FLAG_KEY);
  if (migrated) return;

  const oldStore = await chromeStorageGet(OLD_WORKFLOW_STORAGE_KEY);
  if (!oldStore || typeof oldStore !== 'object') {
    await chromeStorageSet(MIGRATION_FLAG_KEY, true);
    return;
  }

  const oldWorkflows = Array.isArray((oldStore as any).workflows)
    ? (oldStore as any).workflows as any[]
    : [];

  const userWorkflows = oldWorkflows.filter((w: any) => w?.source === 'user');
  if (userWorkflows.length === 0) {
    await chromeStorageSet(MIGRATION_FLAG_KEY, true);
    return;
  }

  for (const wf of userWorkflows) {
    const name = String(wf.name || '').trim();
    if (!name) continue;

    // 每个 user workflow 创建一个独立的域级 Skill
    const skill: SkillSpec = {
      name: `user-${name.replace(/\s+/g, '-')}`,
      label: wf.label || name,
      description: wf.description || '',
      scope: 'domain',
      url_patterns: Array.isArray(wf.url_patterns) ? wf.url_patterns : ['*://*/*'],
      guide: '',
      workflows: [{
        name,
        label: wf.label || name,
        description: wf.description || '',
        parameters: wf.parameters || { type: 'object', properties: {} },
        plan: wf.plan || { steps: [] },
      }],
      enabled: wf.enabled !== false,
      source: 'user',
      version: wf.version || 1,
      createdAt: wf.createdAt || Date.now(),
      updatedAt: wf.updatedAt || Date.now(),
    };

    // 不覆盖已有的同名 Skill
    if (!domainSkillCache.has(skill.name)) {
      domainSkillCache.set(skill.name, skill);
    }
  }

  await persistDomainStore();
  await chromeStorageSet(MIGRATION_FLAG_KEY, true);
};

// ============ 初始化 ============

const loadAllSkills = async (): Promise<void> => {
  globalSkillCache.clear();
  domainSkillCache.clear();

  // 1. 加载全局 Skill（源码打包，只读）
  const globalUrl = getGlobalManifestUrl();
  if (globalUrl) {
    try {
      const resp = await fetch(globalUrl, { cache: 'no-store' });
      if (resp.ok) {
        const data = await resp.json();
        const rawSkills = Array.isArray(data?.skills) ? data.skills : [];
        for (const raw of rawSkills) {
          const spec = validateSkillSpec(raw);
          if (!spec) continue;
          spec.source = 'builtin';
          spec.scope = 'global';
          globalSkillCache.set(spec.name, spec);
        }
      }
    } catch {
      // 全局 Skill 加载失败不影响后续
    }
  }

  // 2. 加载域级种子（源码打包，可被远端覆盖）
  const seedUrl = getDomainSeedUrl();
  if (seedUrl) {
    try {
      const resp = await fetch(seedUrl, { cache: 'no-store' });
      if (resp.ok) {
        const data = await resp.json();
        const rawSkills = Array.isArray(data?.skills) ? data.skills : [];
        for (const raw of rawSkills) {
          const spec = validateSkillSpec(raw);
          if (!spec) continue;
          spec.source = 'builtin';
          spec.scope = 'domain';
          domainSkillCache.set(spec.name, spec);
        }
      }
    } catch {
      // 域级种子加载失败不影响后续
    }
  }

  // 3. 从 chrome.storage 加载域级 Skill（覆盖种子）
  const store = await readDomainStore();
  if (store?.skills) {
    for (const raw of store.skills) {
      const spec = validateSkillSpec(raw);
      if (!spec) continue;
      // 恢复已存储的来源信息
      spec.source = (raw as any).source === 'user' ? 'user'
        : (raw as any).source === 'builtin' ? 'builtin'
        : 'remote';
      spec.scope = 'domain';
      spec.manifestUrl = typeof (raw as any).manifestUrl === 'string' ? (raw as any).manifestUrl : undefined;
      domainSkillCache.set(spec.name, spec);
    }
  }

  // 4. 迁移旧 site-workflow 数据
  await migrateFromSiteWorkflows();

  // 5. 注册定时同步
  registerSyncAlarm();

  // 6. 配置 Manifest 源（首次安装时注入域级种子源）
  await initManifestSources();

  // 7. 启动时触发一次同步（不阻塞初始化）
  void syncAllSkillManifests();
};

/** 首次安装时配置 Manifest 源 */
const initManifestSources = async (): Promise<void> => {
  const sources = await readSources();
  let changed = false;

  // 迁移：清理旧 site-workflow 时代的远端源
  const oldRemoteUrl = 'https://logjs.site/easychat/manifest.json';
  const oldIdx = sources.findIndex(s => s.url === oldRemoteUrl);
  if (oldIdx >= 0) {
    sources.splice(oldIdx, 1);
    changed = true;
  }

  // 也清理旧的本地 workflow manifest 源
  const oldLocalUrl = typeof chrome !== 'undefined' && chrome.runtime?.getURL
    ? chrome.runtime.getURL('workflows/manifest.json')
    : '';
  if (oldLocalUrl) {
    const oldLocalIdx = sources.findIndex(s => s.url === oldLocalUrl);
    if (oldLocalIdx >= 0) {
      sources.splice(oldLocalIdx, 1);
      changed = true;
    }
  }

  if (changed) {
    await persistSources(sources);
  }
};

// ============ 公共接口 ============

/** 确保注册表已加载 */
export const ensureSkillRegistryReady = async (): Promise<void> => {
  if (!registryReadyPromise) {
    registryReadyPromise = loadAllSkills().catch(err => {
      console.warn('[Mole] 加载 Skill 注册表失败:', err);
    });
  }
  await registryReadyPromise;
};

// 模块加载时立即触发初始化
void ensureSkillRegistryReady();

// ============ 查询接口 ============

/** 获取所有 Skill（全局 + 域级） */
export const listAllSkills = async (): Promise<SkillSpec[]> => {
  await ensureSkillRegistryReady();
  return [...globalSkillCache.values(), ...domainSkillCache.values()]
    .sort((a, b) => {
      if (a.scope !== b.scope) return a.scope === 'global' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
};

/** 获取全局 Skill */
export const listGlobalSkills = async (): Promise<SkillSpec[]> => {
  await ensureSkillRegistryReady();
  return Array.from(globalSkillCache.values())
    .sort((a, b) => a.name.localeCompare(b.name));
};

/** 获取域级 Skill */
export const listDomainSkills = async (): Promise<SkillSpec[]> => {
  await ensureSkillRegistryReady();
  return Array.from(domainSkillCache.values())
    .sort((a, b) => a.name.localeCompare(b.name));
};

/** 根据名称获取 Skill */
export const getSkill = async (name: string): Promise<SkillSpec | null> => {
  await ensureSkillRegistryReady();
  return globalSkillCache.get(name) || domainSkillCache.get(name) || null;
};

/** 根据 URL 匹配可用的 Skill */
export const matchSkillsByUrl = async (url: string): Promise<SkillSpec[]> => {
  await ensureSkillRegistryReady();
  const all = [...globalSkillCache.values(), ...domainSkillCache.values()];
  return matchSkills(url, all);
};

/** 根据 workflow 名称在所有 Skill 中查找（常驻运行器用） */
export const getWorkflowByName = async (workflowName: string): Promise<WorkflowEntry | null> => {
  await ensureSkillRegistryReady();
  // 域级优先（更具体），全局兜底
  const all = [...domainSkillCache.values(), ...globalSkillCache.values()];
  for (const skill of all) {
    if (!skill.enabled) continue;
    const found = skill.workflows.find(w => w.name === workflowName);
    if (found) return found;
  }
  return null;
};

// ============ 域级管理接口 ============

/** 添加或更新用户自定义 Skill */
export const upsertUserSkill = async (raw: unknown): Promise<{
  success: boolean;
  message: string;
}> => {
  await ensureSkillRegistryReady();
  const spec = validateSkillSpec(raw);
  if (!spec) return { success: false, message: 'Skill 定义不合法' };

  spec.source = 'user';
  spec.scope = 'domain';
  spec.manifestUrl = undefined;

  const existing = domainSkillCache.get(spec.name);
  if (existing) spec.createdAt = existing.createdAt;

  domainSkillCache.set(spec.name, spec);
  await persistDomainStore();
  return { success: true, message: `用户 Skill 已更新：${spec.name}` };
};

/** 向已有 Skill 追加 workflow（用户录制保存时） */
export const addWorkflowToSkill = async (
  skillName: string,
  workflow: WorkflowEntry,
): Promise<{ success: boolean; message: string }> => {
  await ensureSkillRegistryReady();
  const skill = domainSkillCache.get(skillName);
  if (!skill) return { success: false, message: `Skill 不存在：${skillName}` };

  // 替换同名 workflow 或追加
  const idx = skill.workflows.findIndex(w => w.name === workflow.name);
  if (idx >= 0) {
    skill.workflows[idx] = workflow;
  } else {
    skill.workflows.push(workflow);
  }
  skill.updatedAt = Date.now();

  await persistDomainStore();
  return { success: true, message: `workflow 已添加到 ${skillName}：${workflow.name}` };
};

/** 保存用户录制的 workflow（自动归入域级 Skill） */
export const upsertUserWorkflow = async (
  workflowRaw: unknown,
  tabUrl?: string,
): Promise<{ success: boolean; message: string }> => {
  const wf = validateWorkflow(workflowRaw);
  if (!wf) return { success: false, message: 'workflow 定义不合法' };

  await ensureSkillRegistryReady();

  // 尝试找到匹配的已有域级 Skill
  if (tabUrl) {
    const all = [...domainSkillCache.values()];
    const matched = matchSkills(tabUrl, all);
    if (matched.length > 0) {
      return addWorkflowToSkill(matched[0].name, wf);
    }
  }

  // 没有匹配的 Skill → 创建新的域级 user Skill
  const urlPatterns = tabUrl ? [extractDomainPattern(tabUrl)] : ['*://*/*'];
  const skillName = `user-${wf.name.replace(/\s+/g, '-')}`;
  const skill: SkillSpec = {
    name: skillName,
    label: wf.label || wf.name,
    description: wf.description || '',
    scope: 'domain',
    url_patterns: urlPatterns,
    guide: '',
    workflows: [wf],
    enabled: true,
    source: 'user',
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  domainSkillCache.set(skill.name, skill);
  await persistDomainStore();
  return { success: true, message: `用户 workflow 已保存为新 Skill：${skillName}` };
};

/** 删除域级 Skill（仅 user 来源可删） */
export const removeUserSkill = async (name: string): Promise<{
  success: boolean;
  message: string;
}> => {
  await ensureSkillRegistryReady();
  const existing = domainSkillCache.get(name);
  if (!existing) return { success: false, message: `Skill 不存在：${name}` };
  if (existing.source !== 'user') return { success: false, message: '只能删除用户自定义 Skill' };
  domainSkillCache.delete(name);
  await persistDomainStore();
  return { success: true, message: `Skill 已删除：${name}` };
};

// ============ Manifest 源管理 ============

/** 获取所有 Manifest 源 */
export const listManifestSources = async (): Promise<SkillManifestSource[]> => {
  return readSources();
};

/** 添加 Manifest 源 */
export const addManifestSource = async (url: string, label?: string): Promise<{
  success: boolean;
  message: string;
}> => {
  const trimmedUrl = String(url || '').trim();
  if (!/^https?:\/\//i.test(trimmedUrl)) {
    return { success: false, message: 'Manifest URL 必须是 http/https' };
  }
  const sources = await readSources();
  if (sources.some(s => s.url === trimmedUrl)) {
    return { success: false, message: '该 Manifest 源已存在' };
  }
  sources.push({ url: trimmedUrl, label: label || trimmedUrl, enabled: true });
  await persistSources(sources);
  // 立即同步新源
  await syncFromManifestUrl(trimmedUrl);
  await persistDomainStore();
  return { success: true, message: `Manifest 源已添加：${trimmedUrl}` };
};

/** 移除 Manifest 源 */
export const removeManifestSource = async (url: string): Promise<{
  success: boolean;
  message: string;
}> => {
  const sources = await readSources();
  const index = sources.findIndex(s => s.url === url);
  if (index < 0) return { success: false, message: '该 Manifest 源不存在' };
  sources.splice(index, 1);
  await persistSources(sources);
  return { success: true, message: `Manifest 源已移除：${url}` };
};

/** 强制从存储重新加载缓存 */
export const reloadSkillRegistry = async (): Promise<void> => {
  globalSkillCache.clear();
  domainSkillCache.clear();
  registryReadyPromise = null;
  await ensureSkillRegistryReady();
};

// ============ 工具函数 ============

/** 从 URL 提取域名 pattern（如 "*://*.jd.com/*"） */
const extractDomainPattern = (url: string): string => {
  try {
    const u = new URL(url);
    const host = u.hostname;
    // 去掉 www 前缀
    const domain = host.replace(/^www\./, '');
    return `*://*.${domain}/*`;
  } catch {
    return '*://*/*';
  }
};
