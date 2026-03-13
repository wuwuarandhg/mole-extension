/**
 * 历史记录页面
 * 展示会话历史，支持展开查看工具调用链、AI 回复、调度日志等详情
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Space, Table, Tag, Timeline, Typography, App, Popconfirm } from 'antd';
import { ReloadOutlined, DeleteOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { SESSION_HISTORY_STORAGE_KEY } from '../../session-history/constants';
import type { SessionHistoryRecord } from '../../session-history/types';

const { Title, Text } = Typography;

/** 格式化耗时（毫秒 → 可读文本） */
const formatDuration = (ms?: number): string => {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
};

/** 状态标签中文映射 */
const STATUS_LABEL: Record<string, string> = {
  done: '完成',
  error: '失败',
  running: '运行中',
  cleared: '已清除',
};

/** 状态标签颜色映射 */
const STATUS_COLOR: Record<string, string> = {
  done: 'success',
  error: 'error',
  running: 'processing',
  cleared: 'default',
};

/** 从 storage 读取会话历史记录 */
const readSessionHistory = async (): Promise<SessionHistoryRecord[]> => {
  const result = await new Promise<Record<string, unknown>>((resolve) => {
    chrome.storage.local.get(SESSION_HISTORY_STORAGE_KEY, resolve);
  });
  const raw = result[SESSION_HISTORY_STORAGE_KEY];
  if (Array.isArray(raw)) return raw as SessionHistoryRecord[];
  if (raw && typeof raw === 'object' && Array.isArray((raw as any).records)) {
    return (raw as any).records as SessionHistoryRecord[];
  }
  return [];
};

