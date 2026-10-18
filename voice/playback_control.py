"""Playback admission follows observed Companion turns, not assumed cancel RPCs."""
from collections import OrderedDict


class PlaybackControl:
    def __init__(self):
        self.revision = 0
        self.blocked = False
        self.user_confirmed = False
        self.user_active = False
        self._assistant_turns = OrderedDict()

    def block(self, *, user_confirmed=False):
        self.revision += 1
        self.blocked = True
        self.user_confirmed = bool(user_confirmed or self.user_active)
        return self.revision

    def user_started(self):
        self.user_active = True
        if self.blocked:
            self.user_confirmed = True

    def user_done(self):
        self.user_active = False

    def assistant_started(self, turn_id):
        fresh = turn_id not in self._assistant_turns
        self._assistant_turns[turn_id] = True
        while len(self._assistant_turns) > 512:
            self._assistant_turns.popitem(last=False)
        if self.blocked and self.user_confirmed and fresh:
            self.revision += 1
            self.blocked = False
            self.user_confirmed = False
            return self.revision
        return None
