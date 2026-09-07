# ─── Bloomly Brew Assist — Serverless API Route (Python) ────────────────────
# Runs on Vercel's Python runtime, never in the browser. This is the ONLY
# place the Anthropic API key exists — read from a Vercel environment
# variable, so it's never sent to any client and never appears in page source.
#
# Required Vercel environment variables (Project Settings → Environment Variables):
#   ANTHROPIC_API_KEY        — from console.anthropic.com
#   SUPABASE_URL              — same value already used in index.html
#   SUPABASE_PUBLISHABLE_KEY  — same value already used in index.html
#
# Deliberately avoids the supabase-py client library here — its dependency
# tree (httpx, gotrue, postgrest, realtime, websockets) is heavier than this
# function needs just to check "is this login token valid?", and that kind of
# dependency chain is a common source of import failures in serverless
# runtimes. A single direct HTTP call to Supabase's own auth endpoint does
# the same job with zero extra dependencies.

import json
import os
import traceback
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler

from anthropic import Anthropic

SYSTEM_PROMPT = """You are Bloomly's Brew Assist — a warm, precise coffee brewing coach built into a personal brew-logging app.

You're given a user's full logged history for a single coffee: every attempt they've made, with recipe, dose, yield, grind size, water temperature, brew time, their own 1-5 score, and their tasting notes.

Your job: spot real patterns across their attempts and give specific, actionable troubleshooting advice — not generic brewing theory copied from a textbook. Reference their actual logged numbers when it strengthens your point (e.g. "your two highest-scoring attempts both used a finer grind and a shorter brew time than the rest").

Keep it conversational and concise — a few short paragraphs, not an exhaustive report. If there isn't enough logged data yet to spot a genuine pattern, say so honestly rather than inventing one, and suggest what to log next time to make the pattern visible."""


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


def build_initial_prompt(coffee_name, brews):
    lines = []
    for i, b in enumerate(brews):
        lines.append(
            f"Attempt {i + 1} ({b.get('date')}): {b.get('method') or 'Unknown method'} "
            f"using \"{b.get('recipe') or 'no recipe'}\" — "
            f"Dose {b.get('dose') or 'n/a'}g, Yield {b.get('yieldAmt') or 'n/a'}g, "
            f"Grind {b.get('grind') or 'n/a'}, Water {b.get('waterTemp') or 'n/a'}°C, "
            f"Brew time {b.get('duration') or 'n/a'}. Score: {b.get('score') or 'n/a'}/5. "
            f"Notes: \"{b.get('notes') or 'none'}\""
        )
    brew_summary = "\n".join(lines)
    return f'Here is my full logged history for "{coffee_name}":\n\n{brew_summary}\n\nWhat should I try changing next, and why?'


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        # Wrapping the entire handler in try/except is deliberate: if anything
        # unexpected goes wrong, we still want to return a real JSON error the
        # frontend can display, rather than letting Vercel return a raw
        # platform error page that breaks JSON parsing on the client.
        try:
            self._handle_post()
        except Exception as e:
            print("Brew Assist — unhandled error:", e)
            traceback.print_exc()
            self._send_json(500, {"error": f"Brew Assist hit an unexpected error: {e}"})

    def _handle_post(self):
        # ─── Verify the request comes from a real, logged-in Bloomly user ───
        auth_header = self.headers.get("Authorization", "")
        token = auth_header.replace("Bearer ", "").strip()

        if not token:
            self._send_json(401, {"error": "Missing authentication token."})
            return

        user = verify_supabase_token(token)
        if not user:
            self._send_json(401, {"error": "Invalid or expired session. Please log in again."})
            return

        # ─── Parse and validate the request body ────────────────────────────
        content_length = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(content_length) if content_length else b"{}"

        try:
            payload = json.loads(raw_body)
        except json.JSONDecodeError:
            self._send_json(400, {"error": "Invalid request body."})
            return

        coffee_name = payload.get("coffeeName")
        brews = payload.get("brews") or []
        question = payload.get("question")
        conversation_history = payload.get("conversationHistory") or []

        if not coffee_name or not isinstance(brews, list):
            self._send_json(400, {"error": "Missing coffee name or brew history."})
            return

        messages = []
        for m in conversation_history:
            if isinstance(m, dict) and m.get("role") and m.get("content"):
                messages.append({"role": m["role"], "content": m["content"]})

        if question:
            messages.append({"role": "user", "content": question})
        else:
            if not brews:
                self._send_json(400, {"error": "Missing brew history for this coffee."})
                return
            messages.append({"role": "user", "content": build_initial_prompt(coffee_name, brews)})

        # ─── Call Claude ──────────────────────────────────────────────────
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            self._send_json(500, {"error": "ANTHROPIC_API_KEY environment variable is not set."})
            return

        anthropic_client = Anthropic(api_key=api_key)
        response = anthropic_client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=700,
            system=SYSTEM_PROMPT,
            messages=messages,
        )
        reply_text = "\n".join(
            block.text for block in response.content if block.type == "text"
        )
        self._send_json(200, {"reply": reply_text})

    def _send_json(self, status_code, body_dict):
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body_dict).encode("utf-8"))
