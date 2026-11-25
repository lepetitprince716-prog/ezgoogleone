from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import gemini_api as ga


class GeminiApiTests(unittest.TestCase):
    def test_model_aliases_and_path_denylist(self) -> None:
        self.assertEqual(ga.resolve_model("neon"), "gemini-4-neon")
        self.assertEqual(ga.resolve_model("carbon"), "gemini-4-carbon")
        self.assertEqual(ga.resolve_model("custom-model-1"), "custom-model-1")

        with tempfile.TemporaryDirectory() as td:
            blocked = Path(td) / "restricted" / "note.txt"
            blocked.parent.mkdir()
            blocked.write_text("secret", encoding="utf-8")
            with self.assertRaises(ga.PathBoundaryError):
                ga.check_file_path(blocked, deny_dirs={"restricted"})
            self.assertEqual(ga.check_file_path(blocked, deny_dirs=set()), blocked.resolve())

    def test_run_generate_extracts_text_thoughts_and_grounding(self) -> None:
        fake_resp = {
            "candidates": [
                {
                    "finishReason": "STOP",
                    "content": {
                        "parts": [
                            {"thought": True, "text": "thinking"},
                            {"text": "Final answer."},
                        ]
                    },
                    "groundingMetadata": {
                        "groundingChunks": [
                            {"web": {"uri": "https://example.org/doc", "title": "Example Doc"}},
                            {"web": {"uri": "https://example.org/doc", "title": "Duplicate"}},
                        ]
                    },
                }
            ],
            "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5, "totalTokenCount": 15},
        }
        with mock.patch.object(ga, "post_json", return_value=fake_resp) as m:
            res = ga.run_generate(prompt="hello", model="hydrogen", search=True, api_key="test-key")
        self.assertEqual(res["model"], "gemini-4-hydrogen")
        self.assertEqual(res["text"], "Final answer.")
        self.assertEqual(res["thoughts"], "thinking")
        self.assertEqual(res["grounding_sources"], [{"title": "Example Doc", "uri": "https://example.org/doc"}])
        called_payload = m.call_args.args[1]
        self.assertEqual(called_payload["tools"], [{"google_search": {}}])

    def test_run_decision_validates_and_caches(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            cache = Path(td) / "cache.jsonl"
            fake_resp = {"answers": {"choice": {"choice": "a", "probability": 0.91}}, "usage": {"prompt_tokens": 12}}
            with mock.patch.object(ga, "post_json", return_value=fake_resp) as m:
                r1 = ga.run_decision(prompt="pick", choices=["a=first", "b=second"], api_key="test-key", cache_path=cache)
                r2 = ga.run_decision(prompt="pick", choices=["a=first", "b=second"], api_key="test-key", cache_path=cache)
            self.assertEqual(m.call_count, 1)
            self.assertFalse(r1["cached"])
            self.assertTrue(r2["cached"])
            self.assertEqual(r2["answers"]["choice"]["choice"], "a")

    def test_run_decision_safety_block_raises(self) -> None:
        with mock.patch.object(ga, "post_json", return_value={"error": {"code": "SAFETY", "message": "blocked"}}):
            with self.assertRaises(ga.SafetyBlockError):
                ga.run_decision(prompt="test", noul_question="safe?", api_key="test-key")

    def test_resolve_api_key_prefers_env_then_file(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            kf = Path(td) / "api_key"
            kf.write_text("file-key-val\n", encoding="utf-8")
            with mock.patch.dict(os.environ, {"GEMINI_API_KEY": ""}, clear=False):
                self.assertEqual(ga.resolve_api_key(kf), "file-key-val")
            with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "env-key-val"}, clear=False):
                self.assertEqual(ga.resolve_api_key(kf), "env-key-val")


if __name__ == "__main__":
    unittest.main()
