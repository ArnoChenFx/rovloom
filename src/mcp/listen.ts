// 监听网卡与本机提示地址：反向代理使用的域名不受监听 hostname 限制。
export type ListenHostname = '127.0.0.1' | '::1' | '0.0.0.0' | '::'

/** 通配地址监听所有网卡；认证与反向代理请求处理和回环绑定一致，不提供网络层隔离。 */
export const isWildcardHostname = (hostname: string | undefined): boolean => hostname === '0.0.0.0' || hostname === '::'

/** URL 形式的规范回环主机：IPv6 带方括号；缺省按 127.0.0.1。 */
export function canonicalLoopbackHost(hostname: ListenHostname | undefined): '127.0.0.1' | '[::1]' {
  return hostname === '::1' || hostname === '::' ? '[::1]' : '127.0.0.1'
}
