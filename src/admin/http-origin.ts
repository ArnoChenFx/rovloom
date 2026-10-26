// 管理页与 MCP 共用 HTTP 请求边界；会话、Bearer 与 CSRF 仍由各自入口核验。
export {
  requestOrigin as managementRequestOrigin,
  secureRequest as managementSecureRequest
} from '../http/request-origin.js'
