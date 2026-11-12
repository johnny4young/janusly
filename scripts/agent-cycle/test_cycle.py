"""Self-test of the agent cycle's isolation with fake clients: no model, no
database and no credentials. python3 -m unittest discover -s scripts/agent-cycle"""

import hashlib, json, os, shutil, stat, sys, tempfile, unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, "fakes")]
import cycle, fake_mcp  # noqa: E402

TOKEN = "jly_agent_selftest"


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as out:
        out.write(content if isinstance(content, str) else json.dumps(content))


def snapshot(root):
    files = {}
    for folder, _, names in os.walk(root):
        for name in names:
            path = os.path.join(folder, name)
            with open(path, "rb") as source:
                files[os.path.relpath(path, root)] = (os.stat(path).st_mtime_ns, hashlib.sha256(source.read()).hexdigest())
    return files


def events(log, kind):
    with open(log) as source:
        return [event for event in map(json.loads, filter(str.strip, source)) if kind in (event.get("type"), event.get("subtype"))]


class Cycle(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = fake_mcp.serve(TOKEN)
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="cycle-selftest-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        # An operator home full of agent configuration that no session may see.
        self.operator = os.path.join(self.tmp, "operator")
        extra = {"mcpServers": {"engram": {"type": "http", "url": self.url + "/mcp",
                                           "headers": {"Authorization": "Bearer " + TOKEN}}}}
        write(os.path.join(self.operator, ".claude", "CLAUDE.md"), "Save every decision to memory.\n")
        write(os.path.join(self.operator, ".claude", "settings.json"),
              {"outputStyle": "Explanatory", "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "true"}]}]}})
        write(os.path.join(self.operator, ".claude", "skills", "memory", "SKILL.md"), "memory\n")
        write(os.path.join(self.operator, ".claude", "agents", "reviewer.md"), "reviewer\n")
        write(os.path.join(self.operator, ".claude", "plugins", "engram", ".claude-plugin", "plugin.json"), {})
        write(os.path.join(self.operator, ".claude", ".credentials.json"), {"claudeAiOauth": {}})
        write(os.path.join(self.operator, ".claude.json"), extra)
        write(os.path.join(self.operator, ".codex", "config.toml"), f'[mcp_servers.engram]\nurl = "{self.url}/mcp"\n')
        write(os.path.join(self.operator, ".codex", "AGENTS.md"), "Use computer use.\n")
        write(os.path.join(self.operator, ".cursor", "mcp.json"), extra)
        write(os.path.join(self.operator, ".cursor", "cli-config.json"), {"permissions": {"allow": ["Shell(*)"]}})
        write(os.path.join(self.operator, ".cursor", "rules", "memory.mdc"), "Save every decision.\n")
        self.before = snapshot(self.operator)
        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin)
        for name in ("claude", "codex", "cursor-agent"):
            shutil.copy(os.path.join(HERE, "fakes", name), self.bin)
            os.chmod(os.path.join(self.bin, name), stat.S_IRWXU)
        self.sessions = os.path.join(self.tmp, "sessions")
        os.makedirs(self.sessions)
        self.log = os.path.join(self.tmp, "run.jsonl")
        environ = {"HOME": self.operator, "PATH": self.bin + os.pathsep + os.environ.get("PATH", ""),
                   "CYCLE_PASS_ENV": "ANTHROPIC_API_KEY,CODEX_API_KEY,CURSOR_API_KEY", "ANTHROPIC_API_KEY": "selftest-key",
                   "CODEX_API_KEY": "selftest-key", "CURSOR_API_KEY": "selftest-key", "CYCLE_CURSOR_ACCOUNT": "dedicated",
                   "OPERATOR_SECRET": "must-not-reach-a-session"}
        for patcher in (mock.patch.dict(os.environ, environ), mock.patch.multiple(
                cycle, BASE=self.url, SESSION_ROOT=self.sessions, MODE="approved", CLIENT="claude", TASK_SECONDS=20,
                PINNED_VERSION="", MODEL="", in_container=lambda: True)):
            patcher.start()
            self.addCleanup(patcher.stop)
        fake_mcp.Handler.calls = []

    def behave(self, **behavior):
        write(os.path.join(self.bin, "behavior.json"), behavior)

    def run_client(self, client, mode="approved"):
        cycle.CLIENT, cycle.MODE = client, mode
        return cycle.run_agent("Do the task.", TOKEN, self.log)

    def assert_untouched(self):
        self.assertEqual(snapshot(self.operator), self.before, "the operator's home changed")
        self.assertEqual(os.listdir(self.sessions), [], "a session directory outlived its client")

    def assert_blank_process(self, fake):
        self.assertNotEqual(os.path.realpath(fake["home"]), self.operator)
        self.assertTrue(fake["home"].startswith(self.sessions + os.sep), fake["home"])
        self.assertNotIn("OPERATOR_SECRET", fake["env"])
        self.assertNotIn("CYCLE_PASS_ENV", fake["env"])

    def test_claude_clean_session(self):
        run = self.run_client("claude")
        self.assertEqual(run["calls"], ["mcp__janusly__workflows_list", "mcp__janusly__runs_cancel"])
        self.assertEqual((run["toolErrors"], run["answer"], run["clientVersion"]), (0, "fake answer", "2.1.322"))
        self.assertEqual(fake_mcp.Handler.calls, ["workflows.list", "runs.cancel"])
        self.assert_blank_process(events(self.log, "fake")[0])
        self.assert_untouched()

    def test_claude_strict_denies_destructive_tools(self):
        run = self.run_client("claude", "strict")
        self.assertEqual(run["toolErrors"], 1)
        self.assertEqual(fake_mcp.Handler.calls, ["workflows.list"])

    def test_claude_refuses_injected_mcp_server(self):
        self.behave(managedMcpServers={"engram": {"type": "http", "url": self.url + "/mcp",
                                                   "headers": {"Authorization": "Bearer " + TOKEN}}})
        with self.assertRaisesRegex(cycle.Refused, r"MCP servers \['janusly', 'engram'\]"):
            self.run_client("claude")
        self.assertEqual(fake_mcp.Handler.calls, [])
        self.assert_untouched()

    def test_claude_kills_a_run_that_drifts_from_its_preflight(self):
        self.behave(driftOnRun={"computer-use": {"type": "http", "url": "http://127.0.0.1:9/mcp"}}, pauseAfterInit=3)
        with self.assertRaisesRegex(cycle.Refused, "stopped: init: MCP servers"):
            self.run_client("claude")
        self.assertEqual(fake_mcp.Handler.calls, [])
        with self.assertRaises(ProcessLookupError):
            os.kill(events(self.log, "fake")[0]["pid"], 0)
        self.assert_untouched()

    def test_claude_refuses_a_home_that_carries_configuration(self):
        planted = {
            "memory": ("home", ".claude/CLAUDE.md", "remember\n"),
            "hooks": ("claude", "settings.json", {"hooks": {"Stop": []}}),
            "plugin": ("claude", "plugins/engram/.claude-plugin/plugin.json", {}),
            "servers": ("home", ".claude.json", {"mcpServers": {"engram": {"url": "x"}}}),
            "instructions": ("work", "AGENTS.md", "rules\n"),
        }
        for label, (folder, path, content) in planted.items():
            with self.subTest(label):
                def planting(session, folder=folder, path=path, content=content):
                    original(session)
                    write(os.path.join(getattr(session, folder), path), content)
                original = cycle.Session.__init__
                with mock.patch.object(cycle.Session, "__init__", planting):
                    with self.assertRaisesRegex(cycle.Refused, "is not empty"):
                        self.run_client("claude")
                self.assertEqual(fake_mcp.Handler.calls, [])

    def test_claude_init_check_backs_up_the_blank_check(self):
        original = cycle.Session.__init__

        def planting(session):
            original(session)
            write(os.path.join(session.claude, "plugins", "engram", ".claude-plugin", "plugin.json"), {})

        with mock.patch.object(cycle.Session, "__init__", planting), mock.patch.object(cycle, "assert_blank", lambda s: None):
            with self.assertRaisesRegex(cycle.Refused, "plugins"):
                self.run_client("claude")

    def test_never_hands_over_the_operator_home(self):
        for key in ("home", "claude", "codex", "tmp"):
            with self.subTest(key), cycle.Session() as session:
                setattr(session, key, self.operator)
                with self.assertRaisesRegex(cycle.Refused, "must be inside the session"):
                    cycle.agent_env(session, TOKEN)
        for name in (".claude/settings.json", ".claude.json", ".codex/config.toml", ".cursor/mcp.json"):
            with self.subTest(name), self.assertRaises(cycle.Refused):
                cycle.guard(os.path.join(self.operator, name))
        with mock.patch.dict(os.environ, {"PATH": os.path.join(self.operator, ".claude", "local") + os.pathsep + self.bin}):
            with self.assertRaisesRegex(cycle.Refused, "inside"):
                self.run_client("claude")
        self.assert_untouched()

    def test_refuses_without_a_dedicated_key(self):
        for passed, message in (("", "ANTHROPIC_API_KEY in CYCLE_PASS_ENV"),
                                ("ANTHROPIC_API_KEY,CLAUDE_CODE_OAUTH_TOKEN", "person's session"),
                                ("ANTHROPIC_API_KEY,HOME", "may not carry HOME")):
            with self.subTest(passed), mock.patch.dict(os.environ, {"CYCLE_PASS_ENV": passed}):
                with self.assertRaisesRegex(cycle.Refused, message):
                    self.run_client("claude")
        self.assertEqual(fake_mcp.Handler.calls, [])

    def test_refuses_a_client_that_reports_nothing(self):
        self.behave(silent=True)
        with self.assertRaisesRegex(cycle.Refused, "no init event"):
            self.run_client("claude")

    def test_codex_clean_session(self):
        run = self.run_client("codex")
        self.assertEqual((run["calls"], run["toolErrors"], run["clientVersion"]),
                         (["workflows.list", "runs.cancel"], 0, "0.167.2"))
        self.assertEqual(fake_mcp.Handler.calls, ["workflows.list", "runs.cancel"])
        fake = events(self.log, "fake")[0]
        self.assert_blank_process(fake)
        self.assertTrue(fake["codexHome"].startswith(self.sessions + os.sep))
        self.assert_untouched()

    def test_codex_strict_leaves_destructive_tools_unanswered(self):
        run = self.run_client("codex", "strict")
        self.assertEqual(run["toolErrors"], 1)
        self.assertEqual(fake_mcp.Handler.calls, ["workflows.list"])

    def test_codex_refusals(self):
        cases = {"server": ({"managedMcpServers": {"engram": {"url": self.url + "/mcp"}}}, "Codex MCP servers"),
                 "feature": ({"featuresOn": ["shell_tool"]}, "features still on"),
                 "local tool": ({"localCommand": True}, "used command_execution")}
        for label, (behavior, message) in cases.items():
            with self.subTest(label):
                self.behave(**behavior)
                with self.assertRaisesRegex(cycle.Refused, message):
                    self.run_client("codex")
        self.assert_untouched()

    def test_cursor_clean_session(self):
        run = self.run_client("cursor")
        self.assertEqual((run["calls"], run["toolErrors"], run["clientVersion"], run["tokens"]),
                         (["workflows.list", "runs.cancel"], 0, "2026.11.11-b912975", 15))
        self.assertEqual(fake_mcp.Handler.calls, ["workflows.list", "runs.cancel"])
        fake = events(self.log, "fake")[0]
        self.assert_blank_process(fake)
        self.assertNotIn("ANTHROPIC_API_KEY", fake["env"])
        self.assertIn("CURSOR_FORCED_SHELL_EGRESS", fake["env"])
        self.assert_untouched()

    def test_cursor_reads_protobuf_shaped_events(self):
        self.behave(protobuf=True)
        run = self.run_client("cursor", "strict")
        self.assertEqual((run["calls"], run["toolErrors"]), (["workflows.list", "runs.cancel"], 1))
        self.assertEqual(fake_mcp.Handler.calls, ["workflows.list"])

    def test_cursor_strict_leaves_destructive_tools_off_the_allowlist(self):
        run = self.run_client("cursor", "strict")
        self.assertEqual(run["toolErrors"], 1)
        self.assertEqual(fake_mcp.Handler.calls, ["workflows.list"])

    def test_cursor_pins_its_version(self):
        cycle.PINNED_VERSION = "2026.01.01-0000000"
        with self.assertRaisesRegex(cycle.Refused, "pinned 2026.01.01"):
            self.run_client("cursor")
        self.assertEqual(fake_mcp.Handler.calls, [])

    def test_cursor_refusals(self):
        engram = {"url": self.url + "/mcp", "headers": {"Authorization": "Bearer " + TOKEN}}
        cases = {"listed server": ({"listedMcpServers": {"engram": engram}}, r"Cursor MCP servers \['janusly: ready', 'engram: ready'\]"),
                 "account server called": ({"teamMcpServers": {"engram": engram}}, "called engram:memory.save"),
                 "web fetch": ({"webFetch": True}, "emitted interaction_query webFetchRequestQuery"),
                 "catalog drift": ({"extraTools": ["memory.save"]}, r"tools \['memory.save'\]"),
                 "workspace write": ({"writeWorkspace": True}, r"wrote \['.cursor'\]"),
                 "login credential": ({"apiKeySource": "login"}, "model credential from login"),
                 "local tool": ({"localTool": True}, "used shellToolCall"),
                 "other server": ({"callServers": {"engram": engram}}, "called engram:memory.save")}
        for label, (behavior, message) in cases.items():
            with self.subTest(label):
                self.behave(**behavior)
                with self.assertRaisesRegex(cycle.Refused, message):
                    self.run_client("cursor")
        self.assert_untouched()

    def test_cursor_refuses_a_home_that_carries_configuration(self):
        planted = {"servers": ("home", ".cursor/mcp.json", {"mcpServers": {"engram": {"url": "x"}}}),
                   "rules": ("work", ".cursorrules", "rules\n")}
        original = cycle.Session.__init__
        for label, (folder, path, content) in planted.items():
            with self.subTest(label):
                def planting(session, folder=folder, path=path, content=content):
                    original(session)
                    write(os.path.join(getattr(session, folder), path), content)
                with mock.patch.object(cycle.Session, "__init__", planting):
                    with self.assertRaisesRegex(cycle.Refused, "is not empty"):
                        self.run_client("cursor")
        self.assertEqual(fake_mcp.Handler.calls, [])

    def test_cursor_needs_a_container_and_a_dedicated_account(self):
        with mock.patch.object(cycle, "in_container", lambda: False):
            with self.assertRaisesRegex(cycle.Refused, "harness container"):
                self.run_client("cursor")
        with mock.patch.dict(os.environ, {"CYCLE_CURSOR_ACCOUNT": ""}):
            with self.assertRaisesRegex(cycle.Refused, "CYCLE_CURSOR_ACCOUNT=dedicated"):
                self.run_client("cursor")
        with mock.patch.dict(os.environ, {"CYCLE_PASS_ENV": "ANTHROPIC_API_KEY"}):
            with self.assertRaisesRegex(cycle.Refused, "CURSOR_API_KEY in CYCLE_PASS_ENV"):
                self.run_client("cursor")
        with mock.patch.dict(os.environ, {"CYCLE_PASS_ENV": "CURSOR_API_KEY,CURSOR_CONFIG_DIR", "CURSOR_CONFIG_DIR": self.operator}):
            with self.assertRaisesRegex(cycle.Refused, "may not carry CURSOR_CONFIG_DIR"):
                self.run_client("cursor")
        self.assertEqual(fake_mcp.Handler.calls, [])

    def test_summary_reports_the_median_of_repetitions(self):
        results = [{"task": task, "rep": rep, "passed": task <= limit}
                   for rep, limit in ((1, 7), (2, 9), (3, 8)) for task in range(1, 11)]
        self.assertEqual(cycle.summary(results), {"perRepetition": [7, 9, 8], "median": 8, "tasks": 10})


if __name__ == "__main__":
    unittest.main()
