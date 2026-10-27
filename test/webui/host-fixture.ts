/** 明确的主机展示样例，不从当前测试机器采集或推断生产数据。 */
import type { DeviceSnapshot } from '../../src/mcp/management.js'
import { fixtureTime } from './fixtures.js'

export function fixtureHostFields(): Pick<DeviceSnapshot, 'host' | 'last_seen_at' | 'link_since'> {
  return {
    last_seen_at: fixtureTime - 2000,
    link_since: fixtureTime - 3600000,
    host: {
      os: { family: 'linux', distribution: 'debian-12', kernel: '6.1.0-31-amd64' },
      arch: 'x86_64',
      cpus: 4,
      memory_bytes: 17179869184,
      container: 'docker',
      agent_version: '0.6.7',
      providers: [
        { provider_id: 'fixture-herdr', native_version: '0.9.5' },
        { provider_id: 'fixture-luvus', native_version: '0.14.3' }
      ],
      reported_at: fixtureTime - 3600000,
      source: 'connector_handshake'
    }
  }
}
