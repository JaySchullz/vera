#!/usr/bin/env python3
"""
Vera Judge Simulation — end-to-end test covering all 17 trigger kinds plus
decision-engine tiers, 6h cooldown, suppression, and reply state machine.

Run:  python3 artifacts/api-server/tests/judge_simulation.py
Requires: server running at http://localhost:8080
"""
import json
import re
import subprocess
import sys

BASE = "http://localhost:8080/v1"
NOW = "2026-05-01T09:00:00Z"   # base 'now' — fresh session, no prior sends

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _curl(method: str, path: str, body=None) -> dict:
    cmd = ["curl", "-s", "-X", method, f"{BASE}{path}", "-H", "Content-Type: application/json"]
    if body is not None:
        cmd += ["-d", json.dumps(body)]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    try:
        return json.loads(r.stdout)
    except Exception:
        return {"_raw": r.stdout, "_err": r.stderr}


def GET(path: str) -> dict:
    return _curl("GET", path)


def POST(path: str, body: dict) -> dict:
    return _curl("POST", path, body)


def merchant_ctx(mid: str, cat: str, name: str, owner: str, signals=None, offers=None,
                 perf=None, customer_agg=None, locality="Koramangala") -> dict:
    return {
        "scope": "merchant",
        "context_id": mid,
        "version": 1,
        "payload": {
            "merchant_id": mid,
            "category_slug": cat,
            "signals": signals or [],
            "identity": {
                "name": name,
                "owner_first_name": owner,
                "locality": locality,
            },
            "performance": perf or {"calls": 120, "views": 450, "leads": 18, "delta_7d": {}},
            "offers": offers or [
                {"status": "active", "type": "service_at_price", "title": "Dental Cleaning @ ₹299"}
            ],
            "customer_aggregate": customer_agg or {"total_unique_ytd": 340},
        },
    }


def trigger_ctx(tid: str, kind: str, mid: str, urgency: int, suppkey: str,
                payload=None, scope="merchant", customer_id=None, expires_at=None) -> dict:
    p = {
        "scope": "trigger",
        "context_id": tid,
        "version": 1,
        "payload": {
            "trigger_id": tid,
            "kind": kind,
            "merchant_id": mid,
            "scope": scope,
            "urgency": urgency,
            "suppression_key": suppkey,
            "payload": payload or {},
        },
    }
    if customer_id:
        p["payload"]["customer_id"] = customer_id
    if expires_at:
        p["payload"]["expires_at"] = expires_at
    return p


def customer_ctx(cid: str, name: str) -> dict:
    return {
        "scope": "customer",
        "context_id": cid,
        "version": 1,
        "payload": {
            "customer_id": cid,
            "identity": {"name": name},
        },
    }


def tick(trigger_ids: list, now=NOW) -> dict:
    return POST("/tick", {"now": now, "available_triggers": trigger_ids})


def reply(conv_id: str, message: str, turn: int, received_at=None) -> dict:
    return POST("/reply", {
        "conversation_id": conv_id,
        "from_role": "merchant",
        "message": message,
        "received_at": received_at or NOW,
        "turn_number": turn,
    })


# ---------------------------------------------------------------------------
# Assertion framework
# ---------------------------------------------------------------------------
passed = []
failed = []
warnings = []


def check(name: str, cond: bool, detail: str = "") -> bool:
    sym = "PASS" if cond else "FAIL"
    line = f"  {sym}: {name}"
    if not cond and detail:
        line += f"\n         detail: {detail}"
    print(line)
    (passed if cond else failed).append(name)
    return cond


def assert_tick_action(label: str, actions: list, *, expect_send_as=None,
                       expect_cta=None, min_digits=1) -> dict | None:
    """Assert a single tick action and validate the composed body."""
    ok = check(f"[{label}] tick returned action", bool(actions),
               f"actions={actions}")
    if not ok:
        return None
    a = actions[0]
    body = a.get("body", "")
    rationale = a.get("rationale", "")

    check(f"[{label}] body not empty", bool(body.strip()))
    check(f"[{label}] body has ≥{min_digits} digit", bool(re.search(r"\d", body)),
          f"body={body[:80]!r}")
    check(f"[{label}] body ≤600 chars", len(body) <= 600,
          f"len={len(body)}")
    check(f"[{label}] rationale has Trigger:", "Trigger:" in rationale,
          f"rationale={rationale[:80]!r}")
    check(f"[{label}] rationale has Signal:", "Signal:" in rationale)
    check(f"[{label}] rationale has Decision:", "Decision:" in rationale)
    check(f"[{label}] rationale has Action:", "Action:" in rationale)
    if expect_send_as:
        check(f"[{label}] send_as={expect_send_as}",
              a.get("send_as") == expect_send_as,
              f"got {a.get('send_as')!r}")
    if expect_cta:
        check(f"[{label}] cta={expect_cta}",
              a.get("cta") == expect_cta,
              f"got {a.get('cta')!r}")
    return a


# ---------------------------------------------------------------------------
# Section 1: healthz + metadata sanity
# ---------------------------------------------------------------------------
print("\n" + "=" * 70)
print("SECTION 1 — System sanity (healthz + metadata)")
print("=" * 70)

hz = GET("/healthz")
check("healthz status=ok", hz.get("status") == "ok", str(hz))
cats_loaded = hz.get("contexts_loaded", {}).get("category", 0)
check("5 categories preloaded at startup", cats_loaded == 5, f"got {cats_loaded}")

meta = GET("/metadata")
check("metadata has team_name", bool(meta.get("team_name")))
check("metadata has model", bool(meta.get("model")))
check("metadata has approach", bool(meta.get("approach")))
check("metadata has version", bool(meta.get("version")))

# ---------------------------------------------------------------------------
# Section 2: Trigger-kind coverage (one tick per kind)
# ---------------------------------------------------------------------------
print("\n" + "=" * 70)
print("SECTION 2 — All trigger kinds (tick + body validation)")
print("=" * 70)

