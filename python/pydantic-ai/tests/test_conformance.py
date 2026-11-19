"""一致性测试：``ctx-pydantic-ai conformance`` 起的服务，用 TypeScript 的 ``ctx-conformance`` 跑 harness 契约。

和 ``ctx-remote``、``ctx-claude-code`` 跑的是同一套用例（``describeHarnessContract``），经线上协议，六个等级都跑。
"""

from __future__ import annotations

import subprocess

from conftest import REPO, SOURCE_CONDITION, child_env, serve

LEVELS = 'trace,execute,resume,context,output,approval'


def test_the_harness_contract_passes_over_the_wire(node: str) -> None:
    server = serve('conformance', '--token', 'conformance-token')
    try:
        done = subprocess.run(
            [
                node,
                SOURCE_CONDITION,
                str(REPO / 'packages/remote/src/cli.ts'),
                '--url',
                server.url,
                '--token',
                'conformance-token',
                '--components',
                'harness',
                '--harness-levels',
                LEVELS,
            ],
            capture_output=True,
            text=True,
            encoding='utf-8',
            cwd=REPO,
            env=child_env(),
            timeout=600,
            check=False,
        )
    finally:
        errors = server.stderr()
        server.stop()
    summary = [line for line in done.stdout.splitlines() if line.startswith('# ')]
    assert done.returncode == 0, '\n'.join([*summary, done.stdout[-6000:], done.stderr[-2000:], errors[-2000:]])
    assert '# fail 0' in summary
    assert not any(line.startswith('# pass 0') for line in summary)
