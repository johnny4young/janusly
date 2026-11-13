"""Agent cycle: ten EN/ES tasks, each from a blank agent session against
Janusly's remote MCP, scored from the database and the final answer. The
harness plays the only person: it approves publish requests.

Each client process gets a throwaway home, configuration and working
directory, only the janusly MCP server, and a model key from the environment.
A preflight reads what the client loaded and refuses the cycle when it is not
blank. Needs a running executable with JANUSLY_MCP_HTTP_ENABLED=true,
JANUSLY_MCP_WRITES_ENABLED=true and ALLOW_PRIVATE_HTTP_TARGETS=true (the
redrive task calls a local simulator), development headers enabled, and a
psql command for its database. See docs/development.md."""

import base64, hashlib, http.server, json, os, pwd, re, shlex, shutil, signal, socket, statistics, subprocess, sys, tempfile, threading, time, urllib.request, uuid

HERE = os.environ.get("CYCLE_OUT", os.path.join(os.getcwd(), "output", "agent-cycle"))
BASE = os.environ.get("CYCLE_BASE_URL", "http://127.0.0.1:3001")
DB = shlex.split(os.environ.get("CYCLE_PSQL", "psql postgres://janusly:janusly-local@127.0.0.1:15473/janusly")) + [
    "-At", "-v", "ON_ERROR_STOP=1"]
SIM_PORT = int(os.environ.get("CYCLE_SIM_PORT", "23490"))
CLIENT = os.environ.get("CYCLE_CLIENT", "codex")
MODE = os.environ.get("CYCLE_MODE", "approved")
REPEAT = int(os.environ.get("CYCLE_REPEAT", "1"))
MODEL = os.environ.get("CYCLE_MODEL", "")
PINNED_VERSION = os.environ.get("CYCLE_CLIENT_VERSION", "")
MAX_BUDGET_USD = os.environ.get("CYCLE_MAX_BUDGET_USD", "")
TASK_SECONDS = int(os.environ.get("CYCLE_TASK_SECONDS", "1200"))
SESSION_ROOT = os.environ.get("CYCLE_TMP") or None
STAMP = time.strftime("%Y%m%d%H%M%S")
active_orgs = set()
approvals = []


def sql(statement, *args):
    # Values travel as psql variables, never spliced into the SQL text.
    parts, variables = statement.split("%s"), []
    text = parts[0]
    for index, (arg, rest) in enumerate(zip(args, parts[1:])):
        variables += ["-v", f"a{index}={arg}"]
        text += f":'a{index}'" + rest
    out = subprocess.run(DB + variables, input=text.encode(), capture_output=True)
    if out.returncode:
        raise RuntimeError(out.stderr.decode())
    return out.stdout.decode().strip()


def api(method, path, org, user, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"content-type": "application/json", "x-org-id": org, "x-user-id": user})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.loads(res.read() or b"null")
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"null")


def new_org(task):
    org, owner = f"t{task}-{STAMP}-{uuid.uuid4().hex[:6]}", f"owner-{task}"
    token = "jly_agent_" + base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=")
    digest = hashlib.sha256(token.encode()).hexdigest()
    sql(f"""INSERT INTO org_members (id, org_id, user_id, role) VALUES (%s, %s, %s, 'admin');
INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
VALUES (%s, %s, 'mcp.writeConsent', 'true', 'mcp', 'harness', 'boolean');
INSERT INTO agent_clients (id, org_id, name, capabilities, token_digest, token_last4, created_by, expires_at)
VALUES (%s, %s, 'harness agent', ARRAY['read','propose','test','publish','operate'], decode(%s, 'hex'), %s, %s, now() + interval '1 day');""",
        str(uuid.uuid4()), org, owner, str(uuid.uuid4()), org, str(uuid.uuid4()), org, digest, token[-4:], owner)
    active_orgs.add((org, owner))
    return org, owner, token


def save(org, owner, doc):
    status, body = api("POST", "/workflows/save", org, owner, doc)
    assert status == 200, (status, body)


def start(org, owner, doc, payload=None):
    status, body = api("POST", "/v1/start", org, owner, {"workflow": doc, "input": payload or {}})
    assert status in (200, 202), (status, body)
    return body["data"]["runId"]


def wait_run(run_id, statuses, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = sql("SELECT status FROM runs WHERE id = %s", run_id)
        if status in statuses:
            return status
        waiting = sql("SELECT count(*) FROM run_nodes WHERE run_id = %s AND status = 'waiting'", run_id)
        if "waiting" in statuses and waiting not in ("", "0"):
            return "waiting"
        time.sleep(0.3)
    raise RuntimeError(f"run {run_id} never reached {statuses}")


def doc(wid, name, nodes, edges=None, outputs=None):
    d = {"id": wid, "name": name, "dslVersion": "1.0", "nodes": nodes, "edges": edges or []}
    if outputs:
        d["outputs"] = outputs
    return d


# --- simulated upstream for the redrive task -------------------------------
class Sim(http.server.BaseHTTPRequestHandler):
    healthy = False

    def do_GET(self):
        code = 200 if Sim.healthy else 503
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"inStock": 7} if Sim.healthy else {"error": "down"}).encode())

    def log_message(self, *args):
        pass


PURE_TYPES = {"transform", "condition", "noop", "router", "parallel_fork", "join", "wait_until", "approval",
              "human_form", "schedule"}
PURE_TOOLS = {"text.uppercase", "json.parse", "json.pick", "json.set", "json.merge", "csv.parse", "csv.filter",
              "csv.stringify", "time.now", "time.window"}