# Each entry: (label, category, merchant_id_suffix, signals, trigger_kind,
#              urgency, trigger_payload, scope, expect_send_as, expect_cta,
#              customer_id, customer_name)
TRIGGER_MATRIX = [
    # ── 1. research_digest ──────────────────────────────────────────────────
    {
        "label": "research_digest",
        "cat": "dentists",
        "suf": "rd",
        "signals": ["high_risk_adult_cohort"],
        "kind": "research_digest",
        "urgency": 4,
        "payload": {"top_item_id": "dig_001"},
        "send_as": "vera",
        "cta": "open_ended",
    },
    # ── 2. perf_dip ─────────────────────────────────────────────────────────
    {
        "label": "perf_dip",
        "cat": "restaurants",
        "suf": "pd",
        "signals": ["perf_dip_severe"],
        "kind": "perf_dip",
        "urgency": 5,
        "payload": {"metric": "calls", "delta_pct": 0.28, "vs_baseline": 80, "drop_pct": 28},
        "send_as": "vera",
        "cta": "open_ended",
    },
    # ── 3. seasonal_perf_dip ────────────────────────────────────────────────
    {
        "label": "seasonal_perf_dip",
        "cat": "restaurants",
        "suf": "spd",
        "signals": [],
        "kind": "seasonal_perf_dip",
        "urgency": 3,
        "payload": {"metric": "views", "delta_pct": 0.18, "vs_baseline": 200,
                    "is_expected_seasonal": True},
        "send_as": "vera",
        "cta": "open_ended",
    },
    # ── 4. renewal_due (normal — 10 days left) ──────────────────────────────
    {
        "label": "renewal_due_normal",
        "cat": "dentists",
        "suf": "rdn",
        "signals": [],
        "kind": "renewal_due",
        "urgency": 5,
        "payload": {"days_remaining": 10, "plan": "Pro", "renewal_amount": 4999},
        "send_as": "vera",
        "cta": "binary_yes_no",
    },
    # ── 5. recall_due ───────────────────────────────────────────────────────
    {
        "label": "recall_due",
        "cat": "dentists",
        "suf": "rcd",
        "signals": [],
        "kind": "recall_due",
        "urgency": 6,
        "payload": {
            "service_due": "cleaning",
            "last_service_date": "2025-11-01",
            "available_slots": [
                {"label": "Wed 7pm", "iso": "2026-05-06T19:00:00Z"},
                {"label": "Thu 6pm", "iso": "2026-05-07T18:00:00Z"},
            ],
        },
        "scope": "customer",
        "send_as": "merchant_on_behalf",
        "cta": "multi_choice_slot",
        "customer_id": "cust_rcd_001",
        "customer_name": "Priya Sharma",
    },
    # ── 6. competitor_opened ────────────────────────────────────────────────
    {
        "label": "competitor_opened",
        "cat": "dentists",
        "suf": "co",
        "signals": ["ctr_below_peer_median"],
        "kind": "competitor_opened",
        "urgency": 4,
        "payload": {"distance_km": 0.8, "their_offer": "free first consultation"},
        "send_as": "vera",
        "cta": "open_ended",
    },
    # ── 7. ipl_match_today ──────────────────────────────────────────────────
    {
        "label": "ipl_match_today",
        "cat": "restaurants",
        "suf": "ipl",
        "signals": [],
        "kind": "ipl_match_today",
        "urgency": 5,
        "payload": {
            "match": "RCB vs MI",
            "venue": "Chinnaswamy",
            "match_time_iso": "2026-05-01T14:00:00Z",
            "is_weeknight": True,
        },
        "send_as": "vera",
        "cta": "open_ended",
    },
    # ── 8. review_theme_emerged ─────────────────────────────────────────────
    {
        "label": "review_theme_emerged",
        "cat": "restaurants",
        "suf": "rte",
        "signals": [],
        "kind": "review_theme_emerged",
        "urgency": 3,
        "payload": {
            "theme": "wait_time",
            "occurrences_30d": 7,
            "trend": "rising",
            "common_quote": "waited 40 minutes for my order",
        },
        "send_as": "vera",
        "cta": "open_ended",
    },
    # ── 9. curious_ask_due ──────────────────────────────────────────────────
    {
        "label": "curious_ask_due",
        "cat": "dentists",
        "suf": "cad",
        "signals": [],
        "kind": "curious_ask_due",
        "urgency": 2,
        "payload": {},
        "send_as": "vera",
        "cta": "open_ended",
    },
    # ── 10. active_planning_intent (Tier 0 supremacy) ───────────────────────
    {
        "label": "active_planning_intent",
        "cat": "dentists",
        "suf": "api",
        "signals": [],
        "kind": "active_planning_intent",
        "urgency": 8,
        "payload": {
            "intent_topic": "whitening_launch",
            "merchant_last_message": "I want to do a teeth whitening campaign next month",
        },
        "send_as": "vera",
        "cta": "binary_confirm_cancel",
    },
    # ── 11. supply_alert (urgency=6 → critical + hard override) ─────────────
    {
        "label": "supply_alert",
        "cat": "pharmacies",
        "suf": "sa",
        "signals": [],
        "kind": "supply_alert",
        "urgency": 6,
        "payload": {
            "molecule": "Paracetamol 500mg",
            "affected_batches": ["B2204A", "B2204B"],
            "issue": "contamination",
            "alert_id": "alert_001",
        },
        "send_as": "vera",
        "cta": "binary_yes_no",
    },
    # ── 12. regulation_change (with future deadline) ─────────────────────────
    {
        "label": "regulation_change",
        "cat": "pharmacies",
        "suf": "rc",
        "signals": [],
        "kind": "regulation_change",
        "urgency": 5,
        "payload": {
            "top_item_id": "reg_001",
            "deadline_iso": "2026-05-20T00:00:00Z",
        },
        "send_as": "vera",
        "cta": "open_ended",
    },
    # ── 13. chronic_refill_due ───────────────────────────────────────────────
    {
        "label": "chronic_refill_due",
        "cat": "pharmacies",
        "suf": "crd",
        "signals": [],
        "kind": "chronic_refill_due",
        "urgency": 6,
        "payload": {
            "molecule_list": ["Metformin 500mg", "Amlodipine 5mg"],
            "stock_runs_out_iso": "2026-05-04T00:00:00Z",
        },
        "scope": "customer",
        "send_as": "merchant_on_behalf",
        "cta": "binary_yes_no",
        "customer_id": "cust_crd_001",
        "customer_name": "Rajan Mehta",
    },
    # ── 14. dormant_with_vera ────────────────────────────────────────────────
    {
        "label": "dormant_with_vera",
        "cat": "dentists",
        "suf": "dv",
        "signals": [],
        "kind": "dormant_with_vera",
        "urgency": 2,
        "payload": {"days_since_last_merchant_message": 32, "last_topic": "recall_campaign"},
        "send_as": "vera",
        "cta": "open_ended",
    },
    # ── 15. winback_eligible ────────────────────────────────────────────────
    {
        "label": "winback_eligible",
        "cat": "salons",
        "suf": "we",
        "signals": ["no_active_offers"],
        "kind": "winback_eligible",
        "urgency": 4,
        "payload": {"days_since_expiry": 45, "perf_dip_pct": 0.35,
                    "lapsed_customers_added_since_expiry": 12},
        "send_as": "vera",
        "cta": "open_ended",
    },
    # ── 16. festival_upcoming ────────────────────────────────────────────────
    {
        "label": "festival_upcoming",
        "cat": "salons",
        "suf": "fu",
        "signals": [],
        "kind": "festival_upcoming",
        "urgency": 3,
        "payload": {"festival": "Diwali", "days_until": 18},
        "send_as": "vera",
        "cta": "open_ended",
    },
    # ── 17. perf_spike ──────────────────────────────────────────────────────
    {
        "label": "perf_spike",
        "cat": "gyms",
        "suf": "ps",
        "signals": ["stale_posts:22d"],
        "kind": "perf_spike",
        "urgency": 3,
        "payload": {"metric": "views", "delta_pct": 0.42, "vs_baseline": 200},
        "send_as": "vera",
        "cta": "open_ended",
    },
    # ── 18. milestone_reached ────────────────────────────────────────────────
    {
        "label": "milestone_reached",
        "cat": "gyms",
        "suf": "mr",
        "signals": [],
        "kind": "milestone_reached",
        "urgency": 3,
        "payload": {"milestone_value": 150, "value_now": 148},
        "send_as": "vera",
        "cta": "open_ended",
    },
    # ── 19. trial_followup ──────────────────────────────────────────────────
    {
        "label": "trial_followup",
        "cat": "gyms",
        "suf": "tf",
        "signals": [],
        "kind": "trial_followup",
        "urgency": 4,
        "payload": {"next_session_options": [{"label": "Sat 8am"}]},
        "scope": "customer",
        "send_as": "merchant_on_behalf",
        "cta": "binary_yes_no",
        "customer_id": "cust_tf_001",
        "customer_name": "Kiran Das",
    },
    # ── 20. gbp_unverified ──────────────────────────────────────────────────
    {
        "label": "gbp_unverified",
        "cat": "dentists",
        "suf": "gbu",
        "signals": ["unverified_gbp"],
        "kind": "gbp_unverified",
        "urgency": 2,
        "payload": {"estimated_uplift_pct": 0.32},
        "send_as": "vera",
        "cta": "open_ended",
    },
    # ── 21. wedding_package_followup (default template path) ─────────────────
    {
        "label": "wedding_package_followup",
        "cat": "salons",
        "suf": "wpf",
        "signals": [],
        "kind": "wedding_package_followup",
        "urgency": 4,
        "payload": {},
        "send_as": "vera",
        "cta": "open_ended",
    },
    # ── 22. customer_lapsed_hard ─────────────────────────────────────────────
    {
        "label": "customer_lapsed_hard",
        "cat": "pharmacies",
        "suf": "clh",
        "signals": [],
        "kind": "customer_lapsed_hard",
        "urgency": 5,
        "payload": {},
        "send_as": "vera",
        "cta": "open_ended",
    },
    # ── 23. cde_opportunity ──────────────────────────────────────────────────
    {
        "label": "cde_opportunity",
        "cat": "dentists",
        "suf": "cde",
        "signals": [],
        "kind": "cde_opportunity",
        "urgency": 2,
        "payload": {},
        "send_as": "vera",
        "cta": "open_ended",
    },
    # ── 24. category_seasonal ────────────────────────────────────────────────
    {
        "label": "category_seasonal",
        "cat": "restaurants",
        "suf": "cs",
        "signals": [],
        "kind": "category_seasonal",
        "urgency": 2,
        "payload": {},
        "send_as": "vera",
        "cta": "open_ended",
    },
]

