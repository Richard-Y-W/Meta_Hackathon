"""Clock profiles for the coupled town (P11). Simulated time is integer microseconds.

real_time_hybrid      simulation runs 1:1 with wall time; packet (Mininet) communications are allowed.
accelerated_modeled   simulation runs `acceleration` times faster than wall time; communications must be
                      the labeled modeled adapter, because real packets cannot be accelerated.

Decision latency is charged, never hidden: a result whose computation took `wall_seconds` becomes available
`wall_seconds * acceleration` simulated seconds after it was requested. The world keeps advancing meanwhile.
"""
from protocol import Rejected

S = 1000000
MODES = ('real_time_hybrid', 'accelerated_modeled')


class ClockMapping:
    def __init__(self, mode, acceleration=1.0, communications='modeled'):
        if mode not in MODES:
            raise Rejected('unknown_clock_mode', str(mode))
        if mode == 'real_time_hybrid' and acceleration != 1.0:
            raise Rejected('invalid_clock_mapping', 'real-time hybrid runs at 1x')
        if mode == 'accelerated_modeled' and not acceleration > 1.0:
            raise Rejected('invalid_clock_mapping', 'accelerated mode needs acceleration > 1')
        if mode == 'accelerated_modeled' and communications != 'modeled':
            raise Rejected('invalid_clock_mapping', 'packet communications cannot be accelerated')
        self.mode, self.acceleration, self.communications = mode, float(acceleration), communications

    def manifest(self):
        return {'mode': self.mode, 'acceleration': self.acceleration, 'communications': self.communications,
                'rule': 'latency_sim_us = wall_seconds * acceleration * 1e6; no pauses'}

    def available_at(self, requested_sim_us, wall_seconds):
        """Earliest simulated time a result computed in `wall_seconds` may take effect."""
        if wall_seconds < 0:
            raise Rejected('invalid_latency', str(wall_seconds))
        return requested_sim_us + int(round(wall_seconds * self.acceleration * S))

    def wall_seconds_for(self, sim_us):
        return sim_us / S / self.acceleration


class PendingDecisions:
    """Results waiting for their charged latency. The simulation advances regardless; due results are
    released in availability order. Nothing here can pause the world."""

    def __init__(self, clock):
        self.clock, self.items = clock, []

    def submit(self, requested_sim_us, wall_seconds, payload):
        item = {'requestedUs': requested_sim_us, 'availableUs': self.clock.available_at(requested_sim_us, wall_seconds), 'wallSeconds': wall_seconds, 'payload': payload}
        self.items.append(item)
        return item

    def due(self, now_us):
        ready = sorted([i for i in self.items if i['availableUs'] <= now_us], key=lambda i: (i['availableUs'], i['requestedUs']))
        self.items = [i for i in self.items if i['availableUs'] > now_us]
        return ready