def approvable(proposed):
    """The harness approves only what the tasks need: pure steps and a
    schedule. Anything that reaches out stays unapproved, so a session cannot
    point the local stack at the operator's network."""
    if not isinstance(proposed, dict) or not proposed.get("nodes"):
        return False
    for node in proposed["nodes"]:
        kind, config = node.get("type"), node.get("config") or {}
        if kind == "tool" and config.get("tool") in PURE_TOOLS:
            continue
        if kind not in PURE_TYPES or "secret" in json.dumps(config).lower():
            return False
    return True


def approver(stop):
    while not stop.is_set():
        for org, owner in list(active_orgs):
            try:
                review(org, owner)
            except Exception as err:  # one failed poll must not stop the person for every later task
                approvals.append({"org": org, "error": repr(err)})
        stop.wait(2)


def review(org, owner):
    status, body = api("GET", "/publish-requests?status=pending", org, owner)
    for request in (body or {}).get("requests", []) if status == 200 else []:
        code, detail = api("GET", f"/publish-requests/{request['id']}", org, owner)
        if code != 200 or not isinstance((detail or {}).get("proposed"), dict):
            continue  # never approve a draft the harness could not inspect
        verb = "approve" if approvable(detail["proposed"]) else "reject"
        code, result = api("POST", f"/publish-requests/{request['id']}/{verb}", org, owner)
        approvals.append({"org": org, "request": request["id"], "reasons": request.get("reasons"), "decision": verb, "status": code,
                          "result": (result or {}).get("code") or (result or {}).get("request", {}).get("status")})


# --- tasks -----------------------------------------------------------------
def run_status(org, name, expect_output=None):
    rows = sql("""SELECT r.status, coalesce(r.output_json::text, '') FROM runs r JOIN workflows w ON w.id = r.workflow_id AND w.org_id = r.org_id
WHERE r.org_id = %s AND w.name ILIKE %s AND r.replay_mode IS NULL ORDER BY r.created_at DESC""", org, name)
    for line in rows.splitlines():
        status, output = line.split("|", 1)
        if status != "succeeded":
            continue
        if expect_output is None or expect_output(json.loads(output or "{}")):
            return True
    return False


def setup_greeter(org, owner):
    return ("In Janusly, create a workflow named \"Greeter\" that takes an input `name` and returns `greeting`: "
            "\"HELLO, \" followed by the name in uppercase. Get it through Janusly's publish gate and published "
            "(a person approves publish requests within a minute), run it with name \"ada\", and tell me the greeting.")


def check_greeter(org, answer):
    return run_status(org, "greeter", lambda out: str(out.get("greeting", "")).strip() == "HELLO, ADA")


def setup_saludo(org, owner):
    return ("En Janusly, crea un workflow llamado \"Saludo\" que reciba `nombre` e `idioma` (\"es\" o \"en\") y devuelva "
            "`saludo`: \"Hola, <nombre>\" si el idioma es es, o \"Hello, <nombre>\" si es en. Pásalo por la compuerta de "
            "publicación y publícalo (una persona aprueba las solicitudes en menos de un minuto), córrelo con nombre "
            "\"Luz\" e idioma \"es\", y dime el saludo.")


def check_saludo(org, answer):
    return run_status(org, "saludo", lambda out: "Hola, Luz" in str(out.get("saludo", "")))


def setup_diagnose(org, owner):
    d = doc("inv-" + org, "Inventory sync", [{"id": "fetch_inventory", "type": "http", "config": {
        "url": "http://127.0.0.1:1/inventory", "method": "GET", "resultPolicy": "require_ok"}}])
    save(org, owner, d)
    wait_run(start(org, owner, d), {"failed"})
    return "A run of the \"Inventory sync\" workflow failed in Janusly. Find it and tell me which step failed and why."


def check_diagnose(org, answer):
    text = answer.lower()
    return "fetch_inventory" in text and any(k in text for k in ("refused", "connect", "unreachable", "dial"))


def setup_credential(org, owner):
    d = doc("aviso-" + org, "Aviso Slack", [{"id": "notificar", "type": "tool", "config": {
        "tool": "slack.post", "input": {"credential": "SLACK_HOOK", "text": "listo"}}}])
    save(org, owner, d)
    wait_run(start(org, owner, d), {"failed"})
    return ("La corrida del workflow \"Aviso Slack\" falló en Janusly. Averigua por qué y dime exactamente qué tengo que "
            "hacer para arreglarlo. No me pidas ningún secreto.")


def check_credential(org, answer):
    return "SLACK_HOOK" in answer and ("/#/credentials" in answer or "credencial" in answer.lower())


def setup_modify(org, owner):
    d = doc("shout-" + org, "Shout", [{"id": "upper", "type": "tool", "config": {
        "tool": "text.uppercase", "input": {"value": "{{context.input.text}}"}}}],
        outputs={"text": "{{context.upper.output.result.value}}"})
    save(org, owner, d)
    return ("Change the existing \"Shout\" workflow in Janusly so its output `text` ends with an exclamation mark "
            "(\"hi\" becomes \"HI!\"). Keep it passing Janusly's publish gate and publish the change. Do not create a new workflow.")


def check_modify(org, answer):
    versions = sql("SELECT count(*) FROM workflow_versions WHERE org_id = %s AND workflow_id = %s", org, "shout-" + org)
    latest = sql("SELECT dag_json::text FROM workflow_versions WHERE org_id = %s AND workflow_id = %s ORDER BY version DESC LIMIT 1",
                 org, "shout-" + org)
    return int(versions or 0) >= 2 and "!" in latest


