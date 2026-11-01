// 入口最先加载：当前目录已被删除时先切到家目录，再让其它模块读取标准输入或 cwd。
import { recoverWorkingDirectory } from './working-directory.js'

// 固定码只写 stderr，不改变 stdout 与退出码；让用户知道相对路径已无法按原目录解析。
if (recoverWorkingDirectory() === 'reset') {
  process.stderr.write('working_directory_reset\n')
}