CATS = {
    "dentists": ("Vera Test Dental", "Anita"),
    "restaurants": ("Vera Dhaba", "Suresh"),
    "salons": ("Vera Salon", "Preethi"),
    "pharmacies": ("Vera Pharmacy", "Ravi"),
    "gyms": ("Vera Fitness", "Karan"),
}

def run_trigger_test(t: dict):
    cat = t["cat"]
    suf = t["suf"]
    mid = f"m_jt_{suf}"
    tid = f"trg_jt_{suf}"
    suppkey = f"jt:{suf}"
    name, owner = CATS[cat]
    cust_id = t.get("customer_id")
    cust_name = t.get("customer_name")
    scope = t.get("scope", "merchant")

    # Setup merchant
    offers = [{"status": "active", "type": "service_at_price",
               "title": f"{name} Special @ ₹499"}]
    POST("/context", merchant_ctx(mid, cat, name, owner, t.get("signals", []), offers))

    # Setup customer if needed
    if cust_id and cust_name:
        POST("/context", customer_ctx(cust_id, cust_name))

    # Setup trigger
    tc = trigger_ctx(tid, t["kind"], mid, t["urgency"], suppkey,
                     t.get("payload", {}), scope=scope, customer_id=cust_id)
    POST("/context", tc)

    # Tick
    r = tick([tid])
    actions = r.get("actions", [])
    a = assert_tick_action(
        t["label"], actions,
        expect_send_as=t.get("send_as"),
        expect_cta=t.get("cta"),
    )
    return a


conv_store = {}  # label → action dict (for reply tests)
for t in TRIGGER_MATRIX:
    a = run_trigger_test(t)
    if a:
        conv_store[t["label"]] = a


# ---------------------------------------------------------------------------
# Section 3: Decision engine — tier priority, cooldown, suppression
# ---------------------------------------------------------------------------
print("\n" + "=" * 70)
print("SECTION 3 — Decision engine (tiers, cooldown, suppression)")
print("=" * 70)

# ── 3a. Tier 0: active_planning_intent beats everything ─────────────────────
# Setup a fresh merchant with TWO triggers: active_planning_intent + supply_alert(urg=7)
DE_MID = "m_de_t0"
POST("/context", merchant_ctx(DE_MID, "dentists", "DE Dental", "Dev", [], [
    {"status": "active", "type": "service_at_price", "title": "Scaling @ ₹599"}
]))
POST("/context", trigger_ctx("trg_de_api", "active_planning_intent", DE_MID, 8,
                             "de:api", {"intent_topic": "fluoride_campaign"}))
POST("/context", trigger_ctx("trg_de_sa", "supply_alert", DE_MID, 7,
                             "de:sa", {"molecule": "Drug X", "affected_batches": ["B01"]}))
r_t0 = tick(["trg_de_api", "trg_de_sa"])
a_t0 = r_t0.get("actions", [])
check("Tier-0: active_planning_intent beats supply_alert(urg=7)",
      a_t0 and a_t0[0]["trigger_id"] == "trg_de_api",
      f"got trigger_id={a_t0[0]['trigger_id'] if a_t0 else 'empty'}")

# ── 3b. Tier 1: supply_alert(urg=5) beats competitor_opened ────────────────
DE_MID_T1 = "m_de_t1"
POST("/context", merchant_ctx(DE_MID_T1, "pharmacies", "DE Pharma", "Raj"))
POST("/context", trigger_ctx("trg_de_t1_sa", "supply_alert", DE_MID_T1, 5,
                             "de:t1sa", {"molecule": "Drug Y", "affected_batches": ["B02"]}))
POST("/context", trigger_ctx("trg_de_t1_co", "competitor_opened", DE_MID_T1, 8,
                             "de:t1co", {"distance_km": 0.5}))
r_t1 = tick(["trg_de_t1_sa", "trg_de_t1_co"])
a_t1 = r_t1.get("actions", [])
check("Tier-1: supply_alert(urg=5) hard-overrides competitor_opened(urg=8)",
      a_t1 and a_t1[0]["trigger_id"] == "trg_de_t1_sa",
      f"got trigger_id={a_t1[0]['trigger_id'] if a_t1 else 'empty'}")

# ── 3c. Tier 1: renewal_due(days=2) beats perf_dip ──────────────────────────
DE_MID_T1B = "m_de_t1b"
POST("/context", merchant_ctx(DE_MID_T1B, "dentists", "DE Dental 2", "Priya"))
POST("/context", trigger_ctx("trg_de_t1b_rd", "renewal_due", DE_MID_T1B, 5,
                             "de:t1brd", {"days_remaining": 2, "plan": "Pro"}))
POST("/context", trigger_ctx("trg_de_t1b_pd", "perf_dip", DE_MID_T1B, 8,
                             "de:t1bpd", {"metric": "calls", "delta_pct": 0.40, "vs_baseline": 100}))
r_t1b = tick(["trg_de_t1b_rd", "trg_de_t1b_pd"])
a_t1b = r_t1b.get("actions", [])
check("Tier-1: renewal_due(days=2) hard-overrides perf_dip(urg=8)",
      a_t1b and a_t1b[0]["trigger_id"] == "trg_de_t1b_rd",
      f"got trigger_id={a_t1b[0]['trigger_id'] if a_t1b else 'empty'}")

# ── 3d. Tier 2: regulation_change(deadline≤30d) beats curious_ask_due ────────
DE_MID_T2 = "m_de_t2"
POST("/context", merchant_ctx(DE_MID_T2, "dentists", "DE Dental 3", "Suma"))
POST("/context", trigger_ctx("trg_de_t2_rc", "regulation_change", DE_MID_T2, 3,
                             "de:t2rc", {"deadline_iso": "2026-05-20T00:00:00Z"}))
POST("/context", trigger_ctx("trg_de_t2_cad", "curious_ask_due", DE_MID_T2, 3,
                             "de:t2cad", {}))
r_t2 = tick(["trg_de_t2_rc", "trg_de_t2_cad"])
a_t2 = r_t2.get("actions", [])
check("Tier-2: regulation_change(deadline≤30d) soft-overrides curious_ask_due",
      a_t2 and a_t2[0]["trigger_id"] == "trg_de_t2_rc",
      f"got trigger_id={a_t2[0]['trigger_id'] if a_t2 else 'empty'}")

# ── 3e. Tier 2 NOT activated vs high-tier: regulation_change loses to perf_dip
#    regulation_change(urg=1, tier=9+1=10, score=30) vs perf_dip(urg=5, tier=7+5=12, score=36)
DE_MID_T2B = "m_de_t2b"
POST("/context", merchant_ctx(DE_MID_T2B, "dentists", "DE Dental 4", "Mohan"))
POST("/context", trigger_ctx("trg_de_t2b_rc", "regulation_change", DE_MID_T2B, 1,
                             "de:t2brc", {"deadline_iso": "2026-05-20T00:00:00Z"}))