def setup_schedule(org, owner):
    d = doc("rep-" + org, "Reporte", [{"id": "armar", "type": "transform", "config": {"mapping": {"ok": "true"}}}],
            outputs={"ok": "{{context.armar.output.ok}}"})
    save(org, owner, d)
    return ("Haz que el workflow \"Reporte\" de Janusly corra todos los días a las 09:00 UTC. Pásalo por la compuerta, "
            "publícalo (una persona aprueba en menos de un minuto) y dime cuándo es la próxima ejecución programada.")


def check_schedule(org, answer):
    rows = sql("SELECT cron_expression, enabled, next_fire_at IS NOT NULL FROM schedule_entries WHERE org_id = %s AND workflow_id = %s",
               org, "rep-" + org)
    return any(line.startswith("0 9 * * *|t|t") for line in rows.splitlines())


def setup_pause(org, owner):
    save(org, owner, doc("nc-" + org, "Nightly cleanup", [{"id": "n", "type": "noop", "config": {}}]))
    return "Pause the \"Nightly cleanup\" workflow in Janusly, confirm that it is paused, then turn it back on and confirm it is active again."


def check_pause(org, answer):
    actions = sql("SELECT string_agg(action, ',' ORDER BY created_at) FROM audit_logs WHERE org_id = %s AND target_id = %s AND user_id LIKE 'agent:%%'",
                  org, "nc-" + org)
    status = sql("SELECT status FROM workflows WHERE org_id = %s AND id = %s AND deleted_at IS NULL", org, "nc-" + org)
    done = (actions or "").split(",")
    return "workflow.paused" in done and "workflow.resumed" in done and "workflow.deleted" not in done and status == "active"


def setup_cancel(org, owner):
    d = doc("pagos-" + org, "Pagos", [{"id": "aprobar", "type": "approval", "config": {}}, {"id": "fin", "type": "noop", "config": {}}],
            [{"from": "aprobar", "to": "fin"}])
    save(org, owner, d)
    run_id = start(org, owner, d)
    wait_run(run_id, {"waiting"})
    setup_cancel.run_id = run_id
    return "En Janusly hay una corrida del workflow \"Pagos\" esperando una aprobación. Cancélala y confírmame que quedó cancelada."


def check_cancel(org, answer):
    return sql("SELECT status FROM runs WHERE id = %s", setup_cancel.run_id) == "cancelled"


def setup_redrive(org, owner):
    Sim.healthy = False
    d = doc("stock-" + org, "Stock check", [{"id": "stock", "type": "http", "config": {
        "url": f"http://127.0.0.1:{SIM_PORT}/stock", "method": "GET", "resultPolicy": "require_ok"}}])
    save(org, owner, d)
    run_id = start(org, owner, d)
    wait_run(run_id, {"failed"})
    deadline = time.time() + 20
    while sql("SELECT count(*) FROM dead_letters WHERE run_id = %s", run_id) in ("", "0") and time.time() < deadline:
        time.sleep(0.3)
    Sim.healthy = True
    setup_redrive.run_id = run_id
    return ("A run of the \"Stock check\" workflow failed and is in Janusly's dead-letter queue. The upstream service is "
            "healthy again. Retry it and confirm that the run succeeded.")


def check_redrive(org, answer):
    deadline = time.time() + 20
    while time.time() < deadline:
        if sql("SELECT status FROM runs WHERE id = %s", setup_redrive.run_id) == "succeeded":
            return True
        time.sleep(0.5)
    return False


def setup_csv(org, owner):
    return ("En Janusly, crea un workflow llamado \"Activos\" que reciba `csv` (texto CSV con columnas name,status) y "
            "devuelva `activos`: las filas con status igual a active. Pásalo por la compuerta y publícalo (una persona "
            "aprueba en menos de un minuto), córrelo con este CSV:\nname,status\nana,active\nbo,inactive\ncy,active\n"
            "y dime qué filas devolvió.")


def check_csv(org, answer):
    def ok(out):
        rows = out.get("activos")
        if isinstance(rows, str):
            try:
                rows = json.loads(rows)
            except ValueError:
                return False
        return isinstance(rows, list) and len(rows) == 2
    return run_status(org, "activos", ok)


TASKS = [
    ("en", "create, gate, publish, run", setup_greeter, check_greeter),
    ("es", "crear con condición, compuerta, publicar, correr", setup_saludo, check_saludo),
    ("en", "diagnose a failed run", setup_diagnose, check_diagnose),
    ("es", "credencial faltante sin pedir secretos", setup_credential, check_credential),
    ("en", "change a published workflow", setup_modify, check_modify),
    ("es", "programar un cron y confirmar", setup_schedule, check_schedule),
    ("en", "pause and resume", setup_pause, check_pause),
    ("es", "cancelar una corrida en espera", setup_cancel, check_cancel),
    ("en", "redrive after upstream recovery", setup_redrive, check_redrive),
    ("es", "CSV: crear, publicar, correr", setup_csv, check_csv),
]


# --- blank sessions --------------------------------------------------------
class Refused(Exception):
    """The session is not blank. Better not to measure than to measure it."""


def operator_homes():
    homes = {os.path.realpath(os.path.expanduser("~"))}
    try:
        homes.add(os.path.realpath(pwd.getpwuid(os.getuid()).pw_dir))
    except KeyError:
        pass
    return homes


def forbidden_roots():
    """The operator's agent configuration, which the harness never reads,
    writes or hands to a session."""
    return [os.path.join(home, name) for home in operator_homes() for name in (".claude", ".claude.json", ".codex", ".cursor")]


def guard(path):
    real = os.path.realpath(path)
    for root in forbidden_roots():
        if real == root or real.startswith(root + os.sep):
            raise Refused(f"{path} is inside {root}")
    return path


XDG = ("config", "data", "cache", "state")
BLANK_DIRS = ("home", "work", "claude", "codex")
MARKERS = ("CLAUDE.md", "AGENTS.md", ".claude", ".codex", ".cursor", ".cursorrules", ".mcp.json")


