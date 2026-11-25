from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "bin" / "google-agent-kit"


def load_cli():
    loader = importlib.machinery.SourceFileLoader("google_agent_kit_cli", str(CLI))
    spec = importlib.util.spec_from_loader("google_agent_kit_cli", loader)
    assert spec is not None
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


class UnifiedCliTests(unittest.TestCase):
    def test_doctor_json_schema(self) -> None:
        proc = subprocess.run([sys.executable, str(CLI), "doctor", "--json"], capture_output=True, text=True, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        data = json.loads(proc.stdout)
        self.assertEqual(set(data["modules"].keys()), {"gemini-web", "aistudio", "gemini-api", "colab"})

    def test_install_skills_symlink_and_copy(self) -> None:
        mod = load_cli()
        with tempfile.TemporaryDirectory() as td:
            link_dir = Path(td) / "links"
            res_link = mod.install_skills([link_dir], copy=False)
            self.assertEqual(len(res_link), len(mod.SKILL_NAMES))
            for name in mod.SKILL_NAMES:
                self.assertTrue((link_dir / name).is_symlink())
                self.assertTrue((link_dir / name / "SKILL.md").is_file())

            copy_dir = Path(td) / "copies"
            res_copy = mod.install_skills([copy_dir], copy=True)
            self.assertEqual(len(res_copy), len(mod.SKILL_NAMES))
            for name in mod.SKILL_NAMES:
                self.assertFalse((copy_dir / name).is_symlink())
                self.assertTrue((copy_dir / name / "SKILL.md").is_file())


if __name__ == "__main__":
    unittest.main()
