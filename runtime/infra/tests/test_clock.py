"""P11 clock profiles: charged decision latency, no hidden pauses. Run:
python3 -m unittest discover -s runtime/infra/tests -p test_clock.py"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from clock import ClockMapping, PendingDecisions  # noqa: E402
from protocol import Rejected  # noqa: E402

S = 1000000


class ClockTests(unittest.TestCase):
    def test_a_15_second_provider_delay_at_60x_costs_900_simulated_seconds(self):
        clock = ClockMapping('accelerated_modeled', acceleration=60)
        self.assertEqual(clock.available_at(100 * S, 15.0), 1000 * S)
        self.assertEqual(ClockMapping('real_time_hybrid').available_at(100 * S, 15.0), 115 * S)

    def test_profiles_are_distinct_and_packets_cannot_be_accelerated(self):
        invalid = [('real_time_hybrid', {'acceleration': 10}), ('accelerated_modeled', {'acceleration': 1}),
                   ('accelerated_modeled', {'acceleration': 60, 'communications': 'packet'})]
        for mode, kwargs in invalid:
            with self.assertRaises(Rejected):
                ClockMapping(mode, **kwargs)
        self.assertEqual(ClockMapping('real_time_hybrid', communications='packet').manifest()['acceleration'], 1.0)

    def test_pending_decisions_never_release_early_and_never_pause_the_world(self):
        pending = PendingDecisions(ClockMapping('accelerated_modeled', acceleration=60))
        pending.submit(0, 15.0, 'plan-a')     # available at 900 s
        pending.submit(60 * S, 1.0, 'plan-b')  # available at 120 s
        released, now = [], 0
        while now <= 1200 * S:                 # the world steps every 60 s whatever is pending
            released += [(now, i['payload']) for i in pending.due(now)]
            now += 60 * S
        self.assertEqual(released, [(120 * S, 'plan-b'), (900 * S, 'plan-a')])
        with self.assertRaises(Rejected):
            pending.submit(0, -1.0, 'x')


if __name__ == '__main__':
    unittest.main()