POST("/context", trigger_ctx("trg_de_t2b_pd", "perf_dip", DE_MID_T2B, 5,
                             "de:t2bpd", {"metric": "calls", "delta_pct": 0.30, "vs_baseline": 90, "drop_pct": 30}))
r_t2b = tick(["trg_de_t2b_rc", "trg_de_t2b_pd"])
a_t2b = r_t2b.get("actions", [])
check("Soft-override NOT active vs perf_dip (high tier); perf_dip wins by score",
      a_t2b and a_t2b[0]["trigger_id"] == "trg_de_t2b_pd",
      f"got trigger_id={a_t2b[0]['trigger_id'] if a_t2b else 'empty'}")

# ── 3f. regulation_change without deadline: NOT a soft override ────────────
DE_MID_T2C = "m_de_t2c"
POST("/context", merchant_ctx(DE_MID_T2C, "dentists", "DE Dental 5", "Seema"))
POST("/context", trigger_ctx("trg_de_t2c_rc", "regulation_change", DE_MID_T2C, 1,
                             "de:t2crc", {}))           # no deadline_iso
POST("/context", trigger_ctx("trg_de_t2c_cad", "curious_ask_due", DE_MID_T2C, 3,
                             "de:t2ccad", {}))
r_t2c = tick(["trg_de_t2c_rc", "trg_de_t2c_cad"])
a_t2c = r_t2c.get("actions", [])
# Without deadline, regulation_change (tier=9+1=10, score=30) vs curious_ask_due (tier=3+3=6, score=18)
# Both in normal pool; regulation_change wins by raw score (no soft-override elevation issue)
check("regulation_change without deadline falls to normal scoring pool",
      bool(a_t2c), "expected normal scoring with a winner")
if a_t2c:
    winner = a_t2c[0]["trigger_id"]
    # Regulation_change has higher base tier (9 vs 3), so it wins by score even without deadline
    check("regulation_change(urg=1,no-deadline) wins over curious_ask_due(urg=3) by tier",
          winner == "trg_de_t2c_rc",
          f"got {winner} — tier(9+1)*3=30 > tier(3+3)*3=18")

# ── 3g. 6h cooldown blocks non-critical trigger ──────────────────────────────
DE_MID_6H = "m_de_6h"
POST("/context", merchant_ctx(DE_MID_6H, "dentists", "DE 6H Dental", "Arya"))
POST("/context", trigger_ctx("trg_de_6h_1", "research_digest", DE_MID_6H, 4,
                             "de:6h1", {"top_item_id": "dig_001"}))
POST("/context", trigger_ctx("trg_de_6h_2", "perf_dip", DE_MID_6H, 5,
                             "de:6h2", {"metric": "calls", "delta_pct": 0.20, "vs_baseline": 60}))
# First tick — fires research_digest (whichever wins)
r_6h1 = tick(["trg_de_6h_1"])
check("6h-cooldown: first tick fires", bool(r_6h1.get("actions")))
# Second tick 2h later — non-critical perf_dip should be blocked
r_6h2 = tick(["trg_de_6h_2"], now="2026-05-01T11:00:00Z")   # +2h
check("6h-cooldown: perf_dip blocked within 6h of last send",
      not r_6h2.get("actions"),
      f"got actions={r_6h2.get('actions')}")

# ── 3h. Critical trigger bypasses 6h cooldown ───────────────────────────────
DE_MID_BP = "m_de_bp"
POST("/context", merchant_ctx(DE_MID_BP, "pharmacies", "DE Bypass Pharma", "Nita"))
POST("/context", trigger_ctx("trg_de_bp_rd", "research_digest", DE_MID_BP, 4,
                             "de:bprd", {"top_item_id": "dig_001"}))
POST("/context", trigger_ctx("trg_de_bp_sa", "supply_alert", DE_MID_BP, 6,
                             "de:bpsa", {"molecule": "Amoxicillin", "affected_batches": ["B03"]}))
# Send first tick (research_digest) at T=09:00
tick(["trg_de_bp_rd"])
# Supply alert (critical, urg=6) at T=10:00 (+1h) — should bypass 6h gate
r_bp = tick(["trg_de_bp_sa"], now="2026-05-01T10:00:00Z")
a_bp = r_bp.get("actions", [])
check("Critical trigger (supply_alert urg=6) bypasses 6h cooldown",
      bool(a_bp) and a_bp[0]["trigger_id"] == "trg_de_bp_sa",
      f"got {a_bp}")

# ── 3i. Suppression key prevents re-firing ──────────────────────────────────
DE_MID_SUP = "m_de_sup"
POST("/context", merchant_ctx(DE_MID_SUP, "dentists", "DE Suppress Dental", "Gita"))
POST("/context", trigger_ctx("trg_de_sup1", "perf_dip", DE_MID_SUP, 5,
                             "de:sup1", {"metric": "calls", "delta_pct": 0.20, "vs_baseline": 80}))
POST("/context", trigger_ctx("trg_de_sup2", "perf_dip", DE_MID_SUP, 5,
                             "de:sup1", {"metric": "calls", "delta_pct": 0.22, "vs_baseline": 80}))  # same suppkey!
r_sup1 = tick(["trg_de_sup1"])
check("Suppression: first fire succeeds", bool(r_sup1.get("actions")))
# After suppression, same suppkey trigger (sup2) must not fire (even with new trigger_id)
r_sup2 = tick(["trg_de_sup2"], now="2026-05-01T20:00:00Z")   # outside 6h but suppressed
check("Suppression: same suppression_key re-fire blocked",
      not r_sup2.get("actions"),
      f"got actions={r_sup2.get('actions')}")

# ── 3j. Expired trigger is ignored ───────────────────────────────────────────
DE_MID_EXP = "m_de_exp"
POST("/context", merchant_ctx(DE_MID_EXP, "dentists", "DE Expired Dental", "Lata"))
POST("/context", trigger_ctx("trg_de_exp", "perf_dip", DE_MID_EXP, 5,
                             "de:exp", {"metric": "calls", "delta_pct": 0.15, "vs_baseline": 70},
                             expires_at="2026-04-30T23:59:00Z"))   # expired before NOW
r_exp = tick(["trg_de_exp"])
check("Expired trigger is ignored by tick",
      not r_exp.get("actions"),
      f"got actions={r_exp.get('actions')}")

# ── 3k. Waiting conv blocks tick (no bypass, not even for critical) ──────────
DE_MID_WC = "m_de_wc"
POST("/context", merchant_ctx(DE_MID_WC, "dentists", "DE WaitConv Dental", "Ritu"))
POST("/context", trigger_ctx("trg_de_wc1", "perf_dip", DE_MID_WC, 5,
                             "de:wc1", {"metric": "calls", "delta_pct": 0.25, "vs_baseline": 80}))
POST("/context", trigger_ctx("trg_de_wc2", "active_planning_intent", DE_MID_WC, 9,
                             "de:wc2", {"intent_topic": "expansion"}))
r_wc1 = tick(["trg_de_wc1"])
a_wc1 = r_wc1.get("actions", [])
cid_wc = a_wc1[0]["conversation_id"] if a_wc1 else None
check("Waiting conv setup: tick1 fires perf_dip", bool(a_wc1))
if cid_wc:
    # Auto-reply → conv enters waiting state (wait_until +4h from 09:05)
    POST("/reply", {"conversation_id": cid_wc, "from_role": "merchant",
                    "message": "Thank you for contacting DE WaitConv Dental! We'll respond shortly.",
                    "received_at": "2026-05-01T09:05:00Z", "turn_number": 2})
    # Tick at +2h (within wait window AND within 6h gate): active_planning_intent must also be blocked
    r_wc2 = tick(["trg_de_wc2"], now="2026-05-01T11:00:00Z")
    check("Waiting conv blocks even active_planning_intent (no bypass)",
          not r_wc2.get("actions"),
          f"got actions={r_wc2.get('actions')}")

