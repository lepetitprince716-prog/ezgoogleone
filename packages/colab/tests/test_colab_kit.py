from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import colab_kit as ck


class ColabKitTests(unittest.TestCase):
    def test_places_auth_before_subcommand(self) -> None:
        cmd = ck.build_colab_cmd("run", ["--gpu", "A100", "train.py"], auth="adc", colab_bin="/usr/local/bin/colab")
        self.assertEqual(cmd, ["/usr/local/bin/colab", "--auth=adc", "run", "--gpu", "A100", "train.py"])

    def test_rejects_bad_auth_or_unknown_command(self) -> None:
        with self.assertRaises(ValueError):
            ck.build_colab_cmd("usage", [], auth="invalid", colab_bin="/usr/local/bin/colab")
        with self.assertRaises(ValueError):
            ck.build_colab_cmd("bogus", [], auth="adc", colab_bin="/usr/local/bin/colab")

    def test_denylist_blocks_restricted_local_path(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "restricted" / "train.py"
            p.parent.mkdir()
            p.write_text("print(1)\n", encoding="utf-8")
            with mock.patch.dict(os.environ, {"COLAB_KIT_DENY_DIRS": "restricted"}, clear=False):
                with self.assertRaises(ValueError):
                    ck.check_denied_paths(["--gpu", "A100", str(p)])

    def test_doctor_reports_missing_adc_cleanly(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            missing_adc = Path(td) / "missing.json"
            with mock.patch.dict(os.environ, {"GOOGLE_APPLICATION_CREDENTIALS": str(missing_adc)}, clear=False):
                with mock.patch("shutil.which", side_effect=lambda x: f"/usr/bin/{x}" if x == "colab" else None):
                    rep = ck.doctor_report()
            self.assertFalse(rep["ok"])
            self.assertFalse(rep["adc_present"])
            self.assertEqual(rep["colab"], "/usr/bin/colab")


if __name__ == "__main__":
    unittest.main()