class Session:
    """A throwaway home, configuration and working directory for one client
    process, deleted when it ends."""

    def __init__(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="janusly-cycle-", dir=SESSION_ROOT))
        guard(self.root)
        for name in (*BLANK_DIRS, "harness", "tmp"):
            setattr(self, name, os.path.join(self.root, name))
            os.makedirs(getattr(self, name))
        self.xdg = {name: os.path.join(self.root, "xdg", name) for name in XDG}
        for path in self.xdg.values():
            os.makedirs(path)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        shutil.rmtree(self.root, ignore_errors=True)


def assert_blank(session):
    """Nothing in the session's directories, and no instructions or agent
    configuration a client could discover above them."""
    for name in BLANK_DIRS:
        entries = sorted(os.listdir(getattr(session, name)))
        if entries:
            raise Refused(f"session {name} is not empty: {entries}")
    parent = session.root
    while True:
        parent, child = os.path.dirname(parent), parent
        if parent == child:
            break
        found = [marker for marker in MARKERS if os.path.lexists(os.path.join(parent, marker))]
        if found:
            raise Refused(f"{parent} holds {found}; set CYCLE_TMP to a clean directory")


ISOLATION_KEYS = {"HOME", "PATH", "TMPDIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR",
                  "CURSOR_FORCED_SHELL_EGRESS", "JANUSLY_AGENT_TOKEN", "NO_OPEN_BROWSER"}
OPERATOR_CREDENTIALS = {"CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"}


def passed_env():
    """The variables named in CYCLE_PASS_ENV, such as the model key."""
    names = [name for name in os.environ.get("CYCLE_PASS_ENV", "").split(",") if name]
    for name in names:
        if name in ISOLATION_KEYS or name.startswith("XDG_"):
            raise Refused(f"CYCLE_PASS_ENV may not carry {name}")
        if name in OPERATOR_CREDENTIALS:
            raise Refused(f"{name} is a person's session; pass a dedicated API key instead")
    return {name: os.environ[name] for name in names if name in os.environ}


CLIENT_KEYS = {"claude": ("ANTHROPIC_API_KEY",), "codex": ("CODEX_API_KEY", "OPENAI_API_KEY"), "cursor": ("CURSOR_API_KEY",)}