# ---------------------------------------------------------------------------
# Section 4: Reply state machine
# ---------------------------------------------------------------------------
print("\n" + "=" * 70)
print("SECTION 4 — Reply state machine")
print("=" * 70)

# Helper: fresh merchant + tick to get a conversation_id
def fresh_conv(suf: str, cat="dentists", kind="research_digest",
               urg=4, tpayload=None, now=NOW):
    mid = f"m_rp_{suf}"
    tid = f"trg_rp_{suf}"
    name, owner = CATS[cat]
    POST("/context", merchant_ctx(mid, cat, name, owner))
    POST("/context", trigger_ctx(tid, kind, mid, urg, f"rp:{suf}", tpayload or {}))
    r = tick([tid], now=now)
    actions = r.get("actions", [])
    return (actions[0]["conversation_id"] if actions else None,
            actions[0].get("body", "") if actions else "")


# ── 4a. Auto-reply → wait 14400s ─────────────────────────────────────────────
cid_ar, _ = fresh_conv("ar")
check("auto-reply setup: tick fires", bool(cid_ar))
if cid_ar:
    r_ar = reply(cid_ar, "Thank you for contacting us! We will get back to you soon.", 2,
                 received_at="2026-05-01T09:05:00Z")
    check("auto-reply: action=wait", r_ar.get("action") == "wait",
          f"got action={r_ar.get('action')!r}")
    check("auto-reply: wait_seconds=14400", r_ar.get("wait_seconds") == 14400,
          f"got wait_seconds={r_ar.get('wait_seconds')}")

# ── 4b. Opt-out → action:end + suppression ───────────────────────────────────
cid_out, _ = fresh_conv("out", kind="perf_dip", urg=5,
                         tpayload={"metric": "calls", "delta_pct": 0.22, "vs_baseline": 70})
check("opt-out setup: tick fires", bool(cid_out))
if cid_out:
    r_out = reply(cid_out, "STOP. Don't message me again.", 2)
    check("opt-out: action=end", r_out.get("action") == "end",
          f"got action={r_out.get('action')!r}")

# ── 4c. Positive → exec turn with PUBLISH CTA ────────────────────────────────
cid_pos, _ = fresh_conv("pos", kind="research_digest", urg=4, tpayload={"top_item_id": "dig_001"})
check("positive-exec setup: tick fires", bool(cid_pos))
if cid_pos:
    r_pos = reply(cid_pos, "Yes please, send it!", 2)
    check("positive: action=send", r_pos.get("action") == "send",
          f"got action={r_pos.get('action')!r}")
    body_pos = r_pos.get("body", "")
    check("positive: exec turn has PUBLISH CTA",
          "This is yours to edit" in body_pos,
          f"body={body_pos[:100]!r}")

# ── 4d. topic_bias from non-positive turn, used in exec turn ──────────────────
cid_tb, _ = fresh_conv("tb", kind="research_digest", urg=4, tpayload={"top_item_id": "dig_001"})
check("topic_bias setup: tick fires", bool(cid_tb))
if cid_tb:
    # First: non-positive reply that includes a topic focus keyword
    r_tb1 = reply(cid_tb, "Can you focus on fluoride varnish for kids?", 2)
    check("topic_bias: clarify turn handled", r_tb1.get("action") == "send",
          f"got action={r_tb1.get('action')!r}")
    # Second: positive reply → exec turn should use fluoride varnish as topic_bias
    r_tb2 = reply(cid_tb, "Yes, that sounds great!", 3)
    check("topic_bias: exec turn action=send", r_tb2.get("action") == "send")
    body_tb2 = r_tb2.get("body", "")
    check("topic_bias: exec turn contains 'fluoride' or 'fluoride varnish'",
          "fluoride" in body_tb2.lower() or "varnish" in body_tb2.lower(),
          f"body={body_tb2[:120]!r}")
    check("topic_bias: exec turn has PUBLISH CTA",
          "This is yours to edit" in body_tb2,
          f"body={body_tb2[:120]!r}")

# ── 4e. Out-of-scope request → polite redirect + stay open ───────────────────
cid_oos, _ = fresh_conv("oos", kind="perf_dip", urg=5,
                          tpayload={"metric": "calls", "delta_pct": 0.22, "vs_baseline": 70})
check("out-of-scope setup: tick fires", bool(cid_oos))
if cid_oos:
    r_oos = reply(cid_oos, "Can you help me with GST filing?", 2)
    check("out-of-scope: action=send (not end)", r_oos.get("action") == "send",
          f"got action={r_oos.get('action')!r}")
    body_oos = r_oos.get("body", "")
    check("out-of-scope: redirect message mentions returning to topic",
          any(w in body_oos.lower() for w in ["coming back", "leave that", "expert"]),
          f"body={body_oos[:100]!r}")

# ── 4f. Ambiguous / unclear → clarify with binary CTA ───────────────────────
cid_amb, _ = fresh_conv("amb", kind="perf_dip", urg=5,
                          tpayload={"metric": "calls", "delta_pct": 0.22, "vs_baseline": 70})
check("clarify setup: tick fires", bool(cid_amb))
if cid_amb:
    r_amb = reply(cid_amb, "Hmm, maybe, I'm not sure about this", 2)
    check("ambiguous: action=send", r_amb.get("action") == "send",
          f"got action={r_amb.get('action')!r}")
    check("ambiguous: cta=binary_yes_no", r_amb.get("cta") == "binary_yes_no",
          f"got cta={r_amb.get('cta')!r}")

# ── 4g. Ended conversation → action:end on any reply ─────────────────────────
cid_ended, _ = fresh_conv("ended", kind="perf_dip", urg=5,
                            tpayload={"metric": "calls", "delta_pct": 0.22, "vs_baseline": 70})
check("ended-conv setup: tick fires", bool(cid_ended))
if cid_ended:
    POST("/reply", {"conversation_id": cid_ended, "from_role": "merchant",
                    "message": "Stop contacting me.", "received_at": NOW, "turn_number": 2})
    # Now reply to the ended conversation
    r_ended = reply(cid_ended, "Actually wait, can you help?", 3)
    check("ended-conv: subsequent reply returns action=end",
          r_ended.get("action") == "end",
          f"got action={r_ended.get('action')!r}")

# ── 4h. Wait window expires → tick fires after cooldown AND wait clear ────────
WAIT_MID = "m_rp_waitexp"
POST("/context", merchant_ctx(WAIT_MID, "dentists", "WaitExp Dental", "Mira"))
POST("/context", trigger_ctx("trg_rp_we1", "perf_dip", WAIT_MID, 5,
                             "rp:we1", {"metric": "calls", "delta_pct": 0.28, "vs_baseline": 80}))
POST("/context", trigger_ctx("trg_rp_we2", "perf_dip", WAIT_MID, 5,
                             "rp:we2", {"metric": "calls", "delta_pct": 0.30, "vs_baseline": 80}))
r_we1 = tick(["trg_rp_we1"], now="2026-05-01T08:00:00Z")
a_we1 = r_we1.get("actions", [])
cid_we = a_we1[0]["conversation_id"] if a_we1 else None
check("wait-expiry setup: initial tick fires", bool(a_we1))
if cid_we:
    POST("/reply", {"conversation_id": cid_we, "from_role": "merchant",
                    "message": "Thank you for contacting us! We'll respond shortly.",
                    "received_at": "2026-05-01T08:05:00Z", "turn_number": 2})
    # wait_until = 08:05 + 4h = 12:05; 6h gate clears at 08:00+6h = 14:00
    r_we2 = tick(["trg_rp_we2"], now="2026-05-01T10:00:00Z")  # inside wait window
    check("wait-expiry: tick blocked inside wait window (T+2h)",
          not r_we2.get("actions"),
          f"got actions={r_we2.get('actions')}")
    r_we3 = tick(["trg_rp_we2"], now="2026-05-01T15:00:00Z")  # after both gates
    check("wait-expiry: tick fires after wait AND 6h gate cleared (T+7h)",
          bool(r_we3.get("actions")),
          f"got empty — both wait(12:05) and 6h gate(14:00) should be cleared")

