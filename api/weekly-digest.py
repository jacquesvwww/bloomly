# ─── Bloomly Weekly Digest — Serverless API Route (Python) ──────────────────
# A short "your week in coffee" report for the week that just ended, written
# by Claude through the Message Batches API (half the price of a normal
# request, in exchange for an answer that takes minutes rather than seconds —
# fine here, because nobody is waiting on it).
#
# There's no scheduler: the first time a user opens the app in a new week,
# the dashboard calls GET /api/weekly-digest, which submits that user's batch
# and remembers its id. Later calls check on the batch and, once it has
# finished, store the report so it's served straight from Supabase after that.
# Everything runs under the caller's own token, so Row Level Security keeps
# each user to their own brews and digests — no service-role key needed.
#
# Required Vercel environment variables: same as api/brew-assist.py
#   ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY
#
# Required one-time Supabase setup (SQL editor):
#   create table if not exists weekly_digests (
#     id bigint generated always as identity primary key,
#     user_id uuid not null default auth.uid() references auth.users(id),
#     week_start date not null,
#     status text not null default 'pending',   -- pending | ready | not_enough | failed
#     batch_id text,
#     content jsonb,
#     created_at timestamptz not null default now(),
#     unique (user_id, week_start)
#   );
#   alter table weekly_digests enable row level security;
#   create policy "insert own digests" on weekly_digests
#     for insert with check (auth.uid() = user_id);
#   create policy "read own digests" on weekly_digests
#     for select using (auth.uid() = user_id);
#   create policy "update own digests" on weekly_digests
#     for update using (auth.uid() = user_id);
#
# GET /api/weekly-digest?tz=<Date.getTimezoneOffset() minutes>
#   → {"status": "ready", "weekStart": "YYYY-MM-DD", "digest": {...}}
#   → {"status": "pending" | "not_enough"}

import json
import os
import traceback
import urllib.parse
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler

import anthropic

# Same budget-friendly model as Brew Assist; the Batch API halves its price again.
MODEL = "claude-haiku-4-5"
MIN_BREWS_FOR_DIGEST = 2
NOTES_TRUNCATE_CHARS = 200
# A batch that hasn't produced a stored report after this long is given up
# on and resubmitted (batches can take up to 24 hours before expiring).
BATCH_GIVE_UP_AFTER = timedelta(hours=26)

SYSTEM_PROMPT = """You are Bloomly's weekly brew coach. Once a week you write a short, upbeat report on the coffee a user brewed over the past seven days, from their own brew log.

Base everything on their logged numbers, scores and tasting notes; never invent brews or results. Point out what went well, any recurring problem (for example the same coffee keeps tasting sour, or scores drop whenever brew time runs long), and one concrete thing to try this week, with a number where it helps.

Every field is shown as plain text, so use no markdown characters. Keep it short: the headline is one sentence, each highlight is one sentence, give two or three highlights, and the suggestion is at most two sentences."""

DIGEST_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "highlights": {"type": "array", "items": {"type": "string"}},
        "try_this_week": {"type": "string"},
    },
    "required": ["headline", "highlights", "try_this_week"],
    "additionalProperties": False,
}


