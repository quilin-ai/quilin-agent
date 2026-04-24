from __future__ import annotations

from collections.abc import Iterable

from .profile_store import ProfileAuditEntry, ProfileSignal, ProfileStore


class ProfileUpdater:
    """Single durable write entrypoint for UserProfile changes."""

    def __init__(self, store: ProfileStore) -> None:
        self._store = store

    def apply_signal(
        self,
        signal: ProfileSignal,
        *,
        who: str,
        why: str,
    ) -> ProfileAuditEntry:
        return self._store._apply_signal(signal, who=who, why=why)

    def bulk_apply(
        self,
        signals: Iterable[ProfileSignal],
        *,
        who: str,
        why: str,
    ) -> list[ProfileAuditEntry]:
        return [self.apply_signal(signal, who=who, why=why) for signal in signals]

    def reset(self) -> None:
        self._store._reset()