# ── 4i. renewal_due Tier-1 hard override bypasses 6h for <=3 days ─────────────
RENEW_MID = "m_rp_renewbp"
POST("/context", merchant_ctx(RENEW_MID, "dentists", "Renew Dental", "Deepa"))
POST("/context", trigger_ctx("trg_rp_rd_init", "research_digest", RENEW_MID, 4,
                             "rp:rdini", {"top_item_id": "dig_001"}))
POST("/context", trigger_ctx("trg_rp_rd_crit", "renewal_due", RENEW_MID, 5,
                             "rp:rdcrit", {"days_remaining": 2, "plan": "Pro"}))
tick(["trg_rp_rd_init"], now="2026-05-01T09:00:00Z")   # set last send
# 3h later, renewal_due(days=2) is critical — must bypass 6h gate
r_renew = tick(["trg_rp_rd_crit"], now="2026-05-01T12:00:00Z")
a_renew = r_renew.get("actions", [])
check("renewal_due(days=2) bypasses 6h cooldown as critical trigger",
      bool(a_renew) and a_renew[0]["trigger_id"] == "trg_rp_rd_crit",
      f"got {a_renew}")

# ── 4j. Context idempotency: stale version rejected ──────────────────────────
POST("/context", merchant_ctx("m_idem", "dentists", "Idem Dental", "Idem", [], [], version_check=False)
     if False else merchant_ctx("m_idem", "dentists", "Idem Dental", "Idem"))
POST("/context", {"scope": "merchant", "context_id": "m_idem", "version": 2,
                  "payload": {"merchant_id": "m_idem", "category_slug": "dentists",
                              "signals": [], "identity": {"name": "Idem v2", "owner_first_name": "Idem"}}})
r_idem_stale = POST("/context", {"scope": "merchant", "context_id": "m_idem", "version": 1,
                                  "payload": {"merchant_id": "m_idem", "category_slug": "dentists",
                                              "signals": [], "identity": {"name": "Old", "owner_first_name": "Old"}}})
check("context idempotency: stale version rejected",
      r_idem_stale.get("accepted") is False and r_idem_stale.get("reason") == "stale_version",
      f"got {r_idem_stale}")

# ---------------------------------------------------------------------------
# Section 5: Qualitative message quality
# ---------------------------------------------------------------------------
print("\n" + "=" * 70)
print("SECTION 5 — Qualitative message quality (grounding, compulsion, safety)")
print("=" * 70)

# Universal compulsion signals — at least one must appear in every body
COMPULSION_WORDS = [
    "today", "tonight", "days", "deadline", "peers", "nearby",
    "dropped", "lapsed", "already drafted", "ready in", "can send in",
    "₹", "slot", "pipeline", "batch", "trial", "%", "expires", "views",
    "calls", "spotted", "upcoming", "week",
]

# Generic phrases that betray weak, uncausal copy — none must appear
BANNED_PHRASES = [
    "boost sales",
    "improve growth",
    "let me know",
    "increase visibility",
    "take your business",
    "we can help",
]

# Trigger-kind grounding: flexible keyword sets expected in each body
TRIGGER_GROUNDING: dict[str, list[str]] = {
    "research_digest":        ["patient", "trial", "abstract", "finding", "research", "2 min", "dig"],
    "perf_dip":               ["dropped", "drop", "calls", "vs", "%", "baseline"],
    "seasonal_perf_dip":      ["dip", "seasonal", "vs", "views"],
    "renewal_due_normal":     ["expires", "days", "plan", "pipeline"],
    "recall_due":             ["slot", "month", "cleaning", "recall"],
    "competitor_opened":      ["km", "counter", "offer", "competitor", "away"],
    "ipl_match_today":        ["match", "delivery", "tonight", "ipl", "rcb", "mi", "dc"],
    "review_theme_emerged":   ["review", "mention", "wait", "theme", "7"],
    "curious_ask_due":        ["service", "week", "asked", "demand"],
    "active_planning_intent": ["plan", "whitening", "campaign", "picked", "review"],
    "supply_alert":           ["batch", "flagged", "alert", "pull", "B2204"],
    "regulation_change":      ["rule", "effective", "revised", "deadline", "compliance", "₹50"],
    "chronic_refill_due":     ["Metformin", "Amlodipine", "days", "refill", "dispatch"],
    "dormant_with_vera":      ["32", "days", "recall", "useful", "week"],
    "winback_eligible":       ["days", "dropped", "expired", "views", "45"],
    "festival_upcoming":      ["diwali", "18 days", "18", "festival", "bookings"],
    "perf_spike":             ["up", "views", "vs", "%", "42"],
    "milestone_reached":      ["150", "reviews", "milestone", "crossed"],
    "trial_followup":         ["trial", "slot", "sat", "confirm"],
    "gbp_unverified":         ["verified", "profile", "%", "google", "visibility"],
    # Default-template path triggers — broader checks
    "wedding_package_followup": ["follow", "draft", "send", "₹"],
    "customer_lapsed_hard":     ["draft", "send", "₹", "follow"],
    "cde_opportunity":          ["draft", "send", "₹", "follow"],
    "category_seasonal":        ["draft", "send", "₹", "follow"],
}

for t in TRIGGER_MATRIX:
    label = t["label"]
    a = conv_store.get(label)
    if not a:
        # tick didn't fire — already failed in Section 2, skip qualitative checks
        continue
    body = a.get("body", "")
    lo = body.lower()
    cat = t["cat"]
    mid = f"m_jt_{t['suf']}"
    merchant_name, owner_name = CATS[cat]

    # ── 5.1 Trigger grounding ────────────────────────────────────────────
    grounding_kws = TRIGGER_GROUNDING.get(label, [])
    if grounding_kws:
        hit = any(kw.lower() in lo for kw in grounding_kws)
        check(f"[{label}] trigger grounding: mentions trigger context",
              hit, f"expected one of {grounding_kws[:4]} in body={body[:80]!r}")

    # ── 5.2 Causal structure: problem + number + action phrase ───────────
    has_number = bool(re.search(r"\d", body))
    has_action = any(phrase in lo for phrase in [
        "already drafted", "can send", "ready", "drafted", "pull", "dispatch",
        "drafted", "review", "confirm", "slot", "want me to", "shall i",
        "send it", "send this", "reply", "proceed", "schedule",
    ])
    check(f"[{label}] causal structure: has number + action phrase",
          has_number and has_action,
          f"number={has_number} action={has_action} body={body[:80]!r}")

    # ── 5.3 Compulsion enforcement ───────────────────────────────────────
    has_compulsion = any(cw.lower() in lo for cw in COMPULSION_WORDS)
    check(f"[{label}] compulsion: urgency/social-proof/loss signal present",
          has_compulsion, f"body={body[:80]!r}")

    # ── 5.4 No banned generic phrases ───────────────────────────────────
    banned_hit = [b for b in BANNED_PHRASES if b in lo]
    check(f"[{label}] no banned generic phrases", not banned_hit,
          f"found: {banned_hit} in body={body[:80]!r}")

    # ── 5.5 Merchant grounding ───────────────────────────────────────────
    has_merchant = (
        merchant_name.lower() in lo
        or owner_name.lower() in lo
        or "₹" in body
        or "koramangala" in lo
    )
    check(f"[{label}] merchant grounding: name, owner, offer, or locality",
          has_merchant, f"body={body[:80]!r}")

# ---------------------------------------------------------------------------
# Section 6: Execution turn quality (positive reply → concrete artifact)
# ---------------------------------------------------------------------------
print("\n" + "=" * 70)
print("SECTION 6 — Execution turn quality (positive reply → concrete artifact)")
print("=" * 70)

