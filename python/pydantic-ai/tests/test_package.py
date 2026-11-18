"""发到 PyPI 的包本身：许可证和仓库根的一样，README 里的链接在 PyPI 上点得开。"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parent.parent
#: 仓库根；从 sdist 里跑测试时没有。
ROOT = PACKAGE.parent.parent
REPOSITORY = 'https://github.com/modelctx-ai/ctx/blob/main/'


def in_repository() -> bool:
    return (ROOT / 'pnpm-workspace.yaml').is_file()


def test_the_license_is_the_repository_license() -> None:
    if not in_repository():
        pytest.skip('not in the repository checkout')
    assert (PACKAGE / 'LICENSE').read_bytes() == (ROOT / 'LICENSE').read_bytes()


def pypi_readme() -> str:
    """照 pyproject.toml 里 fancy-pypi-readme 的配置，PyPI 上显示的 README。"""
    hooks = tomllib.loads((PACKAGE / 'pyproject.toml').read_text('utf-8'))['tool']['hatch']['metadata']['hooks']
    config = hooks['fancy-pypi-readme']
    text = ''.join((PACKAGE / fragment['path']).read_text('utf-8') for fragment in config['fragments'])
    for substitution in config['substitutions']:
        text = re.sub(substitution['pattern'], substitution['replacement'], text)
    return text


def test_readme_links_work_on_pypi() -> None:
    links = re.findall(r'\]\(([^)\s]+)\)', pypi_readme())
    assert links, 'the README has no links: is the pattern still right?'
    for link in links:
        assert re.match(r'(https?://|mailto:|#)', link), link
        if link.startswith(REPOSITORY) and in_repository():
            # 指到仓库里的文件要真的有：GitHub 上 main 的同一个路径。
            target = link.removeprefix(REPOSITORY).split('#')[0]
            assert '..' not in target.split('/'), link
            assert (ROOT / target).exists(), link
