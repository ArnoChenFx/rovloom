"""检查全量方法盘点的漏项、错误引用及保证越权；不执行 Herdr。"""

from copy import deepcopy
from pathlib import Path
import sys
import tempfile
import unittest

# 显式载入当前 checkout 的离线盘点工具，避免依赖外部安装。
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/herdr'))

from contract import Rejected, reviewed_production_allowlist, WORKFLOW_RESPONSE_TYPES
from audit_methods import FIXTURES, MATRIX, audit, methods, read_json


class MethodInventory(unittest.TestCase):
    """完整性审计必须拒绝漏方法、错 schema 根以及伪造支持范围。"""

    def setUp(self):
        """每个反例使用独立矩阵副本，保持仓库 fixture 不变。"""
        self.matrix = read_json(MATRIX)
        self.schema = read_json(FIXTURES / 'schema.json')
        self.provenance = read_json(FIXTURES / 'provenance.json')

    def checked(self, matrix=None, schema=None, tree=None):
        """调用真实审计入口，默认只读固定文件而不访问源码或实例。"""
        return audit(matrix or self.matrix, schema or self.schema, self.provenance, tree)

    def row(self, name):
        """按完整原生方法名称取得当前测试副本中的唯一条目。"""
        return next(row for row in self.matrix['methods'] if row['method'] == name)

    def test_all_native_methods_are_covered_without_execution_permission(self):
        """精确覆盖原生 schema 方法，离线审计不自报源码验真或执行许可。"""
        result = self.checked()
        self.assertEqual(result['method_count'], len(methods(self.schema)))
        self.assertEqual(sum(result['categories'].values()), len(methods(self.schema)))
        self.assertEqual(result['native_methods_executed'], 0)
        self.assertFalse(result['source_bytes_verified'])
        self.assertEqual(result['production_allowlist'], [])
        self.assertFalse(result['authorizes_dispatch'])
        self.assertEqual(result['reviewed_runtime_methods'], list(WORKFLOW_RESPONSE_TYPES))
        self.assertFalse(result['guarantees_promoted'])

    def test_missing_duplicate_or_new_schema_method_cannot_hide_in_counts(self):
        """删项、等长替换重复项及新增未知方法都不能伪装完整覆盖。"""
        changed = deepcopy(self.matrix)
        changed['methods'].pop()
        changed['method_count'] -= 1
        with self.assertRaisesRegex(Rejected, 'method count'):
            self.checked(matrix=changed)
        changed = deepcopy(self.matrix)
        changed['methods'][-1] = deepcopy(changed['methods'][0])
        with self.assertRaisesRegex(Rejected, 'coverage'):
            self.checked(matrix=changed)
        schema = deepcopy(self.schema)
        branch = deepcopy(schema['schemas']['request']['oneOf'][0])
        branch['properties']['method']['const'] = 'unknown.read'
        schema['schemas']['request']['oneOf'].append(branch)
        with self.assertRaisesRegex(Rejected, 'method count'):
            self.checked(schema=schema)

    def test_parameter_schema_cannot_point_to_another_method_or_be_copied(self):
        """同样是 EmptyParams 也须保留该方法原生分支，不能代入相邻方法。"""
        self.row('session.snapshot')['parameter_schema'] = self.row('ping')['parameter_schema']
        with self.assertRaisesRegex(Rejected, 'pointer mismatch'):
            self.checked()
        self.setUp()
        self.row('ping')['native_parameter_ref'] = {'type': 'object'}
        with self.assertRaisesRegex(Rejected, 'parameter reference'):
            self.checked()
        self.setUp()
        self.matrix['parameter_scope'] = 'fixed note and TTL adapter subset'
        with self.assertRaisesRegex(Rejected, 'parameter scope'):
            self.checked()

    def test_duplicate_native_methods_are_rejected_before_matrix_comparison(self):
        """原生 schema 本身若重复方法，不允许用表格重复项补齐。"""
        schema = deepcopy(self.schema)
        schema['schemas']['request']['oneOf'].append(deepcopy(schema['schemas']['request']['oneOf'][0]))
        with self.assertRaisesRegex(Rejected, 'duplicate schema method'):
            methods(schema)

    def test_conditional_workflow_support_does_not_authorize_or_broaden_methods(self):
        """完整工作流标记条件实现；离线矩阵不能自授执行或扩大未实现方法。"""
        self.assertTrue(self.row('ping')['adapter_support']['local_passive_review'])
        self.assertTrue(self.row('ping')['adapter_support']['production_dispatch'])
        self.assertEqual(self.row('ping')['adapter_support']['status'], 'conditional_workflow_runtime')
        self.assertEqual(self.row('ping')['adapter_support']['runtime_policy_ref'],
                         'method-policy.json#/production_allowlist/0')
        self.assertEqual([row['method'] for row in self.matrix['methods'] if row['adapter_support']['production_dispatch']],
                         [record['method'] for record in reviewed_production_allowlist()])
        self.assertTrue(self.row('session.snapshot')['adapter_support']['codec'])
        self.assertFalse(self.row('session.snapshot')['adapter_support']['local_passive_review'])
        for name, field in [('session.snapshot', 'local_passive_review'), ('events.subscribe', 'codec'),
                            ('server.stop', 'production_dispatch'), ('plugin.list', 'production_dispatch')]:
            with self.subTest(method=name, field=field):
                changed = deepcopy(self.matrix)
                row = next(row for row in changed['methods'] if row['method'] == name)
                row['adapter_support'][field] = True
                with self.assertRaisesRegex(Rejected, 'support or permission'):
                    self.checked(matrix=changed)
        self.matrix['production_allowlist'] = [{'method': 'ping', 'params': {}}]
        with self.assertRaisesRegex(Rejected, 'production scope'):
            self.checked()
        self.setUp()
        self.matrix['authorizes_dispatch'] = True
        with self.assertRaisesRegex(Rejected, 'production permission'):
            self.checked()
        self.setUp()
        self.row('ping')['adapter_support']['runtime_policy_ref'] = 'untrusted.json'
        with self.assertRaisesRegex(Rejected, 'support or permission'):
            self.checked()
        self.setUp()
        self.row('session.snapshot')['adapter_support']['local_passive_review'] = 0
        with self.assertRaisesRegex(Rejected, 'support or permission'):
            self.checked()

    def test_workspace_metadata_retains_native_write_source_boundaries(self):
        """完整原生元数据参数不是被动读，须保留源码的前置、序号、TTL 与持久化边界。"""
        row = self.row('workspace.report_metadata')
        self.assertTrue(row['adapter_support']['codec'])
        self.assertFalse(row['adapter_support']['local_passive_review'])
        self.assertTrue(row['adapter_support']['production_dispatch'])
        self.assertEqual(row['adapter_support']['runtime_policy_ref'], 'method-policy.json#/production_allowlist/' +
                         str(list(WORKFLOW_RESPONSE_TYPES).index('workspace.report_metadata')))
        self.assertEqual(row['adapter_support']['status'], 'conditional_workflow_runtime')
        self.assertEqual(row['review_scope'], 'complete_native_request_root')
        for name in ('session.snapshot', 'workspace.create', 'workspace.get'):
            self.assertTrue(self.row(name)['adapter_support']['production_dispatch'])
            self.assertFalse(self.row(name)['adapter_support']['local_passive_review'])
        for name in ('normalize_source', 'normalize_ttl', 'normalize_tokens', 'sequence_freshness',
                     'sequence_acceptance', 'token_patch', 'token_expiry', 'shared_expiry_sweep',
                     'metadata_event', 'pending_title_prelude', 'workspace_event_payload',
                     'workspace_label_resolution', 'persisted_workspace_shape', 'restore_sequence_reset',
                     'restore_tokens_reset'):
            self.assertIn(row['source_refs'][name], self.matrix['source_anchors'])
        changed = deepcopy(self.matrix)
        metadata = next(row for row in changed['methods'] if row['method'] == 'workspace.report_metadata')
        metadata['adapter_support']['local_passive_review'] = True
        with self.assertRaisesRegex(Rejected, 'support or permission'):
            self.checked(matrix=changed)

    def test_metadata_missing_or_mismatched_source_boundaries_are_rejected(self):
        """删去 TTL/恢复来源或替换成别的函数引用，都不能通过默认离线审计。"""
        self.row('workspace.report_metadata')['source_refs'].pop('shared_expiry_sweep')
        with self.assertRaisesRegex(Rejected, 'metadata source boundary'):
            self.checked()
        self.setUp()
        self.row('workspace.report_metadata')['source_refs']['sequence_acceptance'] = self.row('ping')['source_refs']['implementation']
        with self.assertRaisesRegex(Rejected, 'metadata source boundary'):
            self.checked()

    def test_every_workflow_result_has_native_success_source(self):
        """方法对应原生成功类型，等待与创建不能用近似通用类型代替。"""
        native_types = {branch['properties']['type']['const'] for branch in
                        self.schema['schemas']['success_response']['$defs']['ResponseResult']['oneOf']}
        for row in self.matrix['methods']:
            expected = WORKFLOW_RESPONSE_TYPES.get(row['method'], [])
            with self.subTest(method=row['method']):
                self.assertEqual(row['native_success_types'], expected)
                self.assertTrue(set(expected) <= native_types)
                for value in expected:
                    key = row['source_refs']['success_' + value]
                    variant = ''.join(part[0].upper() + part[1:] for part in value.split('_'))
                    self.assertIn('ResponseResult::' + variant, self.matrix['source_anchors'][key])
        self.assertEqual(self.row('agent.wait')['native_success_types'], ['agent_info'])
        self.assertEqual(self.row('agent.read')['native_success_types'], ['pane_read'])
        self.assertEqual(self.row('workspace.create')['native_success_types'], ['workspace_created'])
        self.assertEqual(self.row('tab.create')['native_success_types'], ['tab_created'])

    def test_invented_result_type_or_missing_success_source_is_rejected(self):
        """不能发明模型完成类型，删去构造 helper 或拿错 variant 源码冒充成功类型。"""
        self.row('agent.wait')['native_success_types'] = ['wait_matched']
        with self.assertRaisesRegex(Rejected, 'native success type'):
            self.checked()
        self.setUp()
        self.row('agent.wait')['source_refs'].pop('success_agent_info')
        with self.assertRaisesRegex(Rejected, 'missing native success source'):
            self.checked()
        self.setUp()
        self.row('agent.wait')['source_refs']['success_agent_info'] = self.row('ping')['source_refs']['success_pong']
        with self.assertRaisesRegex(Rejected, 'native success source mismatch'):
            self.checked()
        self.setUp()
        self.row('agent.wait')['source_refs'].pop('success_constructor')
        with self.assertRaisesRegex(Rejected, 'missing native success constructor'):
            self.checked()
        self.setUp()
        self.row('workspace.create')['source_refs']['success_constructor'] = self.row('tab.create')['source_refs']['success_constructor']
        with self.assertRaisesRegex(Rejected, 'native success constructor mismatch'):
            self.checked()
        self.setUp()
        self.row('agent.prompt')['source_refs'].pop('prompt_wait_success')
        with self.assertRaisesRegex(Rejected, 'missing native prompt wait success'):
            self.checked()
        self.setUp()
        schema = deepcopy(self.schema)
        variants = schema['schemas']['success_response']['$defs']['ResponseResult']['oneOf']
        variants[:] = [branch for branch in variants if branch['properties']['type']['const'] != 'agent_info']
        with self.assertRaisesRegex(Rejected, 'native success type absent from schema'):
            self.checked(schema=schema)

    def test_stream_and_endpoint_transports_cannot_be_flattened(self):
        """事件流、SSH 注册连接和客户端专属命令均不得冒充普通一次响应。"""
        for name in ('events.subscribe', 'server.ssh_agent.register', 'client_shell.surface.set'):
            with self.subTest(method=name):
                changed = deepcopy(self.matrix)
                row = next(row for row in changed['methods'] if row['method'] == name)
                row['transport'] = 'json_socket_one_response_then_close'
                with self.assertRaisesRegex(Rejected, 'transport mismatch'):
                    self.checked(matrix=changed)

    def test_read_name_does_not_remove_side_effect_risk_or_add_guarantees(self):
        """读取前缀、prompt 状态或复制的 UHP 保证都不能放宽当前边界。"""
        self.row('pane.read')['risk_boundaries'] = []
        with self.assertRaisesRegex(Rejected, 'risk classification'):
            self.checked()
        self.setUp()
        self.row('agent.prompt')['unavailable_bridge_guarantees'].remove('run_correlated_prompt_completion')
        with self.assertRaisesRegex(Rejected, 'guarantee promotion'):
            self.checked()

    def test_missing_or_cross_method_source_anchors_are_rejected(self):
        """缺少分派引用或把别的方法声明指过来均无法通过离线核对。"""
        self.row('ping')['source_refs'].pop('transport_dispatch')
        with self.assertRaisesRegex(Rejected, 'dispatch evidence'):
            self.checked()
        self.setUp()
        self.row('ping')['source_refs']['declaration'] = self.row('session.snapshot')['source_refs']['declaration']
        with self.assertRaisesRegex(Rejected, 'declaration anchor'):
            self.checked()

    def test_supplied_source_tree_must_match_recorded_file_bytes(self):
        """提供源码目录时，改动的整文件摘要必须先于行号与覆盖再生校验被拒绝。"""
        first = next(iter(self.matrix['source_anchors']))
        relative = first.split('#', 1)[0]
        with tempfile.TemporaryDirectory(prefix='herdr-method-source-') as directory:
            path = Path(directory) / relative
            path.parent.mkdir(parents=True)
            path.write_text('// 合成变更；从不执行\n')
            with self.assertRaisesRegex(Rejected, 'source file hash'):
                self.checked(tree=Path(directory))


if __name__ == '__main__':
    unittest.main()
