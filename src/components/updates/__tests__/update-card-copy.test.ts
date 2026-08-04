import { describe, expect, it } from 'vitest'

import { getUpdateErrorMessage } from '../update-card-copy'

const zh = (zhCNText: string) => zhCNText

describe('update card copy', () => {
  it('tells a manually checking unpacked build to install the formal package instead of blaming the network', () => {
    const copy = getUpdateErrorMessage({
      code: 'UPDATE_CONFIGURATION_MISSING',
      phase: 'configuration',
      reason: 'configuration-missing',
      retryable: false,
      safeTechnicalDetails: 'UPDATE_CONFIGURATION_MISSING',
    }, zh)

    expect(copy).toBe('测试/解压包缺少更新配置，请使用正式安装版或打开Release。')
    expect(copy).not.toContain('网络')
  })

  it.each([
    ['network', 'DNS_OR_OFFLINE', '无法连接更新服务。请检查网络连接后重试。'],
    ['proxy', 'PROXY_CONNECT_FAILED', '更新请求无法通过代理连接。请检查代理设置后重试。'],
    ['tls', 'TLS_HANDSHAKE_FAILED', '无法验证更新服务的安全连接。请检查系统时间、证书或网络拦截。'],
    ['http-forbidden', 'HTTP_403', '没有权限访问更新发布信息。请打开Release手动下载正式安装包。'],
    ['http-not-found', 'HTTP_404', '未找到更新发布信息。请打开Release手动下载正式安装包。'],
    ['http-rate-limited', 'HTTP_429', '更新服务请求过于频繁。请稍后重试。'],
    ['metadata-invalid', 'UPDATE_METADATA_INVALID', '更新元数据无效。请打开Release手动下载正式安装包。'],
    ['asset-missing', 'UPDATE_ASSET_MISSING', '更新安装包不完整或缺失。请打开Release手动下载正式安装包。'],
  ] as const)('uses an actionable %s message without generic network blame', (reason, safeTechnicalDetails, expected) => {
    const copy = getUpdateErrorMessage({
      code: reason === 'asset-missing' ? 'DOWNLOAD_FAILED' : 'CHECK_FAILED',
      phase: reason === 'asset-missing' ? 'download' : 'check',
      reason,
      retryable: reason === 'network' || reason === 'proxy' || reason === 'tls' || reason === 'http-rate-limited',
      safeTechnicalDetails,
    }, zh)

    expect(copy).toBe(expected)
    if (reason !== 'network') expect(copy).not.toContain('检查网络')
  })
})