# Each exec test uses its own merchant ID + unique future `now` to guarantee
# zero 6h-cooldown or waiting-conv interference across iterations.
EXEC_TRIGGERS = [
    ("ex_rd",  "dentists",    "research_digest",        4, {"top_item_id": "dig_001"},
     "2026-05-10T09:00:00Z"),
    ("ex_pd",  "restaurants", "perf_dip",               5, {"metric": "calls", "delta_pct": 0.30, "vs_baseline": 80},
     "2026-05-11T09:00:00Z"),
    ("ex_sa",  "pharmacies",  "supply_alert",           6, {"molecule": "Paracetamol 500mg",
                                                             "affected_batches": ["B2204A"], "issue": "contamination"},
     "2026-05-12T09:00:00Z"),
    ("ex_api", "dentists",    "active_planning_intent", 8, {"intent_topic": "teeth_whitening",
                                                            "merchant_last_message": "I want to launch a whitening offer"},
     "2026-05-13T09:00:00Z"),
    ("ex_rc",  "pharmacies",  "regulation_change",      5, {"deadline_iso": "2026-05-20T00:00:00Z"},
     "2026-05-14T09:00:00Z"),
]

for (suf, cat, kind, urg, tpl, ex_now) in EXEC_TRIGGERS:
    ex_mid = f"m_{suf}"
    ex_tid = f"trg_{suf}"
    ex_name, ex_owner = CATS[cat]
    POST("/context", merchant_ctx(ex_mid, cat, ex_name, ex_owner, [], [
        {"status": "active", "type": "service_at_price", "title": f"{ex_name} @ ₹499"}]))
    POST("/context", trigger_ctx(ex_tid, kind, ex_mid, urg, f"ex:{suf}", tpl))
    r_ex = tick([ex_tid], now=ex_now)
    ex_actions = r_ex.get("actions", [])
    if not ex_actions:
        check(f"[exec/{kind}] tick fired for exec test", False, "no actions returned")
        continue
    ex_cid = ex_actions[0]["conversation_id"]
    # Send positive reply → exec turn
    r_exec = POST("/reply", {
        "conversation_id": ex_cid, "from_role": "merchant",
        "message": "Yes, please go ahead and send it!",
        "received_at": NOW, "turn_number": 2,
    })
    check(f"[exec/{kind}] positive reply → action=send", r_exec.get("action") == "send",
          f"got action={r_exec.get('action')!r}")
    ex_body = r_exec.get("body", "")
    check(f"[exec/{kind}] exec body len > 80 chars", len(ex_body) > 80,
          f"len={len(ex_body)} body={ex_body[:60]!r}")
    check(f"[exec/{kind}] exec body is multi-line (≥2 lines)",
          len(ex_body.split("\n")) >= 2, f"lines={len(ex_body.split(chr(10)))}")
    # supply_alert exec turns are patient safety notices — accept batch/recall markers too
    if kind == "supply_alert":
        has_concrete = (
            "₹" in ex_body or "%" in ex_body
            or any(w in ex_body.lower() for w in ["batch", "flagged", "affected", "recall", "safety"])
        )
    else:
        has_concrete = "₹" in ex_body or "%" in ex_body
    check(f"[exec/{kind}] exec body has ₹/% or domain-specific marker",
          has_concrete, f"body={ex_body[:100]!r}")
    check(f"[exec/{kind}] exec body has PUBLISH CTA",
          "This is yours to edit" in ex_body, f"body={ex_body[:100]!r}")
    # No banned phrases in exec turn either
    lo_ex = ex_body.lower()
    banned_ex = [b for b in BANNED_PHRASES if b in lo_ex]
    check(f"[exec/{kind}] exec body has no banned generic phrases",
          not banned_ex, f"found: {banned_ex}")

# ---------------------------------------------------------------------------
# Section 7: Stronger specificity — not just digit, but vs/₹/% required
# ---------------------------------------------------------------------------
print("\n" + "=" * 70)
print("SECTION 7 — Stronger specificity (vs / ₹ / % required for key triggers)")
print("=" * 70)

# Triggers where a bare digit isn't enough — need contextual number
SPECIFICITY_TRIGGERS = [
    ("perf_dip",       "perf_dip: must have % or 'vs' (comparative drop)"),
    ("renewal_due_normal", "renewal_due: must have ₹ (renewal price)"),
    ("competitor_opened",  "competitor_opened: must have ₹ or % or km number"),
    ("winback_eligible",   "winback_eligible: must have % or days count"),
    ("perf_spike",         "perf_spike: must have % or 'vs' (comparative rise)"),
]

for (label, description) in SPECIFICITY_TRIGGERS:
    a = conv_store.get(label)
    if not a:
        continue
    body = a.get("body", "")
    has_strong_spec = (
        " vs " in body
        or "₹" in body
        or "%" in body
        or bool(re.search(r"\d+\s*(km|days?|months?|slots?)", body, re.IGNORECASE))
    )
    check(f"[specificity/{label}] {description}", has_strong_spec,
          f"body={body[:100]!r}")

# ---------------------------------------------------------------------------
# Section 8: No-action edge cases
# ---------------------------------------------------------------------------
print("\n" + "=" * 70)
print("SECTION 8 — No-action edge cases (system correctly returns empty actions)")
print("=" * 70)

# ── 8a. Trigger referencing non-existent merchant → actions=[] ───────────────
POST("/context", trigger_ctx("trg_noact_ghost", "perf_dip", "m_ghost_9999", 5,
                             "noact:ghost", {"metric": "calls", "delta_pct": 0.25, "vs_baseline": 80}))
r_ghost = tick(["trg_noact_ghost"])
check("no-action: trigger for non-existent merchant → actions=[]",
      not r_ghost.get("actions"),
      f"got actions={r_ghost.get('actions')}")

# ── 8b. Trigger referencing non-existent category → actions=[] ───────────────
POST("/context", {
    "scope": "merchant", "context_id": "m_nocat_test", "version": 1,
    "payload": {"merchant_id": "m_nocat_test", "category_slug": "undefined_category_xyz",
                "signals": [], "identity": {"name": "NoCat Test", "owner_first_name": "Test"}},
})
POST("/context", trigger_ctx("trg_noact_nocat", "perf_dip", "m_nocat_test", 5,
                             "noact:nocat", {"metric": "calls", "delta_pct": 0.25, "vs_baseline": 80}))
r_nocat = tick(["trg_noact_nocat"])
check("no-action: merchant with unknown category_slug → actions=[]",
      not r_nocat.get("actions"),
      f"got actions={r_nocat.get('actions')}")

# ── 8c. Only suppressed trigger in list → actions=[] ─────────────────────────
# Reuse a trigger that was already suppressed in Section 2 (e.g., "jt:rd" from research_digest)
r_suppressed = tick(["trg_jt_rd"])   # suppressed in Section 2
check("no-action: only suppressed triggers in list → actions=[]",
      not r_suppressed.get("actions"),
      f"got actions={r_suppressed.get('actions')}")

# ── 8d. Empty available_triggers list → actions=[] ───────────────────────────
r_empty = tick([])
check("no-action: empty available_triggers list → actions=[]",
      not r_empty.get("actions"),
      f"got actions={r_empty.get('actions')}")

# ── 8e. All triggers expired → actions=[] ────────────────────────────────────
NA_MID = "m_noact_exp"
POST("/context", merchant_ctx(NA_MID, "dentists", "NoAct Dental", "Noact"))
POST("/context", trigger_ctx("trg_noact_exp1", "perf_dip", NA_MID, 5,
                             "noact:exp1", {"metric": "calls", "delta_pct": 0.20, "vs_baseline": 80},
                             expires_at="2026-04-01T00:00:00Z"))
POST("/context", trigger_ctx("trg_noact_exp2", "research_digest", NA_MID, 4,
                             "noact:exp2", {"top_item_id": "dig_001"},
                             expires_at="2026-04-01T00:00:00Z"))
