/**
 * 域名管理页面
 * 管理悬浮球禁用域名的黑名单
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Space, Table, Typography, App, Popconfirm } from 'antd';
import { ReloadOutlined, DeleteOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';

const { Title, Text } = Typography;

const DISABLED_DOMAINS_KEY = 'mole_disabled_domains_v1';

interface DisabledDomainsStore {
  version: 1;
  updatedAt: number;
  domains: string[];
}

/** 从 storage 读取黑名单域名列表 */
const readBlockedDomains = async (): Promise<string[]> => {
  const result = await new Promise<Record<string, unknown>>((resolve) => {
    chrome.storage.local.get(DISABLED_DOMAINS_KEY, resolve);
  });
  const raw = result[DISABLED_DOMAINS_KEY] as DisabledDomainsStore | undefined;
  if (!raw || !Array.isArray(raw.domains)) return [];
  return raw.domains;
};

/** 保存黑名单域名列表到 storage */
const persistBlockedDomains = async (domains: string[]): Promise<void> => {
  const payload: DisabledDomainsStore = {
    version: 1,
    updatedAt: Date.now(),
    domains: [...domains].sort(),
  };
  await new Promise<void>((resolve) => {
    chrome.storage.local.set({ [DISABLED_DOMAINS_KEY]: payload }, resolve);
  });
};

export function BlocklistPage() {
  const { message } = App.useApp();
  const [domains, setDomains] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const list = await readBlockedDomains();
      setDomains(list);
    } catch {
      void message.error('加载域名黑名单失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  /* 删除单个域名 */
  const handleRemove = async (domain: string) => {
    const updated = domains.filter((d) => d !== domain);
    await persistBlockedDomains(updated);
    setDomains(updated);
    void message.success(`已移除 "${domain}"，该域名的悬浮球将在下次访问时恢复`);
  };

  /* 清空全部 */
  const handleClearAll = async () => {
    await persistBlockedDomains([]);
    setDomains([]);
    void message.success('域名黑名单已清空');
  };

  const columns: ColumnsType<string> = [
    {
      title: '域名',
      render: (_: unknown, domain: string) => (
        <span style={{ fontFamily: 'monospace' }}>{domain}</span>
      ),
    },
    {
      title: '操作',
      width: 80,
      render: (_: unknown, domain: string) => (
        <Button type="link" size="small" danger onClick={() => void handleRemove(domain)}>
          删除
        </Button>
      ),
    },
  ];

  return (
    <>
      <Title level={4} style={{ marginTop: 0, marginBottom: 20 }}>域名管理</Title>
      <Card
        style={{ marginBottom: 16, boxShadow: 'none' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text type="secondary">
            以下域名的悬浮球已被禁用。删除某个域名后，该域名的悬浮球将在下次访问时恢复。
          </Text>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => void loadData()}>刷新</Button>
            <Popconfirm
              title="确定清空全部已禁用的域名吗？"
              onConfirm={() => void handleClearAll()}
              okText="确定"
              cancelText="取消"
            >
              <Button danger icon={<DeleteOutlined />} disabled={domains.length === 0}>清空全部</Button>
            </Popconfirm>
          </Space>
        </div>
      </Card>

      <Card style={{ boxShadow: 'none' }}>
        <Table
          rowKey={(domain) => domain}
          columns={columns}
          dataSource={domains}
          loading={loading}
          pagination={false}
          size="middle"
          locale={{ emptyText: '暂无被禁用的域名' }}
        />
      </Card>
    </>
  );
}
