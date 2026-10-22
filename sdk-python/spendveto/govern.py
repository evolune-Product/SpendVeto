"""Client for the SpendVeto Governance API (/v1): reserve-then-settle spend control.

Stdlib only. Every refusal raises, so a blocked spend can never be mistaken for an allowed one:

    from spendveto import Governance, SpendVetoDenialError, SpendVetoUnavailableError, usd_to_micros

    gov = Governance("http://localhost:8405/v1", api_key="svk_...")
    try:
        with gov.governed("agent:qa", usd_to_micros("0.40"), model="claude-sonnet-4-6") as spend:
            response = call_the_model()                 # only runs if authorized
            spend.settle(actual_cost_micros(response))  # unsettled holds are kept and expire
    except SpendVetoDenialError as e:
        print(e.code, e.suggestion)                     # e.g. budget_cap + what to do instead
    except SpendVetoUnavailableError:
        ...                                             # governance down: do NOT spend (or use your own fallback)

Money is integer micro-USD (1 USD = 1_000_000). Never pass floats.
"""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal, ROUND_HALF_UP

from . import SpendVetoDenialError

__all__ = [
    "Governance",
    "GovernedSpend",
    "SpendVetoError",
    "SpendVetoUnavailableError",
    "SpendVetoApprovalRequired",
    "usd_to_micros",
]


class SpendVetoError(Exception):
    """A request the Governance API rejected (validation, unknown budget, conflict, ...)."""

    def __init__(self, status, code, message, body=None):
        super().__init__("spendveto %s [%s]: %s" % (status, code, message))
        self.status, self.code, self.message, self.body = status, code, message, body or {}


class SpendVetoUnavailableError(SpendVetoError):
    """Governance could not answer (network failure, timeout, 503). Treat it as a refusal."""


class SpendVetoApprovalRequired(Exception):
    """Raised by governed() when the spend needs a human and wait_for_approval is off."""

    def __init__(self, decision):
        super().__init__("spend needs human approval (approval_id=%s)" % decision.get("approval_id"))
        self.decision = decision
        self.approval_id = decision.get("approval_id")
        self.reservation_id = decision.get("reservation_id")