r_allexp = tick(["trg_noact_exp1", "trg_noact_exp2"])
check("no-action: all triggers past expires_at → actions=[]",
      not r_allexp.get("actions"),
      f"got actions={r_allexp.get('actions')}")

# ---------------------------------------------------------------------------
# Section 9: Structural determinism
# ---------------------------------------------------------------------------
print("\n" + "=" * 70)
print("SECTION 9 — Structural determinism (identical configs → same structure)")
print("=" * 70)

# Two merchants with identical configs → both perf_dip bodies must share
# the same structural markers (%, vs, drop language, merchant name pattern)
for det_idx in ("A", "B"):
    det_mid = f"m_det_{det_idx}"
    det_tid = f"trg_det_{det_idx}"
    POST("/context", merchant_ctx(det_mid, "dentists", "DetTest Dental", "DetOwner",
                                  ["perf_dip_severe"],
                                  [{"status": "active", "type": "service_at_price",
                                    "title": "Scaling @ ₹399"}],
                                  {"calls": 60, "views": 300, "leads": 10, "delta_7d": {}}))
    POST("/context", trigger_ctx(det_tid, "perf_dip", det_mid, 5, f"det:{det_idx}",
                                 {"metric": "calls", "delta_pct": 0.30, "vs_baseline": 60}))

r_detA = tick(["trg_det_A"], now="2026-05-02T09:00:00Z")
r_detB = tick(["trg_det_B"], now="2026-05-03T09:00:00Z")  # different day avoids cooldown overlap
bodyA = (r_detA.get("actions") or [{}])[0].get("body", "")
bodyB = (r_detB.get("actions") or [{}])[0].get("body", "")

check("determinism: both instances fired", bool(bodyA) and bool(bodyB),
      f"bodyA={bool(bodyA)} bodyB={bool(bodyB)}")

# Both must share same structural markers (trigger-kind keywords)
shared_markers = ["calls", "dropped", "drafted", "DetTest"]
for marker in shared_markers:
    check(f"determinism: both bodies contain '{marker}'",
          marker.lower() in bodyA.lower() and marker.lower() in bodyB.lower(),
          f"bodyA has={marker.lower() in bodyA.lower()} bodyB has={marker.lower() in bodyB.lower()}")

# Both must have same template structural shape (same CTA type)
ctaA = r_detA.get("actions", [{}])[0].get("cta", "")
ctaB = r_detB.get("actions", [{}])[0].get("cta", "")
check("determinism: both instances produce same CTA type", ctaA == ctaB,
      f"ctaA={ctaA!r} ctaB={ctaB!r}")

# ---------------------------------------------------------------------------
# Section 10: Weak context fallback (no offers, minimal metrics)
# ---------------------------------------------------------------------------
print("\n" + "=" * 70)
print("SECTION 10 — Weak context fallback (no offers, minimal metrics)")
print("=" * 70)

# Merchant with NO offers and minimal performance data
WC_MID = "m_weakctx"
POST("/context", {
    "scope": "merchant", "context_id": WC_MID, "version": 1,
    "payload": {
        "merchant_id": WC_MID,
        "category_slug": "dentists",
        "signals": [],
        "identity": {"name": "WeakCtx Dental", "owner_first_name": "Weak"},
        "performance": {"calls": 0, "views": 0, "leads": 0, "delta_7d": {}},
        "offers": [],       # intentionally empty
        "customer_aggregate": {"total_unique_ytd": 0},
    },
})

# perf_dip — needs real numbers, will fall back to trigger payload data
POST("/context", trigger_ctx("trg_wc_pd", "perf_dip", WC_MID, 5,
                             "wc:pd", {"metric": "calls", "delta_pct": 0.40, "vs_baseline": 50}))
r_wc = tick(["trg_wc_pd"])
wc_actions = r_wc.get("actions", [])
check("weak-ctx: perf_dip fires even with no offers or performance data",
      bool(wc_actions), f"got actions={wc_actions}")
if wc_actions:
    wc_body = wc_actions[0].get("body", "")
    check("weak-ctx: body still contains a number (from trigger payload)",
          bool(re.search(r"\d", wc_body)), f"body={wc_body[:80]!r}")
    check("weak-ctx: body len ≤ 600 chars", len(wc_body) <= 600, f"len={len(wc_body)}")

# research_digest with no offers → body uses category catalog offer
POST("/context", trigger_ctx("trg_wc_rd", "research_digest", WC_MID, 4,
                             "wc:rd", {"top_item_id": "dig_001"}))
# Need fresh merchant timestamp to bypass 6h gate — use later time
r_wc_rd = tick(["trg_wc_rd"], now="2026-05-02T10:00:00Z")
wc_rd_actions = r_wc_rd.get("actions", [])
check("weak-ctx: research_digest fires even with no merchant offers",
      bool(wc_rd_actions), f"got actions={wc_rd_actions}")
if wc_rd_actions:
    wc_rd_body = wc_rd_actions[0].get("body", "")
    check("weak-ctx: research_digest body still has digit (trial_n from category digest)",
          bool(re.search(r"\d", wc_rd_body)), f"body={wc_rd_body[:80]!r}")

# ---------------------------------------------------------------------------
# Section 11: Latency safety
# ---------------------------------------------------------------------------
print("\n" + "=" * 70)
print("SECTION 11 — Latency safety (endpoints respond under threshold)")
print("=" * 70)

import time

LATENCY_MID = "m_latency"
POST("/context", merchant_ctx(LATENCY_MID, "dentists", "Latency Dental", "Lata"))
POST("/context", trigger_ctx("trg_lat_pd", "perf_dip", LATENCY_MID, 5,
                             "lat:pd", {"metric": "calls", "delta_pct": 0.25, "vs_baseline": 80}))

# ── 11a. Tick latency ─────────────────────────────────────────────────────────
t0 = time.time()
r_lat = tick(["trg_lat_pd"])
tick_ms = (time.time() - t0) * 1000
lat_actions = r_lat.get("actions", [])
check("latency: tick responds in <10 000ms", tick_ms < 10_000,
      f"took {tick_ms:.0f}ms")
check("latency: tick response is valid (action present)", bool(lat_actions),
      f"got {r_lat}")

# ── 11b. Healthz latency (should be < 500ms) ──────────────────────────────────
t1 = time.time()
GET("/healthz")
hz_ms = (time.time() - t1) * 1000
check("latency: healthz responds in <500ms", hz_ms < 500,
      f"took {hz_ms:.0f}ms")

# ── 11c. Reply latency (positive → exec turn, includes LLM call) ─────────────
if lat_actions:
    lat_cid = lat_actions[0]["conversation_id"]
    t2 = time.time()
    r_lat_reply = POST("/reply", {
        "conversation_id": lat_cid, "from_role": "merchant",
        "message": "Yes please", "received_at": NOW, "turn_number": 2,
    })
    reply_ms = (time.time() - t2) * 1000
    check("latency: reply (exec turn + LLM) responds in <10 000ms",
          reply_ms < 10_000, f"took {reply_ms:.0f}ms")
    # If LLM took too long, must have fallen back to template (not error)
    check("latency: reply returned valid action even if LLM was slow",
          r_lat_reply.get("action") in ("send", "wait", "end"),
          f"got action={r_lat_reply.get('action')!r}")
    print(f"           ℹ tick={tick_ms:.0f}ms | healthz={hz_ms:.0f}ms | reply={reply_ms:.0f}ms")

# ---------------------------------------------------------------------------
# Final summary
# ---------------------------------------------------------------------------
print("\n" + "=" * 70)
total = len(passed) + len(failed)
print(f"TOTAL: {len(passed)}/{total} passed")
if failed:
    print(f"\nFAILED ({len(failed)}):")
    for f in failed:
        print(f"  ✗ {f}")
else:
    print("\nALL TESTS PASSED ✓")
print("=" * 70)

if failed:
    sys.exit(1)
