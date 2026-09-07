# ─── Bloomly Brew Assist — Serverless API Route (Python) ────────────────────
# Runs on Vercel's Python runtime, never in the browser. This is the ONLY
# place the Anthropic API key exists — read from a Vercel environment
# variable, so it's never sent to any client and never appears in page source.
#
# Required Vercel environment variables (Project Settings → Environment Variables):
#   ANTHROPIC_API_KEY        — from console.anthropic.com
#   SUPABASE_URL              — same value already used in index.html
#   SUPABASE_PUBLISHABLE_KEY  — same value already used in index.html

import json
import os
from http.server import BaseHTTPRequestHandler

from anthropic import Anthropic
from supabase import create_client

anthropic_client = Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
supabase_admin = create_client(
    os.environ.get("SUPABASE_URL"),
    os.environ.get("SUPABASE_PUBLISHABLE_KEY"),
)

SYSTEM_PROMPT = """You are Bloomly's Brew Assist — a warm, precise coffee brewing coach built into a personal brew-logging app.

You're given a user's full logged history for a single coffee: every attempt they've made, with recipe, dose, yield, grind size, water temperature, brew time, their own 1-5 score, and their tasting notes.

Your job: spot real patterns across their attempts and give specific, actionable troubleshooting advice — not generic brewing theory copied from a textbook. Reference their actual logged numbers when it strengthens your point (e.g. "your two highest-scoring attempts both used a finer grind and a shorter brew time than the rest").

Keep it conversational and concise — a few short paragraphs, not an exhaustive report. If there isn't enough logged data yet to spot a genuine pattern, say so honestly rather than inventing one, and suggest what to log next time to make the pattern visible."""


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
        # ─── Verify the request comes from a real, logged-in Bloomly user ───
        auth_header = self.headers.get("Authorization", "")
        token = auth_header.replace("Bearer ", "").strip()

        if not token:
            self._send_json(401, {"error": "Missing authentication token."})
            return

        try:
            user_response = supabase_admin.auth.get_user(token)
            if not user_response or not user_response.user:
                raise ValueError("No user returned")
        except Exception:
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
        try:
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
        except Exception as e:
            print(f"Brew Assist / Claude API error: {e}")
            self._send_json(500, {"error": "Brew Assist is temporarily unavailable. Please try again in a moment."})

    def _send_json(self, status_code, body_dict):
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body_dict).encode("utf-8"))
