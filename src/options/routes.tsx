/**
 * 路由 & 菜单配置
 * 新增页面只需在 routes 数组追加一项 + 创建对应 Page 组件
 */

import { useCallback, useEffect, useState } from 'react';
import {
  SettingOutlined,
  ThunderboltOutlined,
  StopOutlined,
  HistoryOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';

export interface RouteItem {
  key: string;
  label: string;
  icon: React.ReactNode;
}

export const routes: RouteItem[] = [
  { key: 'settings', label: 'LLM 设置', icon: <SettingOutlined /> },
  { key: 'workflows', label: 'Workflows', icon: <ThunderboltOutlined /> },
  { key: 'blocklist', label: '域名管理', icon: <StopOutlined /> },
  { key: 'history', label: '历史记录', icon: <HistoryOutlined /> },
];

/** 从 routes 生成 AntD Menu items */
export const menuItems: MenuProps['items'] = routes.map((r) => ({
  key: r.key,
  icon: r.icon,
  label: r.label,
}));

const DEFAULT_KEY = 'settings';

/** 解析 hash 值为路由 key */
const parseHash = (): string => {
  const hash = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  const matched = routes.find((r) => r.key === hash);
  return matched ? matched.key : DEFAULT_KEY;
};

/** 自定义 hash 路由 hook */
export const useHashRoute = (): [string, (key: string) => void] => {
  const [activeKey, setActiveKeyState] = useState(parseHash);

  useEffect(() => {
    const onHashChange = () => {
      setActiveKeyState(parseHash());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const setActiveKey = useCallback((key: string) => {
    window.location.hash = '#/' + key;
  }, []);

  return [activeKey, setActiveKey];
};