def agent_env(session, token):
    """Only what the client needs: no operator home, secrets or settings."""
    env = {key: os.environ[key] for key in ("PATH", "LANG", "TERM") if key in os.environ}
    others = {key for client, keys in CLIENT_KEYS.items() if client != CLIENT for key in keys}
    env.update({key: value for key, value in passed_env().items() if key not in others})
    env.update({"HOME": session.home, "CLAUDE_CONFIG_DIR": session.claude, "CODEX_HOME": session.codex,
                "TMPDIR": session.tmp, "JANUSLY_AGENT_TOKEN": token, "NO_OPEN_BROWSER": "1",
                # No traffic besides the model and Janusly.
                "DISABLE_AUTOUPDATER": "1", "DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1",
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"})
    env.update({f"XDG_{name.upper()}_HOME": path for name, path in session.xdg.items()})
    # Cursor prefers these, then XDG_CONFIG_HOME, over HOME/.cursor.
    env.update(CURSOR_CONFIG_DIR=os.path.join(session.home, ".cursor"), CURSOR_DATA_DIR=os.path.join(session.home, ".cursor"),
               CURSOR_FORCED_SHELL_EGRESS="1")  # also turns off Cursor's web search and fetch
    for key in ("HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR", "TMPDIR"):
        real = os.path.realpath(env[key])
        if real in operator_homes() or not real.startswith(session.root + os.sep):
            raise Refused(f"{key} must be inside the session, not {env[key]}")
    for value in env.values():
        for part in value.split(os.pathsep):
            if os.path.isabs(part):
                guard(part)
    return env


def require_key(names):
    if not any(passed_env().get(name) for name in names):
        raise Refused(f"name {' or '.join(names)} in CYCLE_PASS_ENV: a dedicated key with a spend cap, never a person's session")


def janusly_tools(token):
    """The catalog the agent token sees, read by the harness itself."""
    def call(body):
        req = urllib.request.Request(BASE + "/mcp", data=json.dumps({"jsonrpc": "2.0", **body}).encode(), method="POST", headers={
            "content-type": "application/json", "accept": "application/json, text/event-stream",
            "authorization": "Bearer " + token, "mcp-protocol-version": "2025-06-18"})
        with urllib.request.urlopen(req, timeout=30) as res:
            raw = res.read()
        return json.loads(raw) if raw else {}

    call({"id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "agent-cycle", "version": "1"}}})
    call({"method": "notifications/initialized"})
    tools = call({"id": 2, "method": "tools/list", "params": {}}).get("result", {}).get("tools")
    if not tools:
        raise Refused("Janusly listed no MCP tools for the agent token")
    return tools


def destructive(tool):
    hints = tool.get("annotations") or {}
    return not hints.get("readOnlyHint") and hints.get("destructiveHint", True) is not False


def closed_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def kill(proc):
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def stream(command, env, cwd, log, watch, timeout):
    """Runs a client and logs its output. watch sees each JSON event and
    returns a reason to kill the client by PID, or "stop" once satisfied."""
    proc = subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, start_new_session=True, encoding="utf-8", errors="replace")
    expired = threading.Event()
    timer = threading.Timer(timeout, lambda: (expired.set(), kill(proc)))
    timer.start()
    verdict = None
    try:
        with open(log, "w") as out:
            for line in proc.stdout:
                out.write(line)
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                try:
                    verdict = watch(event) if isinstance(event, dict) else None
                except Exception as err:  # an event the watcher cannot read fails closed
                    verdict = f"unreadable event {err!r}"
                if verdict:
                    break
    finally:
        timer.cancel()
        if verdict or expired.is_set():
            kill(proc)
        proc.wait()
        kill(proc)  # whatever the client left running in its process group
        proc.stdout.close()
    if expired.is_set() and not verdict:
        verdict = "timeout"
    return proc.returncode, verdict


def run_agent(prompt, token, log):
    if CLIENT == "claude":
        return claude(prompt, token, log)
    if CLIENT == "cursor":
        return cursor(prompt, token, log)
    return codex(prompt, token, log)


# --- Claude Code ------------------------------------------------------------
# Built into the pinned CLI; nothing a home or plugin added.
CLAUDE_AGENTS = {"claude", "Explore", "general-purpose", "Plan", "statusline-setup"}
CLAUDE_BUILTINS = ("Agent", "Task", "Bash", "BashOutput", "KillShell", "Monitor", "Edit", "MultiEdit", "Write", "Read",
                   "NotebookEdit", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoWrite", "Skill", "SlashCommand")


def claude_name(tool):
    return "mcp__janusly__" + re.sub(r"[^A-Za-z0-9_-]", "_", tool["name"])


def claude_allowed(tools):
    """Approved: the harness says yes to every Janusly tool, the only person
    the cycle allows. Strict: destructive tools would ask a person, and with
    --permission-prompts none nobody answers."""
    if MODE == "approved":
        return ["mcp__janusly"]
    return sorted(claude_name(tool) for tool in tools if not destructive(tool))


def claude_command(prompt, session, allowed):
    config = os.path.join(session.harness, "mcp.json")
    with open(config, "w") as out:
        json.dump({"mcpServers": {"janusly": {"type": "http", "url": BASE + "/mcp",
                                              "headers": {"Authorization": "Bearer ${JANUSLY_AGENT_TOKEN}"}}}}, out)
    # --bare skips hooks, plugin sync, auto-memory, CLAUDE.md discovery and the
    # keychain: the key comes from ANTHROPIC_API_KEY only.
    command = ["claude", "-p", prompt, "--bare", "--setting-sources", "", "--settings", json.dumps({"disableAllHooks": True}),
               "--strict-mcp-config", "--mcp-config", config, "--tools", "", "--disallowedTools", ",".join(CLAUDE_BUILTINS),
               "--disable-slash-commands", "--no-chrome", "--no-session-persistence",
               "--permission-mode", "default", "--permission-prompts", "none",
               "--output-format", "stream-json", "--verbose", "--max-turns", "60"]
    if allowed:
        command += ["--allowedTools", ",".join(allowed)]
    if MODEL:
        command += ["--model", MODEL]
    if MAX_BUDGET_USD:
        command += ["--max-budget-usd", MAX_BUDGET_USD]
    return command


def claude_init_problems(init, expected, workdir):
    problems = []
    servers = init.get("mcp_servers") or []
    names = [server.get("name") for server in servers]
    if names != ["janusly"]:
        problems.append(f"MCP servers {names}")
    elif servers[0].get("status") != "connected":
        problems.append(f"janusly is {servers[0].get('status')}")
    tools = set(init.get("tools") or [])
    if not tools or not tools <= expected:
        problems.append(f"tools outside the Janusly catalog: {sorted(tools - expected) or 'none listed'}")
    for key in ("slash_commands", "skills", "additional_directories"):
        if init.get(key):
            problems.append(f"{key} {init[key]}")
    plugins = [plugin.get("source") or plugin.get("name") for plugin in init.get("plugins") or [] if plugin.get("path") != "builtin"]
    if plugins:
        problems.append(f"plugins {plugins}")
    agents = sorted(set(init.get("agents") or []) - CLAUDE_AGENTS)
    if agents:
        problems.append(f"agents {agents}")
    if init.get("output_style", "default") != "default":
        problems.append(f"output style {init['output_style']}")
    if init.get("apiKeySource") != "ANTHROPIC_API_KEY":
        problems.append(f"model credential from {init.get('apiKeySource')}")
    if os.path.realpath(init.get("cwd") or "") != os.path.realpath(workdir):
        problems.append(f"working directory {init.get('cwd')}")
    if PINNED_VERSION and init.get("claude_code_version") != PINNED_VERSION:
        problems.append(f"version {init.get('claude_code_version')}, pinned {PINNED_VERSION}")
    return problems


def is_init(event):
    return event.get("type") == "system" and event.get("subtype") == "init"


def claude_preflight(prompt, token, allowed, expected):
    """Starts the exact command with the model endpoint on a closed local
    port and reads its init event: the client reports its servers, tools,
    plugins and credential source, and nothing reaches a model."""
    with Session() as session:
        assert_blank(session)
        env = agent_env(session, token)
        env.update(ANTHROPIC_API_KEY="preflight-no-spend", ANTHROPIC_BASE_URL=f"http://127.0.0.1:{closed_port()}")
        seen = []
        stream(claude_command(prompt, session, allowed), env, session.work, os.path.join(session.root, "preflight.jsonl"),
               lambda event: seen.append(event) or "stop" if is_init(event) else None, 120)
        if not seen:
            raise Refused("Claude Code reported no init event")
        problems = claude_init_problems(seen[0], expected, session.work)
    if problems:
        raise Refused("Claude Code session is not blank: " + "; ".join(problems))
    return seen[0]


def claude(prompt, token, log):
    require_key(CLIENT_KEYS["claude"])
    tools = janusly_tools(token)
    expected = {claude_name(tool) for tool in tools}
    allowed = claude_allowed(tools)
    claude_preflight(prompt, token, allowed, expected)
    state = {"init": None, "answer": "", "calls": [], "errors": 0, "tokens": 0, "cost": None}

    def watch(event):
        if is_init(event):
            problems = claude_init_problems(event, expected, session.work)
            if problems:
                return "init: " + "; ".join(problems)
            state["init"] = event
            return None
        if event.get("type") in ("assistant", "user", "result") and state["init"] is None:
            return "the client acted before its init event"
        if event.get("type") == "result":
            state["answer"] = event.get("result", "")
            usage = event.get("usage") or {}
            state["tokens"] = usage.get("input_tokens", 0) + usage.get("output_tokens", 0)
            state["cost"] = event.get("total_cost_usd")
        message = event.get("message")
        for block in message.get("content", []) if isinstance(message, dict) and isinstance(message.get("content"), list) else []:
            if block.get("type") == "tool_use":
                if not str(block.get("name", "")).startswith("mcp__janusly__"):
                    return f"called {block.get('name')}"
                state["calls"].append(block["name"])
            if block.get("type") == "tool_result" and block.get("is_error"):
                state["errors"] += 1
        return None

    started = time.time()
    with Session() as session:
        assert_blank(session)
        code, verdict = stream(claude_command(prompt, session, allowed), agent_env(session, token), session.work, log, watch, TASK_SECONDS)
    if verdict and verdict != "timeout":
        raise Refused("Claude Code session stopped: " + verdict)
    if state["init"] is None and verdict != "timeout":
        raise Refused("Claude Code reported no init event")
    init = state["init"] or {}
    return {"exit": code, "answer": state["answer"], "calls": state["calls"], "toolErrors": state["errors"],
            "tokens": state["tokens"], "costUsd": state["cost"], "seconds": round(time.time() - started),
            "clientVersion": init.get("claude_code_version"), "model": init.get("model"),
            **({"error": "timeout"} if verdict == "timeout" else {})}


# --- Codex ------------------------------------------------------------------
# unified_exec stays on in 0.167; with shell_tool off no command tool is
# offered, and a command execution still stops the cycle.
CODEX_OFF = ("plugins", "remote_plugin", "apps", "computer_use", "browser_use", "browser_use_external", "in_app_browser",
             "hooks", "shell_tool", "image_generation", "multi_agent", "memories", "skill_search", "tool_suggest",
             "view_image")
CODEX_LOCAL = ("command_execution", "file_change", "web_search")


def codex_overrides(session):
    instructions = os.path.join(session.harness, "instructions.md")
    with open(instructions, "w") as out:
        out.write("You are a coding agent. Use only the tools you are given.\n")
    args = ["-c", f'mcp_servers.janusly.url="{BASE}/mcp"', "-c", 'mcp_servers.janusly.bearer_token_env_var="JANUSLY_AGENT_TOKEN"',
            "-c", "mcp_servers.janusly.tool_timeout_sec=120", "-c", f'model_instructions_file="{instructions}"',
            "-c", 'web_search="disabled"', *[arg for feature in CODEX_OFF for arg in ("-c", f"features.{feature}=false")]]
    if MODE == "approved":
        # Codex asks a person before a destructive tool; for Janusly's tools
        # only, the harness is that person.
        args += ["-c", 'mcp_servers.janusly.default_tools_approval_mode="approve"']
    if MODEL:
        args += ["-c", f'model="{MODEL}"']
    return args + shlex.split(os.environ.get("CYCLE_CODEX_ARGS", ""))


ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def client_output(base, args, session, token):
    out = subprocess.run([*base, *args], cwd=session.work, env=agent_env(session, token), capture_output=True, text=True, timeout=60)
    if out.returncode:
        raise Refused(f"{base[0]} {args[0]} failed: {ANSI.sub('', out.stderr or out.stdout).strip()[:300]}")
    return ANSI.sub("", out.stdout)


def codex_preflight(token):
    """Inside a throwaway CODEX_HOME, Codex must list only janusly and report
    every feature that reaches beyond it as off."""
    with Session() as session:
        assert_blank(session)
        version = client_output(("codex",), ["--version"], session, token).split()[-1:] or [""]
        overrides = codex_overrides(session)
        try:
            servers = json.loads(client_output(("codex",), ["mcp", "list", "--json", *overrides], session, token))
            names = [server["name"] for server in servers]
        except (ValueError, KeyError, TypeError):
            raise Refused("cannot read Codex's MCP servers")
        if names != ["janusly"] or not servers[0].get("enabled"):
            raise Refused(f"Codex MCP servers {names}")
        listed = (line.split() for line in client_output(("codex",), ["features", "list", *overrides], session, token).splitlines())
        on = sorted(parts[0] for parts in listed if len(parts) >= 2 and parts[0] in CODEX_OFF and parts[-1] == "true")
        if on:
            raise Refused(f"Codex features still on: {on}")
    if PINNED_VERSION and version[0] != PINNED_VERSION:
        raise Refused(f"Codex {version[0]}, pinned {PINNED_VERSION}")
    return version[0]


def codex(prompt, token, log):
    require_key(CLIENT_KEYS["codex"])
    version = codex_preflight(token)
    state = {"answer": "", "calls": [], "errors": 0, "tokens": 0}

    def watch(event):
        item = event.get("item") or {}
        if item.get("type") in CODEX_LOCAL:
            return f"used {item['type']}"
        if item.get("type") == "mcp_tool_call" and item.get("server") not in (None, "janusly"):
            return f"called server {item.get('server')}"
        if event.get("type") == "item.completed" and item.get("type") == "agent_message":
            state["answer"] = item.get("text", "")
        if event.get("type") == "item.completed" and item.get("type") == "mcp_tool_call":
            state["calls"].append(item.get("tool"))
            if item.get("status") != "completed" or (item.get("result") or {}).get("is_error"):
                state["errors"] += 1
        if event.get("type") == "turn.completed":
            usage = event.get("usage") or {}
            state["tokens"] += usage.get("input_tokens", 0) + usage.get("output_tokens", 0)
        return None

    started = time.time()
    with Session() as session:
        assert_blank(session)
        command = ["codex", "exec", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--ephemeral",
                   "-s", "read-only", "--json", *codex_overrides(session), prompt]
        code, verdict = stream(command, agent_env(session, token), session.work, log, watch, TASK_SECONDS)
    if verdict and verdict != "timeout":
        raise Refused("Codex session stopped: " + verdict)
    return {"exit": code, "answer": state["answer"], "calls": state["calls"], "toolErrors": state["errors"],
            "tokens": state["tokens"], "costUsd": None, "seconds": round(time.time() - started),
            "clientVersion": version, "model": MODEL or None, **({"error": "timeout"} if verdict == "timeout" else {})}


# --- Cursor -----------------------------------------------------------------
# Account rules, memories and team MCP servers live on Cursor's servers, and on
# macOS the CLI reads the login keychain: a temporary HOME isolates neither.
CURSOR_CONTAINER_MARKERS = ("/.dockerenv", "/run/.containerenv")
CURSOR_EVENTS = {"system", "user", "assistant", "thinking", "tool_call", "result"}
CURSOR_CLI = ("cursor-agent", "--disable-auto-update")


def in_container():
    return any(os.path.exists(marker) for marker in CURSOR_CONTAINER_MARKERS)


def cursor_allowed(tools):
    names = [tool["name"] for tool in tools if MODE == "approved" or not destructive(tool)]
    return sorted(f"Mcp(janusly:{name})" for name in names)


def cursor_configure(session, allowed):
    """Writes the session's only Cursor configuration: janusly in the user
    MCP file (no project file, so no approval prompt) and a permission
    allowlist holding nothing but the Janusly tools the mode allows."""
    config = os.path.join(session.home, ".cursor")
    os.makedirs(config)
    with open(os.path.join(config, "mcp.json"), "w") as out:
        json.dump({"mcpServers": {"janusly": {"url": BASE + "/mcp",
                                              "headers": {"Authorization": "Bearer ${env:JANUSLY_AGENT_TOKEN}"}}}}, out)
    with open(os.path.join(config, "cli-config.json"), "w") as out:
        json.dump({"version": 1, "permissions": {"allow": allowed, "deny": ["Shell(*)", "Read(**)", "Write(**)", "WebFetch(*)"]},
                   "approvalMode": "allowlist", "autoAcceptWebSearch": False, "sandbox": {"mode": "enabled"},
                   "attribution": {"attributeCommitsToAgent": False, "attributePRsToAgent": False}}, out)


def cursor_preflight(token, allowed, expected):
    """In the throwaway HOME, Cursor must list only janusly, ready, with
    exactly the catalog the harness read, and use the dedicated key."""
    if not in_container():
        raise Refused("Cursor runs only in the harness container: a temporary HOME does not hide the macOS keychain")
    if os.environ.get("CYCLE_CURSOR_ACCOUNT") != "dedicated":
        raise Refused("set CYCLE_CURSOR_ACCOUNT=dedicated once the key's account has no rules, memories or team MCP servers")
    with Session() as session:
        assert_blank(session)
        cursor_configure(session, allowed)
        version = client_output(CURSOR_CLI, ["--version"], session, token).strip()
        if PINNED_VERSION and version != PINNED_VERSION:
            raise Refused(f"Cursor {version}, pinned {PINNED_VERSION}")
        servers = [line.strip() for line in client_output(CURSOR_CLI, ["mcp", "list"], session, token).splitlines() if line.strip()]
        if servers != ["janusly: ready"]:
            raise Refused(f"Cursor MCP servers {servers}")
        lines = client_output(CURSOR_CLI, ["mcp", "list-tools", "janusly"], session, token).splitlines()
        listed = {line[2:].split(" (")[0].strip() for line in lines if line.startswith("- ")}
        if listed != expected:
            raise Refused(f"Cursor lists janusly tools {sorted(listed ^ expected)} that the agent token does not")
        if sorted(os.listdir(session.work)):
            raise Refused(f"Cursor wrote {sorted(os.listdir(session.work))} into the workspace")
    return version


def cursor_command(prompt, session):
    # No --force: anything outside the allowlist needs a person, and print
    # mode has none. --approve-mcps covers janusly, the only server.
    command = [*CURSOR_CLI, "-p", prompt, "--output-format", "stream-json", "--workspace",
               session.work, "--trust", "--approve-mcps", "--sandbox", "enabled"]
    if MODEL:
        command += ["--model", MODEL]
    return command


def cursor_oneof(field):
    """A protobuf oneof, as {"case", "value"} or as {"<case>": value}."""
    if not isinstance(field, dict):
        return None, {}
    if "case" in field:
        case, value = field.get("case"), field.get("value")
    else:
        cases = [key for key in field if not key.startswith("$")]
        case, value = (cases[0], field[cases[0]]) if len(cases) == 1 else (str(cases), {})
    return case, value if isinstance(value, dict) else {}


def cursor_call(event):
    call = event.get("tool_call") or {}
    return cursor_oneof(call["tool"] if isinstance(call.get("tool"), dict) else call)


def cursor_failed(call):
    case, value = cursor_oneof(call.get("result"))
    return case != "success" or bool(value.get("isError"))


def cursor(prompt, token, log):
    require_key(CLIENT_KEYS["cursor"])
    tools = janusly_tools(token)
    expected = {tool["name"] for tool in tools}
    allowed = cursor_allowed(tools)
    version = cursor_preflight(token, allowed, expected)
    state = {"init": None, "answer": "", "calls": [], "errors": 0, "tokens": 0}

    def watch(event):
        if is_init(event):
            if event.get("apiKeySource") != "env":
                return f"model credential from {event.get('apiKeySource')}"
            if os.path.realpath(event.get("cwd") or "") != os.path.realpath(session.work):
                return f"working directory {event.get('cwd')}"
            if event.get("permissionMode") != "default":
                return f"permission mode {event.get('permissionMode')}"
            state["init"] = event
            return None
        if event.get("type") not in CURSOR_EVENTS:
            return f"emitted {event.get('type')} {event.get('query_type') or ''}".strip()
        if event.get("type") in ("assistant", "tool_call", "result") and state["init"] is None:
            return "the client acted before its init event"
        if event.get("type") == "tool_call":
            kind, call = cursor_call(event)
            args = call.get("args") or {}
            if kind == "getMcpToolsToolCall" and args.get("server") == "janusly":
                return None
            name = args.get("toolName") or args.get("name")
            if kind != "mcpToolCall":
                return f"used {kind}"
            if args.get("providerIdentifier") != "janusly" or name not in expected:
                return f"called {args.get('providerIdentifier')}:{name}"
            if event.get("subtype") == "completed":
                if f"Mcp(janusly:{name})" not in allowed and not cursor_failed(call):
                    return f"ran {name} outside the allowlist"
                state["calls"].append(name)
                state["errors"] += cursor_failed(call)
        if event.get("type") == "result":
            state["answer"] = event.get("result", "")
            usage = event.get("usage") or {}
            state["tokens"] = sum(int(usage.get(camel, usage.get(snake)) or 0)
                                  for camel, snake in (("inputTokens", "input_tokens"), ("outputTokens", "output_tokens")))
        return None

    started = time.time()
    with Session() as session:
        assert_blank(session)
        cursor_configure(session, allowed)
        code, verdict = stream(cursor_command(prompt, session), agent_env(session, token), session.work, log, watch, TASK_SECONDS)
    if verdict and verdict != "timeout":
        raise Refused("Cursor session stopped: " + verdict)
    if state["init"] is None and verdict != "timeout":
        raise Refused("Cursor reported no init event")
    return {"exit": code, "answer": state["answer"], "calls": state["calls"], "toolErrors": state["errors"],
            "tokens": state["tokens"], "costUsd": None, "seconds": round(time.time() - started),
            "clientVersion": version, "model": (state["init"] or {}).get("model") or MODEL or None,
            **({"error": "timeout"} if verdict == "timeout" else {})}


def summary(results):
    """Passed tasks per repetition and their median, the figure the cycle
    reports for a client and mode."""
    reps = sorted({result["rep"] for result in results})
    passed = [sum(result["passed"] for result in results if result["rep"] == rep) for rep in reps]
    return {"perRepetition": passed, "median": statistics.median(passed) if passed else None,
            "tasks": len({result["task"] for result in results})}


def main():
    if CLIENT not in ("claude", "codex", "cursor") or MODE not in ("strict", "approved") or REPEAT < 1:
        raise SystemExit("CYCLE_CLIENT is claude, codex or cursor, CYCLE_MODE strict or approved, CYCLE_REPEAT at least 1")
    try:
        guard(HERE)
    except Refused as err:
        raise SystemExit(f"refusing CYCLE_OUT: {err}")
    os.makedirs(HERE, exist_ok=True)
    selected = [int(x) for x in sys.argv[1:]] or list(range(1, len(TASKS) + 1))
    sim = http.server.ThreadingHTTPServer(("127.0.0.1", SIM_PORT), Sim)
    threading.Thread(target=sim.serve_forever, daemon=True).start()
    stop = threading.Event()
    threading.Thread(target=approver, args=(stop,), daemon=True).start()
    results, refused = [], None
    path = os.path.join(HERE, f"results-{CLIENT}-{MODE}-{STAMP}.json")
    try:
        for rep in range(1, REPEAT + 1):
            for index in selected:
                lang, label, setup, check = TASKS[index - 1]
                org, owner, token = new_org(index)
                try:
                    prompt = setup(org, owner)
                    run = run_agent(prompt, token, os.path.join(HERE, f"{org}.jsonl"))
                    passed = check(org, run["answer"])
                except Refused as err:
                    refused = str(err)
                    run, passed = {"answer": "", "calls": [], "error": "refused: " + refused}, False
                except Exception as err:  # a stuck or broken task fails alone; the others keep their results
                    run, passed = {"answer": "", "calls": [], "error": repr(err)}, False
                result = {"task": index, "rep": rep, "mode": MODE, "client": CLIENT, "lang": lang, "label": label, "org": org,
                          "passed": passed, "approvals": [a for a in approvals if a["org"] == org], **run}
                results.append(result)
                with open(path, "w") as out:
                    json.dump({"summary": summary(results), "results": results}, out, indent=2)
                print(json.dumps({k: result.get(k) for k in ("task", "rep", "lang", "passed", "seconds", "toolErrors", "tokens",
                                                             "costUsd", "clientVersion", "model", "error")}), flush=True)
                print("  calls:", len(run["calls"]), "answer:", run["answer"][:300].replace("\n", " "), flush=True)
                if refused:
                    break
            if refused:
                break
    finally:
        stop.set()
        sim.shutdown()
    print(json.dumps({"client": CLIENT, "mode": MODE, **summary(results)}))
    if refused:
        raise SystemExit(f"refused: {refused}")


if __name__ == "__main__":
    main()