def usd_to_micros(amount):
    """Converts a USD amount (str, int or Decimal) to integer micro-USD, rounding half up.

    Pass strings or Decimals for exact results; a float is accepted but converted via str()."""
    if isinstance(amount, float):
        amount = str(amount)
    return int((Decimal(amount) * 1000000).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


class Governance:
    def __init__(self, base_url=None, api_key=None, timeout=10.0):
        self.base_url = (base_url or os.environ.get("SPENDVETO_GOVERN_URL") or "http://localhost:8405/v1").rstrip("/")
        self.api_key = api_key or os.environ.get("SPENDVETO_API_KEY")
        self.timeout = timeout

    # ------------------------------------------------------------------ transport
    def _call(self, method, path, body=None, query=None, headers=None):
        url = self.base_url + path
        if query:
            clean = {k: v for k, v in query.items() if v is not None}
            if clean:
                url += "?" + urllib.parse.urlencode(clean)
        h = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.api_key:
            h["Authorization"] = "Bearer " + self.api_key
        h.update(headers or {})
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data, h, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                payload = json.loads(e.read() or b"{}")
            except Exception:
                payload = {}
            return e.code, payload
        except (urllib.error.URLError, OSError) as e:  # refused, DNS, timeout
            raise SpendVetoUnavailableError(0, "governance_unavailable", str(e))

    @staticmethod
    def _check(status, body, ok=(200, 201)):
        if status in ok:
            return body
        code = body.get("code") or "error"
        msg = body.get("error") or body.get("reason") or "HTTP %s" % status
        if status == 503 or status >= 500:
            raise SpendVetoUnavailableError(status, code, msg, body)
        raise SpendVetoError(status, code, msg, body)

    # ------------------------------------------------------------------ spend
    def authorize(self, budget, estimate_micros, idempotency_key=None, operation=None, provider=None,
                  model=None, metadata=None, ttl_seconds=None, approval_ttl_seconds=None):
        """Reserve the worst-case cost. Returns the decision dict when it is "allow" or
        "needs_approval"; raises SpendVetoDenialError when refused."""
        if not isinstance(estimate_micros, int) or isinstance(estimate_micros, bool):
            raise TypeError("estimate_micros must be an int (micro-USD); use usd_to_micros()")
        body = {"budget": budget, "estimate_micros": estimate_micros}
        for k, v in (("idempotency_key", idempotency_key), ("operation", operation), ("provider", provider),
                     ("model", model), ("metadata", metadata), ("ttl_seconds", ttl_seconds),
                     ("approval_ttl_seconds", approval_ttl_seconds)):
            if v is not None:
                body[k] = v
        status, data = self._call("POST", "/authorize", body)
        if status == 403 and data.get("decision") == "deny":
            err = SpendVetoDenialError(data.get("reason"), data.get("code"), data.get("suggestion"), "govern")
            err.budget = data.get("budget")
            err.reservation_id = data.get("reservation_id")
            raise err
        return self._check(status, data, ok=(201, 202))

    def settle(self, reservation_id, actual_micros, input_tokens=None, output_tokens=None, metadata=None):
        if not isinstance(actual_micros, int) or isinstance(actual_micros, bool):
            raise TypeError("actual_micros must be an int (micro-USD)")
        body = {"actual_micros": actual_micros}
        if input_tokens is not None:
            body["input_tokens"] = input_tokens
        if output_tokens is not None:
            body["output_tokens"] = output_tokens
        if metadata is not None:
            body["metadata"] = metadata
        return self._check(*self._call("POST", "/reservations/%s/settle" % reservation_id, body))

    def void(self, reservation_id):
        return self._check(*self._call("POST", "/reservations/%s/void" % reservation_id, {}))

    def reservation(self, reservation_id):
        return self._check(*self._call("GET", "/reservations/%s" % reservation_id))

    # ------------------------------------------------------------------ approvals
    def approval(self, approval_id):
        return self._check(*self._call("GET", "/approvals/%s" % approval_id))["approval"]

    def pending_approvals(self, limit=100):
        return self._check(*self._call("GET", "/approvals", query={"status": "pending", "limit": limit}))["approvals"]

    def decide(self, approval_id, decision, actor=None, reason=None):
        """decision is "approve" or "deny". Needs a key with the approve scope."""
        body = {"decision": decision}
        if actor:
            body["actor"] = actor
        if reason:
            body["reason"] = reason
        return self._check(*self._call("POST", "/approvals/%s/decide" % approval_id, body))["approval"]

    def wait_for_approval(self, approval_id, timeout_seconds, poll_seconds=2.0):
        """Polls until the approval leaves "pending" or the timeout passes. Returns the final status."""
        deadline = time.monotonic() + timeout_seconds
        while True:
            status = self.approval(approval_id)["status"]
            if status != "pending" or time.monotonic() >= deadline:
                return status
            time.sleep(poll_seconds)

    # ------------------------------------------------------------------ budgets
    def upsert_budget(self, budget, **fields):
        """Fields you omit keep their stored value; pass None to clear one."""
        return self._check(*self._call("PUT", "/budgets/%s" % urllib.parse.quote(budget, safe=""), fields))["budget"]

    def sync_budgets(self, budgets):
        """budgets: list of dicts, each with a "budget" key plus fields. One transaction."""
        return self._check(*self._call("POST", "/budgets/sync", {"budgets": budgets}))

    def budget(self, budget):
        return self._check(*self._call("GET", "/budgets/%s" % urllib.parse.quote(budget, safe="")))["budget"]

    def archive_budget(self, budget):
        return self._check(*self._call("DELETE", "/budgets/%s" % urllib.parse.quote(budget, safe="")))["budget"]

    def freeze(self, budget, reason=None):
        body = {"reason": reason} if reason else {}
        return self._check(*self._call("POST", "/budgets/%s/freeze" % urllib.parse.quote(budget, safe=""), body))["budget"]

    def unfreeze(self, budget):
        return self._check(*self._call("POST", "/budgets/%s/unfreeze" % urllib.parse.quote(budget, safe=""), {}))["budget"]

    # ------------------------------------------------------------------ reports
    def usage(self, start=None, end=None, budget=None, include_descendants=False, group_by="budget"):
        query = {"from": start, "to": end, "budget": budget, "group_by": group_by,
                 "include_descendants": "true" if include_descendants else None}
        return self._check(*self._call("GET", "/usage", query=query))

    def verify_audit(self):
        return self._check(*self._call("GET", "/events/verify"))

    def health(self):
        try:
            status, data = self._call("GET", "/health")
        except SpendVetoUnavailableError:
            return False
        return status == 200 and data.get("ok") is True

    # ------------------------------------------------------------------ convenience
    def governed(self, budget, estimate_micros, wait_for_approval=None, **kwargs):
        """Context manager: authorize on enter; inside the block, call settle() with the actual cost,
        or void() if you know nothing was spent.

        If the block exits without either (including on an exception), the reservation is LEFT HELD
        and expires on its own: the client cannot know whether the provider call already spent the
        money, so it errs toward counting it. A late settle() is still accepted after expiry.

        If the spend needs a human, either raise SpendVetoApprovalRequired (default) or, with
        wait_for_approval=<seconds>, block until a decision; anything but "approved" raises
        SpendVetoDenialError (the spend fails closed)."""
        return GovernedSpend(self, budget, estimate_micros, wait_for_approval, kwargs)


class GovernedSpend:
    SETTLE_ATTEMPTS = 3

    def __init__(self, gov, budget, estimate_micros, wait_seconds, kwargs):
        self._gov, self._budget, self._estimate, self._wait, self._kwargs = gov, budget, estimate_micros, wait_seconds, kwargs
        self.decision = None
        self.reservation_id = None
        self.settled = None
        self.voided = False

    def __enter__(self):
        d = self._gov.authorize(self._budget, self._estimate, **self._kwargs)
        self.decision = d
        self.reservation_id = d["reservation_id"]
        if d["decision"] == "needs_approval" and d.get("status") != "held":
            if not self._wait:
                raise SpendVetoApprovalRequired(d)
            outcome = self._gov.wait_for_approval(d["approval_id"], self._wait)
            if outcome != "approved":
                if outcome == "pending":
                    self._gov.void(self.reservation_id)
                raise SpendVetoDenialError("approval %s" % outcome, "approval_%s" % outcome,
                                           "do not proceed; a human did not approve this spend", "approval")
        # Belt and braces: only ever run the body against a live hold.
        current = self._gov.reservation(self.reservation_id)["status"]
        if current != "held":
            raise SpendVetoDenialError("reservation is %s, not held" % current, "reservation_%s" % current,
                                       "do not proceed; request a new reservation", "govern")
        return self

    def settle(self, actual_micros, **kwargs):
        """Books the actual cost. Retried on transient failures; settle is idempotent server-side."""
        for attempt in range(self.SETTLE_ATTEMPTS):
            try:
                self.settled = self._gov.settle(self.reservation_id, actual_micros, **kwargs)
                return self.settled
            except SpendVetoUnavailableError:
                if attempt == self.SETTLE_ATTEMPTS - 1:
                    raise  # the hold stays in place and expires; a late settle is still accepted
                time.sleep(0.5 * (attempt + 1))

    def void(self):
        """Releases the hold. Only call this when you KNOW nothing was spent."""
        self._gov.void(self.reservation_id)
        self.voided = True

    def __exit__(self, exc_type, exc, tb):
        return False  # never void implicitly, never swallow the caller's exception
