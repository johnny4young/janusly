"""Agent cycle: ten EN/ES tasks, each from a blank agent session against
Janusly's remote MCP, scored from the database and the final answer. The
harness plays the only person: it approves publish requests.

Needs a running executable with JANUSLY_MCP_HTTP_ENABLED=true,
JANUSLY_MCP_WRITES_ENABLED=true and ALLOW_PRIVATE_HTTP_TARGETS=true (the
redrive task calls a local simulator), development headers enabled, and a
psql command for its database. See docs/development.md."""

import base64, hashlib, http.server, json, os, shlex, subprocess, sys, threading, time, urllib.request, uuid

HERE = os.environ.get("CYCLE_OUT", os.path.join(os.getcwd(), "output", "agent-cycle"))
BASE = os.environ.get("CYCLE_BASE_URL", "http://127.0.0.1:3001")
DB = shlex.split(os.environ.get("CYCLE_PSQL", "psql postgres://janusly:janusly-local@127.0.0.1:15473/janusly")) + [
    "-At", "-v", "ON_ERROR_STOP=1"]
SIM_PORT = int(os.environ.get("CYCLE_SIM_PORT", "23490"))
CLIENT = os.environ.get("CYCLE_CLIENT", "codex")
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


def agent_env(token):
    """Only what the client needs: no operator secrets reach the session."""
    env = {key: os.environ[key] for key in ("PATH", "HOME", "LANG", "TERM") if key in os.environ}
    for key in os.environ.get("CYCLE_PASS_ENV", "").split(","):
        if key and key in os.environ:
            env[key] = os.environ[key]
    env["JANUSLY_AGENT_TOKEN"] = token
    return env


def neutral_instructions():
    path = os.path.join(HERE, "instructions.md")
    with open(path, "w") as out:
        out.write("You are a coding agent. Use only the tools you are given.\n")
    return path


def operator_servers():
    """Every MCP server the operator configured, to switch off for a blank session."""
    out = subprocess.run(["codex", "mcp", "list", "--json", "-c", "features.plugins=false"], capture_output=True, text=True)
    try:
        names = [server["name"] for server in json.loads(out.stdout)]
    except (ValueError, KeyError, TypeError):
        raise SystemExit("cannot list Codex MCP servers to disable them; refusing to run a session that is not blank")
    # The harness's janusly entry would merge into an operator's one, and -c
    # cannot address a dotted name.
    unsafe = [name for name in names if name == "janusly" or "." in name]
    if unsafe:
        raise SystemExit(f"Codex MCP servers {unsafe} cannot be isolated; remove or rename them before a cycle")
    return names


def run_agent(prompt, token, workdir, log):
    if CLIENT == "claude":
        return claude(prompt, token, workdir, log)
    return codex(prompt, token, workdir, log)


def claude(prompt, token, workdir, log):
    config = os.path.join(workdir, "mcp.json")
    with open(config, "w") as out:
        json.dump({"mcpServers": {"janusly": {"type": "http", "url": BASE + "/mcp",
                                              "headers": {"Authorization": "Bearer ${JANUSLY_AGENT_TOKEN}"}}}}, out)
    command = ["claude", "-p", prompt, "--strict-mcp-config", "--mcp-config", config,
               "--allowedTools", "mcp__janusly__*", "--output-format", "stream-json", "--verbose", "--max-turns", "60"]
    started = time.time()
    with open(log, "w") as out:
        proc = subprocess.run(command, cwd=workdir, env=agent_env(token), stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, timeout=1200)
    answer, calls, errors, tokens = "", [], 0, 0
    for line in open(log):
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "result":
            answer = event.get("result", "")
            usage = event.get("usage") or {}
            tokens = usage.get("input_tokens", 0) + usage.get("output_tokens", 0)
        for block in (event.get("message") or {}).get("content", []) if isinstance(event.get("message"), dict) else []:
            if block.get("type") == "tool_use" and str(block.get("name", "")).startswith("mcp__janusly__"):
                calls.append(block["name"])
            if block.get("type") == "tool_result" and block.get("is_error"):
                errors += 1
    return {"exit": proc.returncode, "answer": answer, "calls": calls, "toolErrors": errors, "tokens": tokens,
            "seconds": round(time.time() - started)}