export function HistoryPage() {
  const { message } = App.useApp();
  const [records, setRecords] = useState<SessionHistoryRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const data = await readSessionHistory();
      data.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      setRecords(data);
    } catch {
      void message.error('加载历史记录失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  /* 监听 storage 变化实时刷新 */
  useEffect(() => {
    const handler = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (changes[SESSION_HISTORY_STORAGE_KEY]) {
        void loadData();
      }
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }, [loadData]);

  /* 清空全部历史记录 */
  const handleClearAll = async () => {
    await new Promise<void>((resolve) => {
      chrome.storage.local.remove(SESSION_HISTORY_STORAGE_KEY, resolve);
    });
    setRecords([]);
    void message.success('历史记录已清空');
  };

  /* 表格列定义 */
  const columns: ColumnsType<SessionHistoryRecord> = [
    {
      title: '摘要',
      dataIndex: 'summary',
      ellipsis: true,
      render: (summary: string) => summary || '(无摘要)',
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (status: string) => (
        <Tag color={STATUS_COLOR[status] || 'default'}>
          {STATUS_LABEL[status] || status}
        </Tag>
      ),
    },
    {
      title: '时间',
      dataIndex: 'updatedAt',
      width: 140,
      render: (t: number) => dayjs(t).format('MM-DD HH:mm:ss'),
    },
    {
      title: '耗时',
      dataIndex: 'durationMs',
      width: 90,
      render: (ms: number) => formatDuration(ms),
    },
    {
      title: '工具数',
      dataIndex: 'toolCalls',
      width: 80,
      render: (calls: string[]) => calls?.length || 0,
    },
  ];

  /* 展开行内容 */
  const expandedRowRender = (record: SessionHistoryRecord) => {
    /* 调度日志嵌套表格列 */
    const transitionColumns: ColumnsType<SessionHistoryRecord['agentTransitions'][number]> = [
      { title: '阶段', dataIndex: 'phase', width: 100 },
      { title: '轮次', dataIndex: 'round', width: 60 },
      { title: '原因', dataIndex: 'reason' },
      {
        title: '时间',
        dataIndex: 'updatedAt',
        width: 90,
        render: (t: number) => dayjs(t).format('HH:mm:ss'),
      },
    ];

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '8px 0' }}>
        {/* 基本信息 */}
        <Card size="small" title="基本信息" style={{ boxShadow: 'none', border: '1px solid rgba(34,56,89,0.1)' }}>
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <Space wrap>
              <Tag color={STATUS_COLOR[record.status] || 'default'}>
                {STATUS_LABEL[record.status] || record.status}
              </Tag>
              <Text type="secondary" style={{ fontSize: 13 }}>
                {dayjs(record.startedAt).format('YYYY-MM-DD HH:mm:ss')}
              </Text>
              <Text type="secondary" style={{ fontSize: 13 }}>
                耗时: {formatDuration(record.durationMs)}
              </Text>
            </Space>
            <Text type="secondary" style={{ fontSize: 11 }} copyable>
              {record.sessionId}
            </Text>
            {record.toolCalls.length > 0 ? (
              <Space size={[4, 4]} wrap>
                {record.toolCalls.map((name, idx) => (
                  <Tag key={idx}>{name}</Tag>
                ))}
              </Space>
            ) : null}
          </Space>
        </Card>

        {/* 工具调用链 */}
        {record.toolCallChain.length > 0 ? (
          <Card size="small" title="工具调用链" style={{ boxShadow: 'none', border: '1px solid rgba(34,56,89,0.1)' }}>
            <Timeline
              items={record.toolCallChain.map((step) => {
                const stepDuration = (step.startedAt && step.endedAt)
                  ? step.endedAt - step.startedAt
                  : undefined;
                return {
                  color: step.status === 'done' ? 'green' : step.status === 'error' ? 'red' : 'gray',
                  children: (
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <strong style={{ fontSize: 13 }}>{step.funcName}</strong>
                        {stepDuration != null ? (
                          <Text type="secondary" style={{ fontSize: 12 }}>{formatDuration(stepDuration)}</Text>
                        ) : null}
                      </div>
                      {step.message ? (
                        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>
                          {step.message}
                        </Text>
                      ) : null}
                    </div>
                  ),
                };
              })}
            />
          </Card>
        ) : null}

        {/* AI 回复 */}
        {record.assistantReply ? (
          <Card size="small" title="AI 回复" style={{ boxShadow: 'none', border: '1px solid rgba(34,56,89,0.1)' }}>
            <pre style={{
              margin: 0,
              maxHeight: 420,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: '"SF Mono", "JetBrains Mono", "Menlo", monospace',
              fontSize: 12,
              lineHeight: 1.55,
            }}>
              {record.assistantReply}
            </pre>
          </Card>
        ) : null}

        {/* 调度日志 */}
        {record.agentTransitions.length > 0 ? (
          <Card size="small" title="调度日志" style={{ boxShadow: 'none', border: '1px solid rgba(34,56,89,0.1)' }}>
            <Table
              rowKey={(_, idx) => String(idx)}
              columns={transitionColumns}
              dataSource={record.agentTransitions}
              pagination={false}
              size="small"
            />
          </Card>
        ) : null}

        {/* 错误信息 */}
        {(record.failureCode || record.lastError) ? (
          <Alert
            type="error"
            showIcon
            message={record.failureCode ? `错误码：${record.failureCode}` : '错误'}
            description={record.lastError ? (
              <pre style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 12,
              }}>
                {record.lastError}
              </pre>
            ) : undefined}
          />
        ) : null}
      </div>
    );
  };

  return (
    <>
      <Title level={4} style={{ marginTop: 0, marginBottom: 20 }}>历史记录</Title>
      <Card
        style={{ marginBottom: 16, boxShadow: 'none' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text type="secondary">共 {records.length} 条记录。展开行查看详情。</Text>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => void loadData()}>刷新</Button>
            <Popconfirm
              title="确定清空全部历史记录吗？此操作不可撤销。"
              onConfirm={() => void handleClearAll()}
              okText="确定"
              cancelText="取消"
            >
              <Button danger icon={<DeleteOutlined />} disabled={records.length === 0}>清空全部</Button>
            </Popconfirm>
          </Space>
        </div>
      </Card>

      <Card style={{ boxShadow: 'none' }}>
        <Table
          rowKey="sessionId"
          columns={columns}
          dataSource={records}
          loading={loading}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          size="middle"
          expandable={{ expandedRowRender }}
          locale={{ emptyText: '暂无记录' }}
        />
      </Card>
    </>
  );
}
