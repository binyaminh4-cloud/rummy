"""Local stand-in for Supabase used by the browser tests.

Auth endpoints are faked in memory; every /rest/v1/rpc/<fn> call runs the REAL rummy SQL
functions on the local test Postgres (port 5433, db t), as the logged-in user.
Usage: python3 -I tests/e2e/mock_supabase.py 8790
"""
import base64, json, re, subprocess, sys, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PSQL = ["psql", "-h", "/tmp", "-p", "5433", "-U", "postgres", "-d", "t", "-At", "-v", "ON_ERROR_STOP=1"]
USERS = {}   # email -> {id, password, nick}


def psql(sql):
    r = subprocess.run(PSQL + ["-c", sql], capture_output=True, text=True)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def load_sigs():
    q = """select p.proname, coalesce(array_to_json(p.proargnames)::text,'[]'),
                  coalesce((select json_agg(format_type(t, null)) from unnest(p.proargtypes) t)::text,'[]'),
                  format_type(p.prorettype, null)
           from pg_proc p where p.proname like 'rummy%' and p.proname not like 'rummy\\_\\_%'"""
    code, out, err = psql(q.replace("\n", " "))
    sigs = {}
    for line in out.splitlines():
        name, names, types, ret = line.split("|")
        sigs[name] = (json.loads(names), json.loads(types), ret)
    return sigs


SIGS = load_sigs()


def lit(v, t):
    if v is None:
        return "null::" + t
    if t.endswith("[]"):
        return "'{" + ",".join(str(int(x)) for x in v) + "}'::" + t
    if t in ("integer", "bigint"):
        return str(int(v)) + "::" + t
    return "'" + str(v).replace("'", "''") + "'::" + t


def b64(d):
    return base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")


def session_for(u, email):
    token = b64({"alg": "HS256", "typ": "JWT"}) + "." + b64({"sub": u["id"], "role": "authenticated", "exp": int(time.time()) + 36000, "email": email}) + ".sig"
    user = {"id": u["id"], "aud": "authenticated", "role": "authenticated", "email": email,
            "user_metadata": {"nick": u.get("nick")}, "app_metadata": {}, "created_at": "2026-01-01T00:00:00Z"}
    return {"access_token": token, "token_type": "bearer", "expires_in": 36000, "expires_at": int(time.time()) + 36000,
            "refresh_token": "r-" + u["id"], "user": user}


def sub_of(headers):
    a = headers.get("Authorization", "")
    m = re.match(r"Bearer (.+)", a)
    if not m:
        return None
    parts = m.group(1).split(".")
    if len(parts) != 3:
        return None
    try:
        p = json.loads(base64.urlsafe_b64decode(parts[1] + "=="))
        return p.get("sub")
    except Exception:
        return None


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")

    def reply(self, code, obj=None):
        body = b"" if obj is None else json.dumps(obj).encode()
        self.send_response(code)
        self.cors()
        if obj is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.reply(204)

    def body(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def do_GET(self):
        if self.path.startswith("/auth/v1/user"):
            s = sub_of(self.headers)
            for e, u in USERS.items():
                if u["id"] == s:
                    return self.reply(200, session_for(u, e)["user"])
            return self.reply(401, {"msg": "invalid JWT"})
        self.reply(404, {"msg": "not found"})

    def do_POST(self):
        p = self.path
        if p.startswith("/auth/v1/token"):
            b = self.body()
            if "refresh_token" in b:
                uid = b["refresh_token"][2:]
                for e, u in USERS.items():
                    if u["id"] == uid:
                        return self.reply(200, session_for(u, e))
                return self.reply(400, {"error_code": "refresh_token_not_found", "msg": "Invalid Refresh Token"})
            u = USERS.get(b.get("email"))
            if not u or u["password"] != b.get("password"):
                return self.reply(400, {"code": 400, "error_code": "invalid_credentials", "msg": "Invalid login credentials"})
            return self.reply(200, session_for(u, b["email"]))
        if p.startswith("/auth/v1/signup"):
            b = self.body()
            if b.get("email") in USERS:
                return self.reply(422, {"code": 422, "error_code": "user_already_exists", "msg": "User already registered"})
            u = {"id": str(uuid.uuid4()), "password": b.get("password"), "nick": (b.get("data") or {}).get("nick")}
            USERS[b["email"]] = u
            psql(f"insert into auth.users values ('{u['id']}', '{b['email']}') on conflict do nothing")
            return self.reply(200, session_for(u, b["email"]))
        if p.startswith("/auth/v1/logout"):
            return self.reply(204)
        m = re.match(r"/rest/v1/rpc/(\w+)", p)
        if m:
            fn = m.group(1)
            if fn not in SIGS:
                return self.reply(404, {"code": "PGRST202", "message": "Could not find the function " + fn})
            names, types, ret = SIGS[fn]
            args = self.body()
            parts = [f"{n} := {lit(args.get(n), t)}" for n, t in zip(names, types) if n in args]
            call = f"{fn}({', '.join(parts)})"
            sel = f"select {call}" if ret == "void" else f"select to_jsonb({call})"
            uid = sub_of(self.headers)
            pre = f"select set_config('request.jwt.sub', '{uid}', true);" if uid else ""
            role = "authenticated" if uid else "anon"
            cmds = ["begin"] + ([pre.rstrip(";")] if pre else []) + [f"set local role {role}", sel, "commit"]
            r = subprocess.run(PSQL + ["-q"] + sum((["-c", c] for c in cmds), []), capture_output=True, text=True)
            code, out, err = r.returncode, r.stdout.strip(), r.stderr.strip()
            if code != 0:
                msg = err.split("ERROR:", 1)[-1].strip().splitlines()[0] if "ERROR:" in err else err
                print("RPC ERROR", fn, args, msg, flush=True)
                return self.reply(400, {"code": "P0001", "message": msg, "details": None, "hint": None})
            lines = [l for l in out.splitlines() if l not in ("BEGIN", "COMMIT", "SET") and not re.fullmatch(r"[0-9a-f-]{36}", l)]
            if ret == "void":
                return self.reply(204)
            val = lines[-1] if lines else "null"
            self.send_response(200)
            self.cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(val.encode())))
            self.end_headers()
            self.wfile.write(val.encode())
            return
        self.reply(404, {"msg": "not found"})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