def codex(prompt, token, workdir, log):
    command = ["codex", "exec", "--skip-git-repo-check", "-s", "read-only", "--json",
               "-c", f'mcp_servers.janusly.url="{BASE}/mcp"', "-c", 'mcp_servers.janusly.bearer_token_env_var="JANUSLY_AGENT_TOKEN"',
               "-c", "mcp_servers.janusly.tool_timeout_sec=120",
               # Codex asks a person before a destructive tool; for Janusly's
               # tools only, the harness is that person, the approval the
               # cycle allows.
               "-c", 'mcp_servers.janusly.default_tools_approval_mode="approve"',
               # A blank session: no plugins, computer use, operator MCP
               # servers or operator instructions.
               "-c", "features.plugins=false", "-c", "features.computer_use=false", "-c", "features.browser_use=false",
               "-c", f'model_instructions_file="{neutral_instructions()}"',
               *[arg for name in operator_servers() for arg in ("-c", f"mcp_servers.{name}.enabled=false")],
               *shlex.split(os.environ.get("CYCLE_CODEX_ARGS", "")), prompt]
    env = agent_env(token)
    started = time.time()
    with open(log, "w") as out:
        proc = subprocess.run(command, cwd=workdir, env=env, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, timeout=1200)
    answer, calls, errors, tokens = "", [], 0, 0
    for line in open(log):
        try:
            event = json.loads(line)
        except ValueError:
            continue
        item = event.get("item") or {}
        if event.get("type") == "item.completed" and item.get("type") == "agent_message":
            answer = item.get("text", "")
        if event.get("type") == "item.completed" and item.get("type") == "mcp_tool_call":
            calls.append(item.get("tool"))
            if item.get("status") != "completed" or (item.get("result") or {}).get("is_error"):
                errors += 1
        if event.get("type") == "turn.completed":
            tokens += (event.get("usage") or {}).get("input_tokens", 0) + (event.get("usage") or {}).get("output_tokens", 0)
    return {"exit": proc.returncode, "answer": answer, "calls": calls, "toolErrors": errors, "tokens": tokens,
            "seconds": round(time.time() - started)}


def main():
    os.makedirs(HERE, exist_ok=True)
    selected = [int(x) for x in sys.argv[1:]] or list(range(1, len(TASKS) + 1))
    sim = http.server.ThreadingHTTPServer(("127.0.0.1", SIM_PORT), Sim)
    threading.Thread(target=sim.serve_forever, daemon=True).start()
    stop = threading.Event()
    threading.Thread(target=approver, args=(stop,), daemon=True).start()
    results = []
    for index in selected:
        lang, label, setup, check = TASKS[index - 1]
        org, owner, token = new_org(index)
        workdir = os.path.join(HERE, "blank", org)
        os.makedirs(workdir, exist_ok=True)
        try:
            prompt = setup(org, owner)
            run = run_agent(prompt, token, workdir, os.path.join(HERE, f"{org}.jsonl"))
            passed = check(org, run["answer"])
        except Exception as err:  # a stuck or broken task fails alone; the others keep their results
            run = {"exit": None, "answer": "", "calls": [], "toolErrors": 0, "tokens": 0, "seconds": 0, "error": repr(err)}
            passed = False
        result = {"task": index, "client": CLIENT, "lang": lang, "label": label, "org": org, "passed": passed,
                  "approvals": [a for a in approvals if a["org"] == org], **run}
        results.append(result)
        with open(os.path.join(HERE, f"results-{STAMP}.json"), "w") as out:
            json.dump(results, out, indent=2)
        print(json.dumps({k: result.get(k) for k in ("task", "lang", "passed", "seconds", "toolErrors", "tokens", "error")}), flush=True)
        print("  calls:", len(run["calls"]), "answer:", run["answer"][:300].replace("\n", " "), flush=True)
    stop.set()
    print(f"passed {sum(r['passed'] for r in results)}/{len(results)}")


if __name__ == "__main__":
    main()