def verify_supabase_token(token):
    """Calls Supabase's own /auth/v1/user endpoint directly. Returns the user
    dict on success, or None if the token is missing/invalid/expired."""
    supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    publishable_key = os.environ.get("SUPABASE_PUBLISHABLE_KEY", "")

    if not supabase_url or not publishable_key:
        raise RuntimeError("SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY environment variable is not set.")

    req = urllib.request.Request(
        f"{supabase_url}/auth/v1/user",
        headers={
            "Authorization": f"Bearer {token}",
            "apikey": publishable_key,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError:
        return None


def _rest_request(path_and_query, token, method="GET", body=None, return_rows=False):
    """One authenticated call to Supabase's PostgREST endpoint, forwarding the
    caller's own bearer token so Row Level Security scopes every read/write
    to that user's own rows automatically."""
    supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    publishable_key = os.environ.get("SUPABASE_PUBLISHABLE_KEY", "")

    headers = {
        "Authorization": f"Bearer {token}",
        "apikey": publishable_key,
        "Content-Type": "application/json",
    }
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Prefer"] = "return=representation" if return_rows else "return=minimal"

    req = urllib.request.Request(
        f"{supabase_url}/rest/v1/{path_and_query}",
        headers=headers,
        method=method,
        data=data,
    )
    with urllib.request.urlopen(req, timeout=10) as response:
        raw = response.read()
        return json.loads(raw) if raw else None


def last_week_bounds(tz_offset_minutes):
    """Monday 00:00 to the following Monday 00:00 of the week that just
    ended, in the user's local time, returned as (local Monday date, UTC
    start, UTC end). tz_offset_minutes is JavaScript's getTimezoneOffset(),
    i.e. minutes to ADD to local time to get UTC."""
    offset = timedelta(minutes=tz_offset_minutes)
    local_now = datetime.now(timezone.utc) - offset
    this_monday = (local_now - timedelta(days=local_now.weekday())).date()
    last_monday = this_monday - timedelta(days=7)
    start_utc = datetime(last_monday.year, last_monday.month, last_monday.day, tzinfo=timezone.utc) + offset
    return last_monday, start_utc, start_utc + timedelta(days=7)


def fetch_week_brews(token, start_utc, end_utc):
    query = urllib.parse.urlencode([
        ("select", "coffee_name,brew_method,recipe_name,dose_g,yield_g,grind_size,water_temp,"
                   "brew_time_seconds,my_score,notes,brewed_at"),
        ("brewed_at", f"gte.{start_utc.isoformat()}"),
        ("brewed_at", f"lt.{end_utc.isoformat()}"),
        ("order", "brewed_at.asc"),
    ])
    return _rest_request(f"brews?{query}", token) or []


def build_prompt(week_start, brews):
    lines = []
    for b in brews:
        notes = (b.get("notes") or "none")[:NOTES_TRUNCATE_CHARS]
        seconds = b.get("brew_time_seconds")
        brew_time = f"{int(seconds) // 60}:{int(seconds) % 60:02d}" if seconds else "n/a"
        lines.append(
            f"{(b.get('brewed_at') or '')[:10]}: {b.get('coffee_name') or 'Unknown coffee'}, "
            f"{b.get('brew_method') or 'unknown method'} ({b.get('recipe_name') or 'no recipe'}), "
            f"dose {b.get('dose_g') or 'n/a'}g, yield {b.get('yield_g') or 'n/a'}g, "
            f"grind {b.get('grind_size') or 'n/a'}, water {b.get('water_temp') or 'n/a'}°C, "
            f"time {brew_time}, score {b.get('my_score') if b.get('my_score') is not None else 'n/a'}/5, "
            f"notes: \"{notes}\""
        )
    return (
        f"Here is everything I brewed in the week starting Monday {week_start.isoformat()}:\n\n"
        + "\n".join(lines)
        + "\n\nWrite my weekly report."
    )


def submit_batch(client, row_id, week_start, brews):
    batch = client.messages.batches.create(requests=[{
        "custom_id": f"digest-{row_id}",
        "params": {
            "model": MODEL,
            "max_tokens": 4096,
            "output_config": {
                "format": {"type": "json_schema", "schema": DIGEST_SCHEMA},
            },
            "system": SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": build_prompt(week_start, brews)}],
        },
    }])
    return batch.id


def collect_batch_result(client, batch_id):
    """Returns ("pending", None), ("ready", digest dict) or ("failed", None)."""
    batch = client.messages.batches.retrieve(batch_id)
    if batch.processing_status != "ended":
        return "pending", None
    for result in client.messages.batches.results(batch_id):
        if result.result.type != "succeeded":
            return "failed", None
        message = result.result.message
        if message.stop_reason != "end_turn":
            return "failed", None
        text = next((b.text for b in message.content if b.type == "text"), "")
        try:
            return "ready", json.loads(text)
        except json.JSONDecodeError:
            return "failed", None
    return "failed", None


def parse_timestamp(value):
    try:
        return datetime.fromisoformat((value or "").replace("Z", "+00:00"))
    except ValueError:
        return None


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            self._handle_get()
        except Exception as e:
            print("Weekly digest — unhandled error:", e)
            traceback.print_exc()
            self._send_json(500, {"error": "Something went wrong on our end."})

    def _handle_get(self):
        auth_header = self.headers.get("Authorization", "")
        token = auth_header.replace("Bearer ", "").strip()
        if not token or not verify_supabase_token(token):
            self._send_json(401, {"error": "Invalid or expired session. Please log in again."})
            return

        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            self._send_json(500, {"error": "ANTHROPIC_API_KEY environment variable is not set."})
            return

        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        try:
            tz_offset = int(params.get("tz", ["0"])[0])
        except ValueError:
            tz_offset = 0
        tz_offset = max(-840, min(840, tz_offset))  # real offsets run from UTC-12 to UTC+14

        week_start, start_utc, end_utc = last_week_bounds(tz_offset)
        week_key = week_start.isoformat()
        client = anthropic.Anthropic(api_key=api_key)

        rows = _rest_request(f"weekly_digests?week_start=eq.{week_key}&select=*", token) or []
        row = rows[0] if rows else None

        if row and row["status"] == "ready":
            self._send_json(200, {"status": "ready", "weekStart": week_key, "digest": row["content"]})
            return
        if row and row["status"] == "not_enough":
            self._send_json(200, {"status": "not_enough"})
            return

        if row and row["status"] == "pending" and row.get("batch_id"):
            status, digest = collect_batch_result(client, row["batch_id"])
            if status == "ready":
                _rest_request(f"weekly_digests?id=eq.{row['id']}", token, method="PATCH",
                              body={"status": "ready", "content": digest})
                self._send_json(200, {"status": "ready", "weekStart": week_key, "digest": digest})
                return
            created = parse_timestamp(row.get("created_at"))
            stale = created is None or datetime.now(timezone.utc) - created > BATCH_GIVE_UP_AFTER
            if status == "pending" and not stale:
                self._send_json(200, {"status": "pending"})
                return
            row["status"] = "failed"  # fall through and resubmit below

        if row and row["status"] == "pending":
            # Claimed but no batch id yet: another request is submitting it
            # right now — unless that was long enough ago that it must have
            # failed partway, in which case resubmit.
            created = parse_timestamp(row.get("created_at"))
            if created and datetime.now(timezone.utc) - created < timedelta(minutes=10):
                self._send_json(200, {"status": "pending"})
                return

        brews = fetch_week_brews(token, start_utc, end_utc)
        if len(brews) < MIN_BREWS_FOR_DIGEST:
            if row:
                _rest_request(f"weekly_digests?id=eq.{row['id']}", token, method="PATCH", body={"status": "not_enough"})
            else:
                try:
                    _rest_request("weekly_digests", token, method="POST",
                                  body={"week_start": week_key, "status": "not_enough"})
                except urllib.error.HTTPError:
                    pass  # a parallel request already recorded this week
            self._send_json(200, {"status": "not_enough"})
            return

        # Claim this week first (the unique key stops a second tab or a
        # double-load from submitting a duplicate batch), then submit.
        if row:
            row_id = row["id"]
            _rest_request(f"weekly_digests?id=eq.{row_id}", token, method="PATCH",
                          body={"status": "pending", "batch_id": None, "created_at": datetime.now(timezone.utc).isoformat()})
        else:
            try:
                created_rows = _rest_request("weekly_digests", token, method="POST",
                                             body={"week_start": week_key, "status": "pending"}, return_rows=True)
            except urllib.error.HTTPError as e:
                if e.code == 409:
                    self._send_json(200, {"status": "pending"})
                    return
                raise
            row_id = created_rows[0]["id"]

        try:
            batch_id = submit_batch(client, row_id, week_start, brews)
        except anthropic.APIError:
            _rest_request(f"weekly_digests?id=eq.{row_id}", token, method="PATCH", body={"status": "failed"})
            raise
        _rest_request(f"weekly_digests?id=eq.{row_id}", token, method="PATCH", body={"batch_id": batch_id})
        self._send_json(200, {"status": "pending"})

    def _send_json(self, status_code, body_dict):
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body_dict).encode("utf-8"))
