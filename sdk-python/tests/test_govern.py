"""End-to-end tests for spendveto.Governance against a live Governance API.

Run by govern/tests/python-sdk.test.mjs, which starts a server on a disposable database and passes
SPENDVETO_GOVERN_URL plus one key per scope through the environment. Stdlib unittest only.
"""
import os
import sys
import threading
import time
import unittest
import uuid
from decimal import Decimal

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from spendveto import (  # noqa: E402
    Governance, SpendVetoDenialError, SpendVetoError, SpendVetoUnavailableError, SpendVetoApprovalRequired, usd_to_micros,
)

URL = os.environ.get("SPENDVETO_GOVERN_URL")


def gov(scope):
    return Governance(URL, api_key=os.environ["SV_KEY_" + scope.upper()])


@unittest.skipUnless(URL, "SPENDVETO_GOVERN_URL not set (run via npm run test:govern)")
class GovernanceSdkTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spend, cls.manage, cls.read, cls.approve = gov("spend"), gov("manage"), gov("read"), gov("approve")
        cls.approve_as = gov("approve_as")
        cls.prefix = "py-" + uuid.uuid4().hex[:8]
        cls.manage.sync_budgets([
            {"budget": cls.prefix + "-org", "cap_micros": usd_to_micros("40"), "approval_above_micros": usd_to_micros("5")},
            {"budget": cls.prefix + "-agent", "parent": cls.prefix + "-org"},
        ])
        cls.agent = cls.prefix + "-agent"

    def test_usd_to_micros_is_exact(self):
        self.assertEqual(usd_to_micros("0.000001"), 1)
        self.assertEqual(usd_to_micros("1.10"), 1100000)
        self.assertEqual(usd_to_micros(Decimal("19.99")), 19990000)
        self.assertEqual(usd_to_micros(0.1), 100000)
        self.assertEqual(usd_to_micros(3), 3000000)

    def test_floats_are_rejected_for_money(self):
        with self.assertRaises(TypeError):
            self.spend.authorize(self.agent, 1.5)

    def test_authorize_settle_roundtrip(self):
        d = self.spend.authorize(self.agent, usd_to_micros("1"), model="m", provider="p", operation="llm.chat",
                                 metadata={"run_id": "r1"})
        self.assertEqual(d["decision"], "allow")
        s = self.spend.settle(d["reservation_id"], usd_to_micros("0.25"), input_tokens=100, output_tokens=20)
        self.assertEqual(s["status"], "settled")
        self.assertEqual(s["actual_micros"], 250000)
        self.assertEqual(self.read.reservation(d["reservation_id"])["status"], "settled")

    def test_denial_raises_with_code_and_suggestion(self):
        with self.assertRaises(SpendVetoDenialError) as ctx:
            self.spend.authorize(self.agent, usd_to_micros("500"))
        self.assertEqual(ctx.exception.code, "budget_cap")
        self.assertTrue(ctx.exception.suggestion)
        self.assertEqual(ctx.exception.budget, self.prefix + "-org")

    def test_context_manager_settles_or_keeps_the_hold(self):
        before = self.read.budget(self.agent)["usage"]["reserved_micros"]
        with self.spend.governed(self.agent, usd_to_micros("1")) as spend:
            spend.settle(usd_to_micros("0.5"))
        self.assertEqual(spend.settled["status"], "settled")
        # An exception after the block started: the client cannot know whether the provider
        # already charged, so the hold is KEPT (counted) rather than released.
        with self.assertRaises(RuntimeError):
            with self.spend.governed(self.agent, usd_to_micros("1")) as failed:
                raise RuntimeError("the model call blew up")
        self.assertEqual(self.read.reservation(failed.reservation_id)["status"], "held")
        # A late settle of what was really spent still works...
        self.assertEqual(self.spend.settle(failed.reservation_id, usd_to_micros("0.2"))["status"], "settled")
        # ...and void() is the explicit "nothing was spent" path.
        with self.spend.governed(self.agent, usd_to_micros("1")) as unused:
            unused.void()
        self.assertEqual(self.read.reservation(unused.reservation_id)["status"], "voided")
        self.assertEqual(self.read.budget(self.agent)["usage"]["reserved_micros"], before)

    def test_approval_flow(self):
        with self.assertRaises(SpendVetoApprovalRequired) as ctx:
            with self.spend.governed(self.agent, usd_to_micros("6")):
                self.fail("must not run before approval")
        approval_id = ctx.exception.approval_id
        self.assertIn(approval_id, [a["approval_id"] for a in self.approve.pending_approvals()])
        with self.assertRaises(SpendVetoError) as forbidden:
            self.spend.decide(approval_id, "approve")
        self.assertEqual(forbidden.exception.status, 403)
        with self.assertRaises(SpendVetoError) as spoof:
            self.approve.decide(approval_id, "approve", actor="user:someone")
        self.assertEqual(spoof.exception.code, "actor_not_allowed")
        self.assertEqual(self.approve.decide(approval_id, "approve")["status"], "approved")
        self.assertEqual(self.spend.wait_for_approval(approval_id, 1), "approved")
        self.assertEqual(self.spend.settle(ctx.exception.reservation_id, usd_to_micros("5.5"))["status"], "settled")

    def test_approve_as_records_the_named_human(self):
        d = self.spend.authorize(self.agent, usd_to_micros("6"))
        approval = self.approve_as.decide(d["approval_id"], "approve", actor="user:harshil")
        self.assertEqual(approval["status"], "approved")
        self.assertEqual(approval["approvers"][0]["actor"], "user:harshil")
        self.spend.void(d["reservation_id"])

    def test_denied_approval_fails_closed_in_context_manager(self):
        def deny_when_pending():
            for _ in range(100):
                pending = [a for a in self.approve.pending_approvals() if a["budget"] == self.agent]
                if pending:
                    self.approve_as.decide(pending[0]["approval_id"], "deny", actor="user:test", reason="too big")
                    return
                time.sleep(0.1)

        approver = threading.Thread(target=deny_when_pending)
        approver.start()
        ran = []
        with self.assertRaises(SpendVetoDenialError) as ctx:
            with self.spend.governed(self.agent, usd_to_micros("6"), wait_for_approval=15):
                ran.append(True)
        approver.join()
        self.assertEqual(ran, [], "the body must never run when the approver said no")
        self.assertEqual(ctx.exception.code, "approval_denied")

    def test_idempotency_key(self):
        a = self.spend.authorize(self.agent, 1000, idempotency_key=self.prefix + "-k")
        b = self.spend.authorize(self.agent, 1000, idempotency_key=self.prefix + "-k")
        self.assertEqual(a["reservation_id"], b["reservation_id"])
        self.assertTrue(b["replayed"])
        with self.assertRaises(SpendVetoError) as ctx:
            self.spend.authorize(self.agent, 2000, idempotency_key=self.prefix + "-k")
        self.assertEqual(ctx.exception.code, "idempotency_conflict")

    def test_freeze_and_usage(self):
        self.manage.freeze(self.prefix + "-org", reason="sdk test")
        with self.assertRaises(SpendVetoDenialError) as ctx:
            self.spend.authorize(self.agent, 1)
        self.assertEqual(ctx.exception.code, "budget_frozen")
        self.manage.unfreeze(self.prefix + "-org")
        report = self.read.usage(budget=self.prefix + "-org", include_descendants=True, group_by="budget")
        self.assertGreaterEqual(report["total_spent_micros"], 250000)
        self.assertTrue(self.read.verify_audit()["valid"])

    def test_unknown_budget_is_an_error_not_a_denial(self):
        with self.assertRaises(SpendVetoError) as ctx:
            self.spend.authorize("no-such-budget-" + self.prefix, 1)
        self.assertEqual(ctx.exception.status, 404)
        self.assertEqual(ctx.exception.code, "unknown_budget")

    def test_unreachable_server_raises_unavailable(self):
        dead = Governance("http://127.0.0.1:1/v1", api_key="svk_x", timeout=2)
        with self.assertRaises(SpendVetoUnavailableError):
            dead.authorize("x", 1)
        self.assertFalse(dead.health())
        self.assertTrue(self.spend.health())


if __name__ == "__main__":
    unittest.main()
