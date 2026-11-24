import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch

from scripts import h3_adherence_rsi as rsi


def timeline():
    rows = []
    for frame in range(0, rsi.FRAMES, 3):
        t = frame / rsi.FPS
        left = min(1, max(0, (t - .6) / 1.4))
        right = min(1, max(0, (t - 2.7) / 1.95))
        rows.append((t, [rsi.RED], [rsi.RIGHT + (rsi.MIDDLE - rsi.RIGHT) * (left - right)]))
    return rows


class ScoreTests(unittest.TestCase):
    def test_full_compliance_and_selective_failures(self):
        rows = timeline()
        self.assertTrue(all(rsi.score(rows)["checks"].values()))
        rows[4][2][0] -= .03
        self.assertFalse(rsi.score(rows)["checks"]["start"])
        rows[26][2][0] -= .1
        self.assertFalse(rsi.score(rows)["checks"]["monotone"])
        rows[20][1].append(.1)
        self.assertFalse(rsi.score(rows)["checks"]["objects"])

    def test_reference_disks_are_detected(self):
        with TemporaryDirectory() as folder:
            path = Path(folder) / "fixture.png"
            rsi.fixture(path, rsi.MIDDLE)
            rgb = rsi.cv2.cvtColor(rsi.cv2.imread(str(path)), rsi.cv2.COLOR_BGR2RGB)
            red, blue = rsi.disk_centers(rgb)
            self.assertEqual((len(red), len(blue)), (1, 1))
            self.assertAlmostEqual(red[0], rsi.RED, places=2)
            self.assertAlmostEqual(blue[0], rsi.MIDDLE, places=2)


class ImprovementTests(unittest.TestCase):
    def run_trial(self, gains, holdout=(3,)):
        fixed = timeline()
        early = timeline()
        early[4][2][0] -= .03
        render = Mock(side_effect=lambda strategy, seed: (strategy.name, seed))
        with patch.object(rsi, "measurements", side_effect=lambda key: fixed if key in gains else early):
            report = rsi.improve(render, [2], [holdout], Mock())
        return report, [call.args[1] for call in render.call_args_list]

    def test_dev_rejection_does_not_open_holdout(self):
        report, seeds = self.run_trial(set())
        self.assertEqual(seeds, [2, 2])
        self.assertEqual(report["rounds"][0]["decision"], "development rejected")
        self.assertIsNone(report["recommended"])

    def test_holdout_has_to_replicate_development_gain(self):
        rejected, _ = self.run_trial({("timed", 2)})
        self.assertEqual(rejected["rounds"][0]["decision"], "holdout rejected")
        self.assertIsNone(rejected["recommended"])
        accepted, seeds = self.run_trial({("timed", 2), ("timed", 3)})
        self.assertEqual(seeds, [2, 2, 3, 3])
        self.assertEqual(accepted["recommended"], "timed")

    def test_one_regression_blocks_a_gain(self):
        control = {2: {"checks": {"start": False, "hold": True}}}
        trial = {2: {"checks": {"start": True, "hold": False}}}
        self.assertFalse(rsi.compare(control, trial)["pass"])

    def test_replay_never_recommends_and_holdout_must_be_disjoint(self):
        replay, _ = self.run_trial({("timed", 2)}, holdout=None)
        self.assertIsNone(replay["recommended"])
        with self.assertRaises(ValueError):
            rsi.improve(Mock(), [2], [[2]], Mock())


class LiveRendererTests(unittest.TestCase):
    def test_idle_live_render_pins_frames_without_altering_prompt(self):
        calls = []

        def reply(request, **_):
            calls.append(request)
            payloads = {
                "/status": {"ready": True},
                "/jobs": {"id": "test"},
                "/jobs?ids=test": {"test": {"state": "done"}},
            }
            if request.data:
                Path(json.loads(request.data)["out"]).touch()
            response = Mock()
            response.__enter__ = Mock(return_value=Mock(read=lambda: json.dumps(
                payloads[request.full_url.removeprefix("http://127.0.0.1:8189")]).encode()))
            response.__exit__ = Mock(return_value=False)
            return response

        with TemporaryDirectory() as folder, patch.object(rsi, "urlopen", side_effect=reply):
            render = rsi.live_renderer(Path(folder), 8189)
            render(rsi.Strategy(timed=True), 2)
            render(rsi.Strategy(timed=True, anchors=True), 2)
            render(rsi.Strategy(timed=True), 2)
            posted = [json.loads(request.data) for request in calls if request.data]
            self.assertEqual(len(posted), 2)
            self.assertEqual(posted[0]["prompt"], posted[1]["prompt"])
            self.assertEqual([k["frame"] for k in posted[0]["keyframes"]], [0])
            self.assertEqual([k["frame"] for k in posted[1]["keyframes"]], [0, 12, 54, 112])
            self.assertEqual(posted[0]["seed"], posted[1]["seed"])

    def test_live_render_does_not_submit_on_a_busy_engine(self):
        response = Mock()
        response.__enter__ = Mock(return_value=Mock(read=lambda: b'{"ready":true,"queue":1}'))
        response.__exit__ = Mock(return_value=False)
        with TemporaryDirectory() as folder, patch.object(rsi, "urlopen", return_value=response) as http:
            render = rsi.live_renderer(Path(folder), 8189)
            with self.assertRaisesRegex(RuntimeError, "busy"):
                render(rsi.Strategy(), 2)
            self.assertEqual(http.call_count, 1)
